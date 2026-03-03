# comfyui_Silly_loracyclic

Cycle through multiple LoRA models across denoising steps — each slot has its own strength curve, timing window, alternating pattern, and per-slot conditioning.

---

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/silly2342/comfyui_Silly_loracyclic
```

Restart ComfyUI. Nodes appear under **sampling/cyclic**.

---

## Nodes

### Cyclic Model Builder

Defines one LoRA slot. Chain multiple builders together to build your slot list.

| Input | Description |
|---|---|
| `model` | Base model |
| `clip` | CLIP model |
| `chain_in` | Connect from previous builder's `chain_out` (leave empty on first builder) |
| `lora_name` | LoRA to load |
| `start_time` | Progress (0–1) when this slot becomes active |
| `active_until` | Progress (0–1) when this slot deactivates |
| `alternate` | ON = takes turns with other alternating slots. OFF = runs every step while active |
| `repeat` | How many consecutive steps this slot holds before yielding (only when alternating) |
| `repeat_start` | Progress threshold before `repeat` kicks in — before this, repeat is forced to 1 |
| `transition_at` | Progress where slot switches from alternating → always-on |
| `resume_strength` | When chaining two KSamplers: continue strength curve from where first ended |
| strength curve | 3-point editor: shape the LoRA strength (0–2) across the slot's active window |

**+ Add LoRA** — add up to 4 stacked LoRAs per slot, each with its own strength curve and start/end window. Stacked LoRAs run simultaneously with the primary on the same step.

| Output | Description |
|---|---|
| `chain_out` | Feed into next builder's `chain_in`, or directly into KSampler's `step_chain` |
| `clip` | Pass-through CLIP |
| `slot_ref` | Connect to the paired Conditioning Selector |

---

### Cyclic KSampler

Runs the denoising loop, cycling through slots according to each slot's timing and repeat rules.

| Input | Description |
|---|---|
| `step_chain` | Connect from the last builder's `chain_out` |
| `latent_image` | Starting latent |
| `cond_chain` | Connect from the last Conditioning Selector's `cond_chain_out` |
| `master_positive` | Optional — blended into every slot's positive conditioning |
| `master_negative` | Optional — blended into every slot's negative conditioning |
| `steps` | Total denoising steps |
| `cfg_start/mid/end` | CFG at start, midpoint, and end of sampling |
| `cfg_curve` | Interpolation shape for CFG over time |
| `denoise` | Denoising strength (1.0 = full, <1.0 = img2img) |
| `refining_steps` | Extra low-noise steps after main schedule using the last active slot |
| `smart_blend` | Cross-contaminates alternating LoRA weights — ramps 0→25% over the first 25% of steps, then holds flat. Improves coherence between very different styles |

| Output | Description |
|---|---|
| `latent` | Denoised latent |
| `step_chain` | Pass-through to a second chained KSampler |
| `cond_chain` | Pass-through to a second chained KSampler |

**Live overview graph** — displayed above the node. Shows all connected LoRA slots as coloured curves, per-step dots, active windows, and a legend. Updates live as you edit values.

---

### Cyclic Conditioning Selector

Pairs a positive/negative prompt with a specific builder slot.

| Input | Description |
|---|---|
| `positive` | Positive prompt for this slot |
| `negative` | Negative prompt for this slot |
| `slot_ref` | Connect from the paired Model Builder's `slot_ref` output |
| `cond_chain_in` | Chain from the previous Conditioning Selector |

Connect `cond_chain_out` into the next selector's `cond_chain_in`, or directly into the KSampler's `cond_chain`. Build in the same order as your Model Builders.

---

## How Cycling Works

Steps are assigned to slots using an interleaved pattern:

- **Always-on slots** (`alternate=OFF`, or progress past `transition_at`) run on every step
- **Alternating slots** take turns in chain order
- `repeat=3` means a slot runs 3 consecutive steps before yielding — e.g. two slots gives `A A A B A A A B ...`
- `repeat_start=0.25` delays full repeat until 25% progress — single-step turns before that
- `transition_at=0.5` makes a slot alternate for the first 50%, then run every step for the rest
- Every step is a real denoising step — sigma always advances

The **overview graph** on the KSampler shows the exact per-step assignment as dots plotted on the strength curves, so you can verify the pattern before running.

---

## Wiring

### Basic single-pass

```
[Checkpoint] ──► model ──► Builder A ──► chain_out ──► Builder B ──► chain_out ──► step_chain ──►┐
                                                                                                   │
[CLIP Text +A] ──► Cond Selector A (slot_ref ◄── Builder A) ──► cond_chain_out ──►┐               │
[CLIP Text +B] ──► Cond Selector B (slot_ref ◄── Builder B) ──► cond_chain_out ──►┤ cond_chain ──►│
                                                                                   │               │
[Empty Latent] ──────────────────────────────────────────────────────────────────► Cyclic KSampler
                                                                                         │
                                                                                     [VAE Decode]
```

### Chained two-pass

```
Builders ──► KSampler 1 ──► step_chain ──► KSampler 2
                        ──► cond_chain ──► KSampler 2
                        ──► latent    ──► KSampler 2 (latent_image, denoise < 1.0)
```

With `resume_strength=true` on your builders, the strength curves continue from where the first pass left off.

---

## Strength Curve Editor

Each slot has a 3-point spline editor:

- **Drag points vertically** to shape LoRA strength (0–2) across the slot's active window
- **Y = 1.0** snaps and is highlighted as the neutral reference
- **Blue region** — alternating phase (before `transition_at`)
- **Amber region** — always-on phase (after `transition_at`)
- **Dark overlay** — inactive region (outside `start_time` → `active_until`)

---

## Tips

- Watch the **overview graph** as you adjust settings — the step dots show the exact per-step LoRA assignment
- Use `start_time` / `active_until` to confine a LoRA to a specific phase — e.g. a character LoRA active only in the first 40% of steps where structure is determined
- **Stacked LoRAs** (via + Add LoRA) are good for style + character combos that should always run together on the same steps
- **smart_blend** is most useful when alternating between stylistically very different LoRAs
- **refining_steps** appends clean-up steps at the end without cycling — useful for detail and texture
- Chain two KSamplers for a **rough pass** (full denoise) → **refine pass** (low denoise) with the cycle resuming naturally
