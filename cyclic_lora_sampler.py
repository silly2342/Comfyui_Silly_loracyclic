import comfy.sd
import comfy.utils
import comfy.samplers
import folder_paths
from nodes import common_ksampler
import math

# ──────────────────────────────────────────────────────────────────────────────
# Strength Curve Helper
#
# Interpolates between strength_start and strength_end using the curve shape.
# progress: 0.0 = start of active window, 1.0 = end of active window
#
# The curve controls the *shape* of the interpolation, not a multiplier:
#   ease_in  from 0.2→1.0 : starts slow near 0.2, accelerates to 1.0
#   ease_out from 1.0→0.2 : starts fast near 1.0, decelerates to 0.2
#   bell     from 0.0→0.0 : peaks at midpoint (uses strength_end as the peak)
# ──────────────────────────────────────────────────────────────────────────────

CURVE_OPTIONS = ["constant", "linear", "ease_in", "ease_out", "ease_in_out", "bell"]

def apply_curve(strength_start, strength_mid, strength_end, progress, curve):
    """
    Three-point interpolation across the active window.
    progress 0.0→0.5 : interpolates start → mid
    progress 0.5→1.0 : interpolates mid  → end
    The curve shapes both segments identically.
    """
    if progress <= 0.5:
        # Remap 0→0.5 to local 0→1 for first segment
        t_raw = progress * 2.0
        a, b  = strength_start, strength_mid
    else:
        # Remap 0.5→1.0 to local 0→1 for second segment
        t_raw = (progress - 0.5) * 2.0
        a, b  = strength_mid, strength_end

    if curve == "constant":
        t = 1.0
    elif curve == "linear":
        t = t_raw
    elif curve == "ease_in":
        t = t_raw ** 2
    elif curve == "ease_out":
        t = 1.0 - (1.0 - t_raw) ** 2
    elif curve == "ease_in_out":
        t = 0.5 - math.cos(t_raw * math.pi) / 2.0
    elif curve == "bell":
        # Bell shapes each half-segment as a sine arc
        t = math.sin(t_raw * math.pi / 2.0)
    else:
        t = t_raw

    return a + (b - a) * t


# ──────────────────────────────────────────────────────────────────────────────
# Custom Curve Evaluator
# Evaluates a list of {x, y} control points (from the JS curve widget)
# using Catmull-Rom spline interpolation.
# x = progress 0-1, y = strength 0-2
# ──────────────────────────────────────────────────────────────────────────────

def _catmull_rom(p0, p1, p2, p3, t):
    t2, t3 = t*t, t*t*t
    return 0.5 * ((2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t2 + (-p0+3*p1-3*p2+p3)*t3)

def eval_custom_curve(points, x):
    """Evaluate a custom curve (list of {x,y} dicts) at position x (0-1)."""
    if not points:
        return 1.0
    sorted_pts = sorted(points, key=lambda p: p["x"])
    if x <= sorted_pts[0]["x"]:
        return sorted_pts[0]["y"]
    if x >= sorted_pts[-1]["x"]:
        return sorted_pts[-1]["y"]
    i = 1
    while i < len(sorted_pts) - 1 and sorted_pts[i]["x"] < x:
        i += 1
    p1, p2 = sorted_pts[i-1], sorted_pts[i]
    t  = (x - p1["x"]) / max(p2["x"] - p1["x"], 1e-6)
    p0 = sorted_pts[max(0, i-2)]
    p3 = sorted_pts[min(len(sorted_pts)-1, i+1)]
    val = _catmull_rom(p0["y"], p1["y"], p2["y"], p3["y"], t)
    return max(0.0, min(2.0, val))


# ──────────────────────────────────────────────────────────────────────────────
# Node 1: Cyclic Model Builder
# ──────────────────────────────────────────────────────────────────────────────

class CyclicModelBuilder:
    @classmethod
    def INPUT_TYPES(cls):
        lora_list = ["None"] + folder_paths.get_filename_list("loras")
        return {
            "required": {
                "model":            ("MODEL",),
                "clip":             ("CLIP",),
                "lora_name":        (lora_list,),
                "start_time":       ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Progress point (0.0-1.0) when this slot becomes active. 0.0 = from the first step."}),
                "active_until":     ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Progress point (0.0-1.0) when this slot stops being active. 1.0 = until the last step."}),
                # ON  → participates in round-robin cycle, sigma repeats N times
                # OFF → runs every step in its active window, sigma runs normally
                "alternate":        ("BOOLEAN", {"default": True}),
                # How many consecutive steps this slot runs per sigma level
                # before the cycle moves to the next slot. Only applies when alternate=ON.
                # e.g. repeat=3, repeat_start=0.25 → runs once per turn until 25% progress,
                # then switches to 3 steps per turn for the remainder.
                "repeat":           ("INT",   {"default": 1,   "min": 0,   "max": 10,  "step": 1,   "tooltip": "How many consecutive steps this slot runs per turn in the alternating cycle. e.g. repeat=3 means A A A B per cycle."}),
                "repeat_start":     ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Progress threshold before which repeat is forced to 1. e.g. repeat=3, repeat_start=0.25 means single-step turns until 25%, then 3-step turns."}),
                # When this slot transitions from alternating → always-on.
                # 1.0 = stays alternating the whole run (default)
                # 0.5 = alternates for first 50%, then merges to always-on for the rest
                # 0.0 = always-on from the start (same as alternate=OFF)
                "transition_at":    ("FLOAT",   {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Progress point where this slot switches from alternating to always-on. 1.0 = stays alternating the whole run. 0.5 = alternates for first half then runs every step."}),
                # When chaining two KSamplers, resume_strength=True continues
                # strength from where the previous sampler ended.
                # Set False to restart the curve from the beginning on this slot.
                "resume_strength":  ("BOOLEAN", {"default": True, "tooltip": "When chaining two KSamplers, True = continue strength from where the first sampler ended. False = restart the strength curve from strength_start."}),
            },
            "optional": {
                "chain_in":        ("STEP_CHAIN",),
                # Custom curve widget — serialised JSON from the JS curve editor.
                # When provided, overrides strength_start/mid/end for this slot.
                "strength_curve":  ("STRING", {"default": ""}),

            }
        }

    RETURN_TYPES  = ("STEP_CHAIN", "CLIP", "SLOT_REF")
    RETURN_NAMES  = ("chain_out",  "clip", "slot_ref")
    FUNCTION      = "add_to_cycle"
    CATEGORY      = "sampling/cyclic"
    DESCRIPTION   = (
        "Adds a LoRA slot to the cyclic sampling chain.\n\n"
        "Each builder node represents one LoRA that participates in the cycle. "
        "Chain multiple builders together via chain_in → chain_out to build up your slot list.\n\n"
        "OUTPUTS\n"
        "  chain_out  → connect to the next builder's chain_in, or to the KSampler's step_chain\n"
        "  clip       → connect to your text encoder\n"
        "  slot_ref   → connect to the paired Conditioning Selector so it knows which LoRA it belongs to\n\n"
        "STRENGTH CURVE\n"
        "  strength_start / mid / end define a three-point curve across the slot's active window.\n"
        "  curve controls the shape: linear, ease_in, ease_out, ease_in_out, bell, constant.\n\n"
        "TIMING\n"
        "  start_time / active_until: fraction of total steps (0.0–1.0) this slot is active.\n\n"
        "ALTERNATING\n"
        "  alternate ON  → slot takes turns with other alternating slots.\n"
        "  alternate OFF → slot runs every step in its active window (always-on).\n"
        "  repeat        → how many consecutive steps this slot holds per turn.\n"
        "  repeat_start  → progress threshold before repeat kicks in (before it, repeat=1).\n"
        "  transition_at → progress point where this slot switches from alternating to always-on.\n\n"
        "CHAINING\n"
        "  resume_strength → when chaining two KSamplers, continue strength from where first ended."
    )

    def add_to_cycle(self, model, clip, lora_name,
                     start_time, active_until, alternate=True, repeat=1,
                     repeat_start=0.0, transition_at=1.0, resume_strength=True, chain_in=None,
                     strength_curve=None, **kwargs):
        # Stacked LoRAs 2-5 come in via kwargs (not declared in INPUT_TYPES)
        lora_name_2 = kwargs.get("lora_name_2", None)
        lora_name_3 = kwargs.get("lora_name_3", None)
        lora_name_4 = kwargs.get("lora_name_4", None)
        lora_name_5 = kwargs.get("lora_name_5", None)
        strength_curve_2 = kwargs.get("strength_curve_2", "")
        strength_curve_3 = kwargs.get("strength_curve_3", "")
        strength_curve_4 = kwargs.get("strength_curve_4", "")
        strength_curve_5 = kwargs.get("strength_curve_5", "")
        # strength_start/mid/end/curve are now handled by the JS curve widget
        # Use flat defaults for backward compat if strength_curve not provided
        strength_start = 1.0
        strength_mid   = 1.0
        strength_end   = 1.0
        curve          = "constant"
        # Parse strength_curve from JSON string if provided
        import json as _json
        if isinstance(strength_curve, str) and strength_curve.strip():
            try:
                strength_curve = _json.loads(strength_curve)
            except Exception:
                strength_curve = None
        elif not isinstance(strength_curve, list):
            strength_curve = None

        clip_out   = clip
        lora_stack = []  # list of (lora_dict, str_start, str_mid, str_end, name)

        # Collect all LoRA slots — primary + any stacked ones
        import json as _json
        def _parse_curve(curve_str):
            """Parse JSON curve string from JS widget, fall back to None."""
            if not curve_str:
                return None
            try:
                return _json.loads(curve_str)
            except Exception:
                return None

        all_loras = [
            (lora_name,   strength_curve),
            (lora_name_2, _parse_curve(strength_curve_2)),
            (lora_name_3, _parse_curve(strength_curve_3)),
            (lora_name_4, _parse_curve(strength_curve_4)),
            (lora_name_5, _parse_curve(strength_curve_5)),
        ]

        for (name, slot_curve) in all_loras:
            if not name or name == "None":
                continue
            lora_path = folder_paths.get_full_path("loras", name)
            if not lora_path:
                print(f"[CyclicBuilder] WARNING: LoRA not found: {name}")
                continue
            lora_dict = comfy.utils.load_torch_file(lora_path)
            _, clip_out = comfy.sd.load_lora_for_models(model, clip_out, lora_dict, 1.0, 1.0)
            # Store (lora_dict, curve_points, name) — strength evaluated per-step from curve
            lora_stack.append((lora_dict, slot_curve, name))
            print(f"[CyclicBuilder] Loaded: {name}  window={start_time:.2f}→{active_until:.2f}  alternate={alternate}")

        display_name = "+".join(e[2] for e in lora_stack) if lora_stack else "base"

        step_data = {
            "base_model":      model,
            "base_clip":       clip,
            "lora_stack":      lora_stack,   # replaces single lora_dict
            "lora_dict":       lora_stack[0][0] if lora_stack else None,  # compat for smart blend
            "strength_start":  strength_start,
            "strength_mid":    strength_mid,
            "strength_end":    strength_end,
            "curve":           curve,
            "strength_curve":  strength_curve,  # custom curve points from JS widget, overrides start/mid/end
            "start_time":      start_time,
            "active_until":    active_until,
            "alternate":       alternate,
            "repeat":          max(1, repeat),
            "repeat_start":    repeat_start,
            "transition_at":   transition_at,
            "resume_strength": resume_strength,
            "lora_name":       display_name,
        }

        new_chain = list(chain_in) if chain_in is not None else []
        new_chain.append(step_data)
        return (new_chain, clip_out, {"lora_name": display_name})


# ──────────────────────────────────────────────────────────────────────────────
# Node 2: Cyclic Conditioning Selector
# Accepts pre-encoded CONDITIONING from any encoder (smZ, standard, etc.)
# and chains them in sync with the model slots.
# ──────────────────────────────────────────────────────────────────────────────

class CyclicCondSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive":  ("CONDITIONING",),
                "negative":  ("CONDITIONING",),
                # Connect slot_ref from the paired Cyclic Model Builder.
                # Carries just the lora_name for pairing identification —
                # completely independent from the LoRA chain_out.
                "slot_ref":  ("SLOT_REF",),
            },
            "optional": {
                "cond_chain_in": ("COND_CHAIN",),
            }
        }

    RETURN_TYPES  = ("COND_CHAIN",)
    RETURN_NAMES  = ("cond_chain_out",)
    FUNCTION      = "add_conditioning"
    CATEGORY      = "sampling/cyclic"
    DESCRIPTION   = (
        "Pairs a positive/negative conditioning with a LoRA slot in the cycle.\n\n"
        "Connect one Conditioning Selector per LoRA slot, chaining them together "
        "via cond_chain_in → cond_chain_out in the same order as your Model Builders.\n\n"
        "INPUTS\n"
        "  positive   → encoded positive prompt for this slot\n"
        "  negative   → encoded negative prompt for this slot\n"
        "  slot_ref   → connect from the paired Model Builder's slot_ref output — "
        "this identifies which LoRA this conditioning belongs to\n"
        "  cond_chain_in → chain from the previous Conditioning Selector\n\n"
        "The order of chained selectors must match the order of chained builders — "
        "slot 0 conditioning pairs with slot 0 LoRA, slot 1 with slot 1, and so on."
    )

    def add_conditioning(self, positive, negative, slot_ref, cond_chain_in=None):
        lora_name = slot_ref.get("lora_name", "") if slot_ref else ""
        new_chain = list(cond_chain_in) if cond_chain_in is not None else []
        new_chain.append({"positive": positive, "negative": negative, "lora_name": lora_name})
        return (new_chain,)


# ──────────────────────────────────────────────────────────────────────────────
# Node 3: Cyclic KSampler
#
# Sigma schedule behaviour:
#   - Alternating slots: sigma repeats (alternating_n) times per level so every
#     slot in the cycle sees the same noise level before advancing.
#   - Always-on slots (alternate=OFF): they claim every step, sigma advances
#     normally (1 step per level). When an always-on slot is active, the sigma
#     counter increments every step regardless of how many alternating slots exist.
# ──────────────────────────────────────────────────────────────────────────────

class CyclicKSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "step_chain":     ("STEP_CHAIN",),
                "latent_image":   ("LATENT",),
                "seed":           ("INT",   {"default": 0,    "min": 0,   "max": 0xffffffffffffffff}),
                "steps":          ("INT",   {"default": 20,   "min": 1,   "max": 10000}),
                # CFG scheduling — three control points across the full run.
                # cfg_start : CFG at step 0   (high noise, structure phase)
                # cfg_mid   : CFG at midpoint (anatomy/blending phase)
                # cfg_end   : CFG at last step (low noise, detail phase)
                # Set all three equal for flat CFG (same as before).
                # Typical anatomy fix: high start (7-9), lower mid/end (5-7)
                "cfg_start":      ("FLOAT", {"default": 8.0,  "min": 0.0, "max": 30.0, "step": 0.1,  "tooltip": "CFG guidance scale at the start (high noise). Higher values = stronger prompt adherence during structure formation."}),
                "cfg_mid":        ("FLOAT", {"default": 8.0,  "min": 0.0, "max": 30.0, "step": 0.1,  "tooltip": "CFG guidance scale at the midpoint. Reducing this helps anatomy and blending between LoRAs."}),
                "cfg_end":        ("FLOAT", {"default": 8.0,  "min": 0.0, "max": 30.0, "step": 0.1,  "tooltip": "CFG guidance scale at the end (low noise). Lower values give cleaner detail without over-sharpening."}),
                "cfg_curve":      (CURVE_OPTIONS, {"default": "linear"}),
                "sampler_name":   (comfy.samplers.KSampler.SAMPLERS,),
                "scheduler":      (comfy.samplers.KSampler.SCHEDULERS,),
                "denoise":        ("FLOAT", {"default": 1.0,  "min": 0.0, "max": 1.0,  "step": 0.01}),
                # Extra steps at the low-noise tail for fine detail / texture
                "refining_steps": ("INT",   {"default": 0,    "min": 0,   "max": 100,  "step": 1,   "tooltip": "Extra low-noise steps appended after the main schedule. Uses the last active slot for fine detail and texture refinement."}),
                # Smart blend — merges alternating slot models together each step
                # instead of hard-switching. High noise (0-25%) = loose 50/50 blend,
                # freeing the image to explore. After 25% shifts weight toward the
                # dominant slot, locking in direction. Only applies to alternating slots.
                "smart_blend":    ("BOOLEAN", {"default": False, "tooltip": "Each alternating slot absorbs a fraction of the other slots LoRA weights. Cross-contribution ramps 0% → 25% over the first 25% of steps, then holds flat. Improves coherence between alternating LoRAs."}),
            },
            "optional": {
                "cond_chain": ("COND_CHAIN",),
                # Master conditioning — combined with every slot's prompt each step.
                "master_positive": ("CONDITIONING",),
                "master_negative": ("CONDITIONING",),
            }
        }

    RETURN_TYPES  = ("LATENT", "STEP_CHAIN", "COND_CHAIN")
    RETURN_NAMES  = ("latent", "step_chain",  "cond_chain")
    FUNCTION      = "sample_cycle"
    CATEGORY      = "sampling/cyclic"
    DESCRIPTION   = (
        "Cyclic KSampler — runs diffusion sampling with per-step LoRA cycling.\n\n"
        "Each step picks the next slot from the interleaved cycle sequence, patches "
        "the model with that slot's LoRA at its current curve strength, and runs one "
        "denoising pass. Always-on slots run every step; alternating slots take turns.\n\n"
        "CFG SCHEDULING\n"
        "  cfg_start / mid / end: CFG value at beginning, midpoint, and end of the run.\n"
        "  Set all three equal for flat CFG. Typical anatomy improvement: "
        "high start (8-10) → lower end (5-7) using ease_in_out curve.\n\n"
        "REFINING STEPS\n"
        "  Extra low-noise steps appended after the main schedule. "
        "Uses the last active slot at full end-strength for fine detail and texture.\n\n"
        "SMART BLEND\n"
        "  When enabled, each alternating slot absorbs a fraction of the other slots' "
        "LoRA weights. Cross-contribution ramps from 0%% at step 0 to 25%% by 25%% progress, "
        "then holds flat. Slots still alternate — each just carries a little of the others "
        "to improve coherence between turns.\n\n"
        "MASTER CONDITIONING\n"
        "  master_positive / master_negative are combined with every slot's conditioning "
        "each step — like a global prompt always present on top of per-slot prompts.\n\n"
        "CHAINING\n"
        "  step_chain and cond_chain outputs pass through to a second KSampler. "
        "Slot strengths are stamped at their final values so the second pass continues "
        "from where the first left off (controlled per-slot by resume_strength)."
    )

    def _combine_cond(self, cond_a, cond_b):
        """Combines two CONDITIONING lists — same as ConditioningCombine node."""
        if cond_a is None:
            return cond_b
        if cond_b is None:
            return cond_a
        return cond_a + cond_b

    def _merge_models(self, model_a, model_b, ratio):
        """Merge two patched models — same as ModelMergeSimple.
        ratio=1.0 → 100% model_a, ratio=0.0 → 100% model_b."""
        m = model_a.clone()
        kp = model_b.get_key_patches("diffusion_model.")
        for k in kp:
            m.add_patches({k: kp[k]}, ratio, 1.0 - ratio)
        return m

    def _is_active(self, slot, progress):
        return slot["start_time"] <= progress <= slot["active_until"]

    def _patch_model(self, slot, strength):
        lora_stack = slot.get("lora_stack") or []
        if not lora_stack or abs(strength) < 1e-6:
            return slot["base_model"]

        # Cache: rebuild only when strength changes by more than 0.001
        cached_str = slot.get("_cached_strength")
        if cached_str is not None and abs(cached_str - strength) < 0.001:
            return slot["_cached_model"]

        # Apply each stacked LoRA in sequence using its own strength curve.
        # Primary LoRA uses slot-level strength (already curve-computed by caller).
        # Stacked LoRAs use their own ss/sm/se evaluated at the same local_progress.
        local_p = slot.get("_current_local_progress", 0.0)
        patched = slot["base_model"]
        for idx, (lora_dict, slot_curve, name) in enumerate(lora_stack):
            if idx == 0:
                # Primary LoRA — strength already computed by caller
                entry_str = strength
            else:
                # Stacked LoRA — use its own curve if present, else use same strength
                if slot_curve:
                    entry_str = eval_custom_curve(slot_curve, local_p)
                else:
                    entry_str = strength
            if abs(entry_str) < 1e-6:
                continue
            patched, _ = comfy.sd.load_lora_for_models(
                patched, slot["base_clip"], lora_dict, entry_str, entry_str
            )

        slot["_cached_strength"] = strength
        slot["_cached_model"]    = patched
        return patched

    def _local_progress(self, slot, progress):
        """Remap global progress to 0→1 within this slot's active window."""
        window = slot["active_until"] - slot["start_time"]
        if window <= 0:
            return 0.0
        return max(0.0, min(1.0, (progress - slot["start_time"]) / window))

    def sample_cycle(self, step_chain, latent_image,
                     seed, steps, cfg_start, cfg_mid, cfg_end, cfg_curve,
                     sampler_name, scheduler,
                     denoise=1.0, refining_steps=0, smart_blend=False,
                     cond_chain=None,
                     master_positive=None, master_negative=None):

        if not step_chain:
            raise ValueError("[CyclicKSampler] step_chain is empty.")

        if cond_chain is None:
            raise ValueError(
                "[CyclicKSampler] No conditioning found. "
                "Connect a Cyclic Conditioning Selector to the cond_chain input."
            )

        if len(cond_chain) != len(step_chain):
            print(f"[CyclicKSampler] WARNING: cond_chain ({len(cond_chain)}) != "
                  f"step_chain ({len(step_chain)}). Extras fall back to last cond entry.")

        n_slots        = len(step_chain)
        current_latent = latent_image

        sigma_sequence = list(range(steps))
        total_main  = len(sigma_sequence)
        total_steps = total_main + refining_steps

        # Helper: build interleaved sequence from current always-on / alt split
        def build_interleaved(ao_idxs, alt_pat):
            seq = []
            if alt_pat:
                for pat_idx in alt_pat:
                    for ao_idx in ao_idxs:
                        seq.append(("always_on", ao_idx))
                    seq.append(("alt", pat_idx))
            else:
                for ao_idx in ao_idxs:
                    seq.append(("always_on", ao_idx))
            return seq if seq else [("alt", 0)]

        def is_alternating(slot, progress):
            """True if slot should be in round-robin at this progress."""
            if not slot.get("alternate", True):
                return False
            return progress < slot.get("transition_at", 1.0)

        seq_pos          = 0
        sigma_level      = 0
        last_mode        = None
        final_strengths  = {}  # slot_idx → last eff_strength computed
        interleaved     = []
        interleaved_len = 1

        for pass_idx, sigma_idx in enumerate(sigma_sequence):
            progress = pass_idx / max(total_steps - 1, 1)

            # Rebuild interleaved sequence if any slot transitions this step
            current_mode = tuple(
                (is_alternating(s, progress),
                 progress >= s.get("repeat_start", 0.0))
                for s in step_chain
            )
            if current_mode != last_mode:
                last_mode      = current_mode
                ao_now         = [i for i, s in enumerate(step_chain)
                                  if not is_alternating(s, progress)]
                alt_now        = [i for i, s in enumerate(step_chain)
                                  if is_alternating(s, progress)]
                alt_pat_now    = []
                for idx in alt_now:
                    # Use full repeat count only after repeat_start threshold
                    effective_repeat = (
                        step_chain[idx].get("repeat", 1)
                        if progress >= step_chain[idx].get("repeat_start", 0.0)
                        else 1
                    )
                    alt_pat_now.extend([idx] * effective_repeat)
                interleaved     = build_interleaved(ao_now, alt_pat_now)
                interleaved_len = len(interleaved)
                seq_pos         = 0
                label = "->".join(
                    step_chain[idx]["lora_name"] + ("(ao)" if t == "always_on" else "")
                    for t, idx in interleaved
                )
                if pass_idx == 0:
                    print(f"[CyclicKSampler] {steps} main + {refining_steps} refining = "
                          f"{total_steps} total | {n_slots} slot(s) | cycle=[{label}]")
                    # Warn about any slots whose repeat will be overridden by transition_at
                    for si, s in enumerate(step_chain):
                        ta = s.get("transition_at", 1.0)
                        rp = s.get("repeat", 1)
                        if ta < 1.0 and rp > 1:
                            print(f"  [NOTE] slot {si} '{s['lora_name']}': repeat={rp} applies until "
                                  f"progress={ta:.2f}, then slot goes always-on (repeat ignored after that)")
                else:
                    print(f"  [TRANSITION] pass {pass_idx+1} progress={progress:.2f} "
                          f"-> new cycle=[{label}]")

            # Pick slot from interleaved sequence, skip inactive slots
            entry_type, slot_idx = interleaved[seq_pos % interleaved_len]
            slot = step_chain[slot_idx]
            for _ in range(interleaved_len):
                if self._is_active(slot, progress):
                    break
                seq_pos += 1
                entry_type, slot_idx = interleaved[seq_pos % interleaved_len]
                slot = step_chain[slot_idx]

            seq_pos += 1
            if seq_pos % interleaved_len == 0:
                sigma_level += 1

            # Strength via curve
            # If a final_strength was injected from a previous sampler,
            # use it directly instead of recomputing the curve.
            if self._is_active(slot, progress):
                lp = self._local_progress(slot, progress)
                if "final_strength" in slot and slot.get("resume_strength", True):
                    eff_strength = slot["final_strength"]
                elif slot.get("strength_curve"):
                    # Custom curve widget — evaluate spline at local progress
                    eff_strength = eval_custom_curve(slot["strength_curve"], lp)
                else:
                    eff_strength = apply_curve(
                        slot["strength_start"], slot["strength_mid"],
                        slot["strength_end"], lp, slot["curve"]
                    )
                slot["_current_local_progress"] = lp
                model_for_step = self._patch_model(slot, eff_strength)
                label          = slot["lora_name"]
            else:
                model_for_step = slot["base_model"]
                eff_strength   = 0.0
                label          = f"{slot['lora_name']}(inactive)"
            final_strengths[slot_idx] = eff_strength

            # Smart blend — each alternating slot gets its own LoRA at full strength
            # PLUS a cross-contribution from each other active slot.
            # Cross fraction ramps linearly from 0% at step 0 → 25% by progress=0.25,
            # then stays flat at 25% for the rest of the run.
            # Slots still alternate — each just carries a little of the others.
            # e.g. step A: A@1.0 + B@0.25*cross_frac
            #      step B: B@1.0 + A@0.25*cross_frac
            if smart_blend and entry_type == "alt":
                active_alt = [
                    (i, s) for i, s in enumerate(step_chain)
                    if is_alternating(s, progress) and self._is_active(s, progress)
                ]
                if len(active_alt) > 1:
                    # Cross fraction: 0 → 0.25 linearly over first 25%, flat after
                    cross_frac = min(progress / 0.25, 1.0) * 0.25

                    if cross_frac > 1e-6:
                        # Use cached own-LoRA model (already computed above)
                        # then add cross-contributions, also cached per cross_str.
                        blended = self._patch_model(slot, eff_strength)
                        # Layer in cross-contribution from each other active slot
                        for i, s in active_alt:
                            if s is slot:
                                continue
                            if "final_strength" in s and s.get("resume_strength", True):
                                other_str = s["final_strength"]
                            else:
                                lp_s = self._local_progress(s, progress)
                                other_str = apply_curve(
                                    s["strength_start"], s["strength_mid"],
                                    s["strength_end"], lp_s, s["curve"]
                                )
                            cross_str = other_str * cross_frac
                            # Cache cross-blend per (slot_idx, other_idx) key
                            cache_key = f"_cross_{slot_idx}_{i}"
                            cached_cross_str = s.get(cache_key + "_str")
                            if cached_cross_str is not None and abs(cached_cross_str - cross_str) < 0.001:
                                blended = s[cache_key + "_model"]
                            elif s["lora_dict"] is not None and abs(cross_str) > 1e-6:
                                blended, _ = comfy.sd.load_lora_for_models(
                                    blended, s["base_clip"],
                                    s["lora_dict"], cross_str, cross_str
                                )
                                s[cache_key + "_str"]   = cross_str
                                s[cache_key + "_model"] = blended
                        model_for_step = blended
                        label = f"{slot['lora_name']}+{cross_frac*100:.0f}%cross"

            # Conditioning
            if slot_idx < len(cond_chain):
                step_positive = cond_chain[slot_idx]["positive"]
                step_negative = cond_chain[slot_idx]["negative"]
                paired        = cond_chain[slot_idx].get("lora_name", "")
                cond_src      = f"cond[{slot_idx}]{(':'+paired) if paired else ''}"
            else:
                step_positive = cond_chain[-1]["positive"]
                step_negative = cond_chain[-1]["negative"]
                paired        = cond_chain[-1].get("lora_name", "")
                cond_src      = f"cond[-1]{(':'+paired) if paired else ''}"

            if step_positive is None or step_negative is None:
                raise ValueError(f"[CyclicKSampler] pass {pass_idx+1}: conditioning is None.")

            # Combine with master conditioning if provided
            if master_positive is not None:
                step_positive = self._combine_cond(step_positive, master_positive)
            if master_negative is not None:
                step_negative = self._combine_cond(step_negative, master_negative)

            # ── CFG for this step ─────────────────────────────────────────────
            step_cfg = apply_curve(cfg_start, cfg_mid, cfg_end, progress, cfg_curve)

            is_first = (pass_idx == 0)
            is_last  = (pass_idx == total_main - 1) and (refining_steps == 0)
            tag      = ""
            alt_flag = "ao" if entry_type == "always_on" else "alt"

            print(f"  pass {pass_idx+1:>3}/{total_main} | sigma={sigma_idx+1}/{total_main} | "
                  f"[{alt_flag}] slot={slot_idx} {label:<25} | "
                  f"{cond_src} | str={eff_strength:.3f} | cfg={step_cfg:.2f} | "
                  f"seq={seq_pos-1}%{interleaved_len}")

            out = common_ksampler(
                model=model_for_step,
                seed=seed,
                steps=total_steps,
                cfg=step_cfg,
                sampler_name=sampler_name,
                scheduler=scheduler,
                positive=step_positive,
                negative=step_negative,
                latent=current_latent,
                denoise=denoise,
                disable_noise=not is_first,
                start_step=sigma_idx,
                last_step=sigma_idx + 1,
                force_full_denoise=is_last,
            )
            current_latent = out[0]

        # Refining steps — continues sigma schedule into lower-noise territory
        if refining_steps > 0:
            ref_slot = next(
                (s for s in reversed(step_chain) if self._is_active(s, 1.0)),
                step_chain[0]
            )
            ref_slot_idx = step_chain.index(ref_slot)
            lp           = self._local_progress(ref_slot, 1.0)
            eff_strength = apply_curve(
                ref_slot["strength_start"], ref_slot["strength_mid"],
                ref_slot["strength_end"], lp, ref_slot["curve"]
            )
            ref_model = self._patch_model(ref_slot, eff_strength)
            ref_pos   = cond_chain[ref_slot_idx]["positive"] if ref_slot_idx < len(cond_chain) else cond_chain[-1]["positive"]
            ref_neg   = cond_chain[ref_slot_idx]["negative"] if ref_slot_idx < len(cond_chain) else cond_chain[-1]["negative"]
            if master_positive is not None:
                ref_pos = self._combine_cond(ref_pos, master_positive)
            if master_negative is not None:
                ref_neg = self._combine_cond(ref_neg, master_negative)

            print(f"  [REFINE] {refining_steps} steps | slot={ref_slot_idx} "
                  f"{ref_slot['lora_name']} | str={eff_strength:.3f}")

            for j in range(refining_steps):
                abs_step = steps + j
                is_last  = (j == refining_steps - 1)
                out = common_ksampler(
                    model=ref_model, seed=seed, steps=total_steps, cfg=cfg_end,
                    sampler_name=sampler_name, scheduler=scheduler,
                    positive=ref_pos, negative=ref_neg, latent=current_latent,
                    denoise=denoise, disable_noise=True,
                    start_step=abs_step, last_step=abs_step + 1,
                    force_full_denoise=is_last,
                )
                current_latent = out[0]

        # Stamp final strength into each slot so a chained sampler
        # can continue from where this one ended.
        for idx, slot in enumerate(step_chain):
            if idx in final_strengths:
                slot["final_strength"] = final_strengths[idx]
        return (current_latent, step_chain, cond_chain)


# ──────────────────────────────────────────────────────────────────────────────
# Registration
# ──────────────────────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "CyclicModelBuilder": CyclicModelBuilder,
    "CyclicCondSelector": CyclicCondSelector,
    "CyclicKSampler":     CyclicKSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CyclicModelBuilder": "Cyclic Model Builder",
    "CyclicCondSelector": "Cyclic Conditioning Selector",
    "CyclicKSampler":     "Cyclic KSampler",
}

WEB_DIRECTORY = "./web"
