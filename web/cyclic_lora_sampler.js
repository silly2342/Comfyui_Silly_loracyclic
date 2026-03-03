import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const NODE_TYPE = "CyclicModelBuilder";
const MAX_EXTRA = 4;
const WIDGET_H  = 130;
const PT_R      = 7;
const FIXED_XS  = [0.0, 0.5, 1.0];

// ── Curve math ────────────────────────────────────────────────────────────────

function catmullRom(p0, p1, p2, p3, t) {
    const t2=t*t, t3=t2*t;
    return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t2+(-p0+3*p1-3*p2+p3)*t3);
}
function evalCurve(pts, x) {
    const s=[...pts].sort((a,b)=>a.x-b.x);
    if(!s.length) return 1;
    if(x<=s[0].x) return s[0].y;
    if(x>=s[s.length-1].x) return s[s.length-1].y;
    let i=1; while(i<s.length-1&&s[i].x<x) i++;
    const t=(x-s[i-1].x)/Math.max(s[i].x-s[i-1].x,1e-6);
    const p0=s[Math.max(0,i-2)], p3=s[Math.min(s.length-1,i+1)];
    return Math.max(0,Math.min(2,catmullRom(p0.y,s[i-1].y,s[i].y,p3.y,t)));
}

// ── Curve widget ──────────────────────────────────────────────────────────────

function makeCurveWidget(node, name, initPts) {
    // all slots default to 1.0
    const defaultY = 1.0;
    let pts = FIXED_XS.map((x,i) => ({
        x,
        y: (initPts&&initPts[i]!=null) ? Math.max(0,Math.min(2,+initPts[i].y)) : defaultY
    }));
    let dragIdx=-1, hoverIdx=-1;

    const widget = {
        name,
        type:      "STRENGTH_CURVE",
        serialize: true,
        options:   {},

        get value() { return pts.map(p=>({x:p.x,y:p.y})); },
        set value(v) {
            if(!v) return;
            try {
                const arr = typeof v==="string" ? JSON.parse(v) : v;
                if(Array.isArray(arr)&&arr.length>=3)
                    pts = FIXED_XS.map((x,i)=>({x, y:Math.max(0,Math.min(2,+arr[i].y))}));
            } catch(e){}
        },

        computeSize(w) { return [w, WIDGET_H+4]; },

        draw(ctx, node, width, y) {
            this._lastY = y;
            const M=14, W=width-M*2, H=WIDGET_H-8;
            const ox=M, oy=y+4;

            // Read timing from sibling widgets (supports per-stacked overrides)
            const getW = n => node.widgets?.find(w=>w.name===n)?.value ?? null;
            const tn = this._timingNames ?? {};
            const startT = getW(tn.start      ?? "start_time")    ?? 0.0;
            const untilT = getW(tn.until      ?? "active_until")  ?? 1.0;
            const transT = getW(tn.transition ?? "transition_at") ?? 1.0;

            const sx = ox + startT * W;  // pixel x for start_time
            const ex = ox + untilT * W;  // pixel x for active_until
            const tx = ox + Math.min(transT, untilT) * W; // pixel x for transition_at

            // Background
            ctx.fillStyle="#181818";
            ctx.beginPath(); ctx.roundRect(ox,oy,W,H,4); ctx.fill();
            ctx.strokeStyle="#333"; ctx.lineWidth=1;
            ctx.beginPath(); ctx.roundRect(ox,oy,W,H,4); ctx.stroke();

            // Inactive region darkening (before start_time, after active_until)
            ctx.fillStyle="rgba(0,0,0,0.5)";
            if(startT > 0)   ctx.fillRect(ox, oy+1, sx-ox, H-2);
            if(untilT < 1.0) ctx.fillRect(ex, oy+1, ox+W-ex, H-2);

            // Alternating zone tint — blue (start_time → transition_at)
            if(transT > startT){
                ctx.fillStyle="rgba(40,110,255,0.10)";
                ctx.fillRect(sx, oy+1, tx-sx, H-2);
            }
            // Always-on zone tint — amber (transition_at → active_until)
            if(transT < untilT){
                ctx.fillStyle="rgba(210,130,20,0.13)";
                ctx.fillRect(tx, oy+1, ex-tx, H-2);
            }

            // Grid
            ctx.strokeStyle="#252525"; ctx.lineWidth=1;
            for(let g=1;g<4;g++){
                ctx.beginPath(); ctx.moveTo(ox+g/4*W,oy); ctx.lineTo(ox+g/4*W,oy+H); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(ox,oy+g/4*H); ctx.lineTo(ox+W,oy+g/4*H); ctx.stroke();
            }

            // y=1 snap line
            ctx.strokeStyle="#445566"; ctx.setLineDash([4,3]);
            ctx.beginPath(); ctx.moveTo(ox,oy+H/2); ctx.lineTo(ox+W,oy+H/2); ctx.stroke();
            ctx.setLineDash([]);

            // Boundary lines
            ctx.setLineDash([3,3]);
            if(startT > 0){
                ctx.strokeStyle="rgba(80,150,255,0.6)"; ctx.lineWidth=1;
                ctx.beginPath(); ctx.moveTo(sx,oy); ctx.lineTo(sx,oy+H); ctx.stroke();
            }
            if(untilT < 1.0){
                ctx.strokeStyle="rgba(80,150,255,0.6)"; ctx.lineWidth=1;
                ctx.beginPath(); ctx.moveTo(ex,oy); ctx.lineTo(ex,oy+H); ctx.stroke();
            }
            if(transT > startT && transT < untilT){
                ctx.strokeStyle="rgba(220,140,30,0.7)"; ctx.lineWidth=1;
                ctx.beginPath(); ctx.moveTo(tx,oy); ctx.lineTo(tx,oy+H); ctx.stroke();
            }
            ctx.setLineDash([]);

            // Curve — blue in alternating zone, amber in always-on, grey outside active
            ctx.lineWidth=2;
            let prevCol=null;
            ctx.beginPath();
            for(let i=0;i<=W;i++){
                const px  = i/W;
                const cy  = oy+H-(evalCurve(pts,px)/2)*H;
                const cx2 = ox+i;
                const inActive = px>=startT && px<=untilT;
                const col = !inActive ? "#2a2a2a"
                           : px<transT ? "#4af"
                           :             "#e8a030";
                if(col!==prevCol){
                    if(prevCol!==null) ctx.stroke();
                    ctx.strokeStyle=col;
                    ctx.beginPath(); ctx.moveTo(cx2,cy);
                    prevCol=col;
                } else {
                    ctx.lineTo(cx2,cy);
                }
            }
            ctx.stroke();

            // Vertical guides at handle X positions
            ctx.strokeStyle="#2a3a4a"; ctx.lineWidth=1;
            for(const p of pts){
                ctx.beginPath(); ctx.moveTo(ox+p.x*W,oy); ctx.lineTo(ox+p.x*W,oy+H); ctx.stroke();
            }

            // Control points
            for(let i=0;i<pts.length;i++){
                const px=ox+pts[i].x*W;
                const py=oy+H-(pts[i].y/2)*H;
                const col=i===dragIdx?"#f84":i===hoverIdx?"#ff0":"#ddd";
                ctx.beginPath(); ctx.arc(px,py,PT_R,0,Math.PI*2);
                ctx.fillStyle=col; ctx.fill();
                ctx.strokeStyle="#000"; ctx.lineWidth=1; ctx.stroke();
                ctx.fillStyle="#aaa"; ctx.font="9px monospace";
                ctx.fillText(pts[i].y.toFixed(2),px-10,py-PT_R-5);
            }

            // Axis labels
            ctx.fillStyle="#555"; ctx.font="9px monospace";
            ctx.fillText("2.0",ox+2,oy+10);
            ctx.fillText("1.0",ox+2,oy+H/2+4);
            ctx.fillText("0.0",ox+2,oy+H-2);

            // Zone labels
            ctx.font="8px monospace"; ctx.textAlign="center";
            if(transT > startT){
                const midAlt = (startT + Math.min(transT,untilT))/2;
                ctx.fillStyle="rgba(80,150,255,0.5)";
                ctx.fillText("alt", ox+midAlt*W, oy+H-4);
            }
            if(transT < untilT){
                ctx.fillStyle="rgba(220,140,30,0.6)";
                ctx.fillText("on", ox+(transT+untilT)/2*W, oy+H-4);
            }
            ctx.textAlign="left";
        },

        mouse(e, pos, node) {
            // Use Y stored from last draw call — most reliable source of truth
            const wY = this._lastY ?? 0;
            const M=14, W=node.size[0]-M*2, H=WIDGET_H-8;
            const lx=pos[0]-M;
            const ly=pos[1]-wY-4;
            const ny=Math.max(0,Math.min(2,(1-ly/H)*2));
            const HIT=PT_R+5;

            if(e.type==="pointermove"||e.type==="mousemove"){
                if(dragIdx>=0){
                    let snapped = ny;
                    if(snapped < 0.06) snapped = 0.0;           // snap to 0
                    else if(Math.abs(snapped - 1.0) < 0.06) snapped = 1.0;  // snap to 1
                    pts[dragIdx].y = snapped;
                    node.setDirtyCanvas(true);
                    return true;
                }
                hoverIdx=-1;
                for(let i=0;i<pts.length;i++){
                    const px=pts[i].x*W, py=H-(pts[i].y/2)*H;
                    if(Math.abs(lx-px)<=HIT&&Math.abs(ly-py)<=HIT){hoverIdx=i;break;}
                }
                node.setDirtyCanvas(true);
            }
            if(e.type==="pointerdown"||e.type==="mousedown"){
                for(let i=0;i<pts.length;i++){
                    const px=pts[i].x*W, py=H-(pts[i].y/2)*H;
                    if(Math.abs(lx-px)<=HIT&&Math.abs(ly-py)<=HIT){dragIdx=i;return true;}
                }
            }
            if(e.type==="pointerup"||e.type==="mouseup"){
                dragIdx=-1;
                // Sync value to Python STRING widget on release
                const pyW=node.widgets?.find(w=>w.name===widget.name&&w!==widget&&w.type!=="STRENGTH_CURVE");
                if(pyW) pyW.value=JSON.stringify(pts.map(p=>({x:p.x,y:p.y})));
                node.setDirtyCanvas(true);
            }
            return dragIdx>=0;
        },
    };

    node.addCustomWidget(widget);
    return widget;
}

// ── LoRA stack helpers ────────────────────────────────────────────────────────

function getLoraValues(node) {
    return node.widgets?.find(w=>w.name==="lora_name")?.options?.values ?? ["None"];
}
function countExtraSlots(node) {
    return node.widgets?.filter(w=>/^lora_name_\d+$/.test(w.name)).length ?? 0;
}
function hideWidget(w) {
    if(!w) return;
    w._origType = w._origType ?? w.type;
    w.type = "hidden";
    w.computeSize = ()=>[0,-4];
}

function addLoraRow(node, initName, initCurve, initStart, initUntil) {
    const count=countExtraSlots(node);
    if(count>=MAX_EXTRA) return null;
    const n=count+2;
    const btnIdx=node.widgets.findIndex(w=>w.name==="＋ Add LoRA");
    const at=btnIdx>=0?btnIdx:node.widgets.length-2;

    const nameW=ComfyWidgets["COMBO"](node,`lora_name_${n}`,[getLoraValues(node)],app).widget;
    nameW.value=initName??"None";

    // start_time float widget
    const startW=ComfyWidgets["FLOAT"](node,`lora_start_${n}`,
        ["FLOAT", {default:0.0, min:0.0, max:1.0, step:0.01, round:0.01}],app).widget;
    startW.value=initStart??0.0;

    // active_until float widget
    const untilW=ComfyWidgets["FLOAT"](node,`lora_until_${n}`,
        ["FLOAT", {default:1.0, min:0.0, max:1.0, step:0.01, round:0.01}],app).widget;
    untilW.value=initUntil??1.0;

    // Hide the Python STRING widget, create JS curve widget
    const pyW=node.widgets.find(w=>w.name===`strength_curve_${n}`&&w.type!=="STRENGTH_CURVE");
    if(pyW) hideWidget(pyW);

    const curveW=makeCurveWidget(node,`strength_curve_${n}`, initCurve !== undefined ? initCurve : null);
    curveW._timingNames = { start: `lora_start_${n}`, until: `lora_until_${n}`, transition: "transition_at" };
    if(initCurve) curveW.value=initCurve;

    for(const w of [nameW,startW,untilW,curveW]){
        const i=node.widgets.indexOf(w);
        if(i!==-1) node.widgets.splice(i,1);
    }
    node.widgets.splice(at,0,nameW,startW,untilW,curveW);

    node.setSize([node.size[0],node.computeSize()[1]]);
    node.setDirtyCanvas(true,true);
    return {nameW,startW,untilW,curveW};
}

function removeLoraRow(node) {
    const count=countExtraSlots(node);
    if(count===0) return;
    const n=count+1;
    // Remove lora_name, start, until, curve widgets; leave Python STRING hidden
    node.widgets=node.widgets.filter(w=>
        w.name!==`lora_name_${n}` &&
        w.name!==`lora_start_${n}` &&
        w.name!==`lora_until_${n}` &&
        !(w.name===`strength_curve_${n}`&&w.type==="STRENGTH_CURVE")
    );
    node.setSize([node.size[0],node.computeSize()[1]]);
    node.setDirtyCanvas(true,true);
}

// ── KSampler Overview Widget ──────────────────────────────────────────────────

// Primary slot colours (one per builder node)
const SLOT_COLORS = ["#4af","#f84","#4f8","#f4a","#af4","#a4f","#fa4","#4fa"];

// Get a visually distinct colour for each individual LoRA slot
// Stacked LoRAs within the same group get lighter/darker variants
function getSlotColor(globalIdx, groupIdx, posInGroup, groupSize) {
    const base = SLOT_COLORS[groupIdx % SLOT_COLORS.length];
    if(groupSize <= 1 || posInGroup === 0) return base;
    // Parse hex to hsl-ish shift — just return from an extended palette
    const variants = [
        ["#4af","#a0dfff","#1a6a99","#7fcfff"],  // blue variants
        ["#f84","#ffcc88","#cc5500","#ff9944"],  // orange variants
        ["#4f8","#aaffcc","#1a8844","#77ffaa"],  // green variants
        ["#f4a","#ffbbdd","#cc2266","#ff77bb"],  // pink variants
        ["#af4","#ddff99","#668800","#ccff55"],  // yellow-green
        ["#a4f","#ddbbff","#6600cc","#bb88ff"],  // purple
        ["#fa4","#ffddaa","#cc7700","#ffbb55"],  // amber
        ["#4fa","#aaffee","#008866","#55ffcc"],  // teal
    ];
    const group = variants[groupIdx % variants.length];
    return group[posInGroup % group.length];
}
const OV_H = 110;



// Build step sequence: returns array of {slotIdx, strength} per step
function buildStepSequence(slots, steps) {
    const result = [];
    let lastKey = null, interleaved = [], seqPos = 0;

    function isAlt(s, p)    { return (s.alternate !== false) && p < (s.transition_at ?? 1); }
    function isActive(s, p) { return (s.start_time ?? 0) <= p && p <= (s.active_until ?? 1); }
    function localP(s, p)   {
        const w = (s.active_until??1) - (s.start_time??0);
        return w <= 0 ? 0 : Math.max(0, Math.min(1, (p-(s.start_time??0))/w));
    }

    for(let step = 0; step < steps; step++){
        const p = steps > 1 ? step / (steps - 1) : 0;

        const key = slots.map((s,i) => {
            const rep = (isAlt(s,p) && isActive(s,p) && p>=(s.repeat_start??0))
                ? Math.max(1, s.repeat??1) : 1;
            return `${isAlt(s,p)?1:0}${isActive(s,p)?1:0}${rep}`;
        }).join("");

        if(key !== lastKey){
            lastKey = key;
            const ao  = slots.flatMap((s,i)=>(!isAlt(s,p)&&isActive(s,p))?[i]:[]);
            const alt = slots.flatMap((s,i)=>( isAlt(s,p)&&isActive(s,p))?[i]:[]);
            const pat = [];
            for(const i of alt){
                const rep = p>=(slots[i].repeat_start??0) ? Math.max(1,slots[i].repeat??1) : 1;
                for(let r=0;r<rep;r++) pat.push(i);
            }
            interleaved = [];
            if(pat.length){
                for(const pi of pat){ for(const ai of ao) interleaved.push(ai); interleaved.push(pi); }
            } else { for(const ai of ao) interleaved.push(ai); }
            if(!interleaved.length) interleaved=[0];
            seqPos = 0;
        }

        // Find next active slot
        let picked = -1;
        for(let t=0; t<interleaved.length; t++){
            const c = interleaved[(seqPos+t) % interleaved.length];
            if(isActive(slots[c], p)){ picked=c; seqPos=seqPos+t; break; }
        }
        if(picked < 0) picked = 0;

        // Evaluate strength from curve at local progress
        const s    = slots[picked];
        const lp   = localP(s, p);
        const pts  = s.curve_pts ?? [{x:0,y:1},{x:0.5,y:1},{x:1,y:1}];
        const str  = evalCurve(pts, lp);

        result.push({ slotIdx: picked, strength: str });
        seqPos++;
    }
    return result;
}

function drawOverview(ctx, node, ox, oy, iW, iH, H) {
    // Panel background
    ctx.fillStyle="#181818";
    ctx.beginPath(); ctx.roundRect(ox, oy, iW, H, 4); ctx.fill();
    ctx.strokeStyle="#444"; ctx.lineWidth=1;
    ctx.beginPath(); ctx.roundRect(ox, oy, iW, H, 4); ctx.stroke();

    // Clip to panel
    ctx.beginPath(); ctx.roundRect(ox+1, oy+1, iW-2, H-2, 3); ctx.clip();

    // Grid
    ctx.strokeStyle="#222"; ctx.lineWidth=1;
    for(let g=1;g<4;g++){
        ctx.beginPath(); ctx.moveTo(ox+g/4*iW,oy); ctx.lineTo(ox+g/4*iW,oy+iH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ox,oy+g/4*iH); ctx.lineTo(ox+iW,oy+g/4*iH); ctx.stroke();
    }
    ctx.strokeStyle="#2a3a4a"; ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.moveTo(ox,oy+iH/2); ctx.lineTo(ox+iW,oy+iH/2); ctx.stroke();
    ctx.setLineDash([]);

    const slots = collectSlots(node);

    if(slots.length === 0){
        ctx.fillStyle="#444"; ctx.font="10px Arial"; ctx.textAlign="center";
        ctx.fillText("connect step_chain to see overview", ox+iW/2, oy+iH/2+4);
        ctx.textAlign="left";
    } else {
        // Draw curves
        for(let si=0; si<slots.length; si++){
            const slot   = slots[si];
            const col    = slot.color ?? SLOT_COLORS[si % SLOT_COLORS.length];
            const startT = slot.start_time ?? 0;
            const untilT = slot.active_until ?? 1;
            const pts    = slot.curve_pts;
            if(!pts || pts.length < 2) continue;

            ctx.strokeStyle=col; ctx.lineWidth=2; ctx.globalAlpha=0.9;
            ctx.beginPath();
            let started=false;
            for(let i=0;i<=iW;i++){
                const px=i/iW;
                if(px<startT||px>untilT){started=false;continue;}
                const lp=(px-startT)/Math.max(untilT-startT,1e-6);
                const cy=oy+iH-(evalCurve(pts,lp)/2)*iH;
                if(!started){ctx.moveTo(ox+i,cy);started=true;}
                else ctx.lineTo(ox+i,cy);
            }
            ctx.stroke(); ctx.globalAlpha=1;

            // Boundary ticks
            ctx.strokeStyle=col; ctx.lineWidth=1; ctx.globalAlpha=0.35; ctx.setLineDash([2,3]);
            if(startT>0){ctx.beginPath();ctx.moveTo(ox+startT*iW,oy);ctx.lineTo(ox+startT*iW,oy+iH);ctx.stroke();}
            if(untilT<1){ctx.beginPath();ctx.moveTo(ox+untilT*iW,oy);ctx.lineTo(ox+untilT*iW,oy+iH);ctx.stroke();}
            ctx.setLineDash([]); ctx.globalAlpha=1;
        }

        // Step dots
        const steps   = node.widgets?.find(w=>w.name==="steps")?.value ?? 20;
        const seq     = buildStepSequence(slots, steps);
        const spacing = iW / steps;
        const dotR    = Math.min(4, spacing*0.38);
        for(let s=0;s<seq.length;s++){
            const {slotIdx,strength}=seq[s];
            const col=slots[slotIdx]?.color ?? SLOT_COLORS[slotIdx%SLOT_COLORS.length];
            const cx=ox+(s+0.5)*spacing;
            const cy=oy+iH-(strength/2)*iH;
            ctx.fillStyle=col; ctx.globalAlpha=Math.max(0.4,Math.min(1,strength));
            ctx.beginPath(); ctx.arc(cx,cy,Math.max(1.5,dotR),0,Math.PI*2); ctx.fill();
            ctx.globalAlpha=0.6; ctx.strokeStyle="#000"; ctx.lineWidth=0.8; ctx.stroke();
        }
        ctx.globalAlpha=1;
    }

    // Axis labels
    ctx.textAlign="left"; ctx.fillStyle="#555"; ctx.font="9px monospace";
    ctx.fillText("2",ox+2,oy+9);
    ctx.fillText("1",ox+2,oy+iH/2+4);
    ctx.fillText("0",ox+2,oy+iH-2);
    // start/end
    ctx.fillStyle="#556"; ctx.font="8px monospace";
    ctx.fillText("start",ox+3,oy+iH+10);
    ctx.textAlign="right";
    ctx.fillText("end",ox+iW-3,oy+iH+10);
    ctx.textAlign="left";
}

function collectSlots(ksamplerNode) {
    const slots = [];   // flat list for simulation
    const graph = app.graph;
    if(!graph) return slots;
    const stepInput = ksamplerNode.inputs?.find(i=>i.name==="step_chain") ?? ksamplerNode.inputs?.[0];
    const linkId = stepInput?.link;
    if(linkId == null) return slots;

    function walkChain(nodeId) {
        const n = graph.getNodeById(nodeId);
        if(!n) return;
        // If we hit another KSampler, follow its step_chain input to get to builders
        if(n.type === "CyclicKSampler") {
            const inp = n.inputs?.find(i=>i.name==="step_chain") ?? n.inputs?.[0];
            if(inp?.link != null) {
                const lnk = graph.links?.[inp.link];
                if(lnk) walkChain(lnk.origin_id);
            }
            return;
        }
        if(n.type !== "CyclicModelBuilder") return;
        const getW = name => n.widgets?.find(w=>w.name===name)?.value ?? null;

        const sharedTiming = {
            start_time:    getW("start_time")    ?? 0,
            active_until:  getW("active_until")  ?? 1,
            transition_at: getW("transition_at") ?? 1,
            alternate:     getW("alternate")     ?? true,
            repeat:        getW("repeat")        ?? 1,
            repeat_start:  getW("repeat_start")  ?? 0,
        };

        // Collect primary + stacked LoRAs from this node
        const nodeSlots = [];

        // Primary slot
        const primaryCurve = n.widgets?.find(w=>w.name==="strength_curve" && w.type==="STRENGTH_CURVE")?.value;
        const primaryName  = (getW("lora_name") ?? "slot").split("/").pop().replace(/\.safetensors$/i,"");
        if(primaryName && primaryName !== "None")
            nodeSlots.push({ name: primaryName, curve_pts: primaryCurve ?? [{x:0,y:1},{x:0.5,y:1},{x:1,y:1}] });

        // Stacked LoRAs (2-5) — each gets its own start/until if set
        for(let k=2; k<=5; k++){
            const stackedName = getW(`lora_name_${k}`);
            if(!stackedName || stackedName === "None") continue;
            const stackedCurve = n.widgets?.find(w=>w.name===`strength_curve_${k}` && w.type==="STRENGTH_CURVE")?.value;
            const stackedStart = n.widgets?.find(w=>w.name===`lora_start_${k}`)?.value ?? sharedTiming.start_time;
            const stackedUntil = n.widgets?.find(w=>w.name===`lora_until_${k}`)?.value ?? sharedTiming.active_until;
            nodeSlots.push({
                name:         stackedName.split("/").pop().replace(/\.safetensors$/i,""),
                curve_pts:    stackedCurve ?? [{x:0,y:1},{x:0.5,y:1},{x:1,y:1}],
                start_time:   stackedStart,
                active_until: stackedUntil,
            });
        }

        // Add all node slots — stacked use their own timing, primary uses shared
        for(let i=nodeSlots.length-1; i>=0; i--){
            const overrides = i===0 ? {} : { start_time: nodeSlots[i].start_time, active_until: nodeSlots[i].active_until };
            slots.unshift({ ...sharedTiming, ...nodeSlots[i], ...overrides });
        }

        const chainIn = n.inputs?.find(i=>i.name==="chain_in");
        if(chainIn?.link != null){
            const lnk = graph.links?.[chainIn.link];
            if(lnk) walkChain(lnk.origin_id);
        }
    }
    const lnk = graph.links?.[linkId];
    if(lnk) walkChain(lnk.origin_id);
    // Assign colours from collectSlotGroups — single source of truth
    const groups_ = collectSlotGroups(ksamplerNode);
    const colorMap = {};
    for(const g of groups_)
        g.names.forEach((name,pi) => { colorMap[name] = g.colors[pi]; });
    for(const s of slots)
        s.color = colorMap[s.name] ?? SLOT_COLORS[0];
    return slots;
}

// Returns array of node-groups: each group = one builder node with all its LoRAs
function collectSlotGroups(ksamplerNode) {
    const groups = [];
    const graph  = app.graph;
    if(!graph) return groups;
    const stepInput = ksamplerNode.inputs?.find(i=>i.name==="step_chain") ?? ksamplerNode.inputs?.[0];
    const linkId = stepInput?.link;
    if(linkId == null) return groups;

    function walkChain(nodeId) {
        const n = graph.getNodeById(nodeId);
        if(!n) return;
        // Pass through chained KSamplers to reach their builders
        if(n.type === "CyclicKSampler") {
            const inp = n.inputs?.find(i=>i.name==="step_chain") ?? n.inputs?.[0];
            if(inp?.link != null) {
                const lnk = graph.links?.[inp.link];
                if(lnk) walkChain(lnk.origin_id);
            }
            return;
        }
        if(n.type !== "CyclicModelBuilder") return;
        const getW = name => n.widgets?.find(w=>w.name===name)?.value ?? null;

        const timing = {
            start_time:    getW("start_time")    ?? 0,
            active_until:  getW("active_until")  ?? 1,
            transition_at: getW("transition_at") ?? 1,
            alternate:     getW("alternate")     ?? true,
            repeat:        getW("repeat")        ?? 1,
            repeat_start:  getW("repeat_start")  ?? 0,
        };

        const names = [], curves = [];
        const primaryName = (getW("lora_name") ?? "").split("/").pop().replace(/\.safetensors$/i,"");
        const primaryCurve = n.widgets?.find(w=>w.name==="strength_curve"&&w.type==="STRENGTH_CURVE")?.value;
        if(primaryName && primaryName !== "None"){
            names.push(primaryName);
            curves.push(primaryCurve ?? [{x:0,y:1},{x:0.5,y:1},{x:1,y:1}]);
        }
        for(let k=2;k<=5;k++){
            const sn = (getW(`lora_name_${k}`) ?? "").split("/").pop().replace(/\.safetensors$/i,"");
            if(!sn || sn==="None") continue;
            const sc = n.widgets?.find(w=>w.name===`strength_curve_${k}`&&w.type==="STRENGTH_CURVE")?.value;
            const ss = n.widgets?.find(w=>w.name===`lora_start_${k}`)?.value ?? timing.start_time;
            const su = n.widgets?.find(w=>w.name===`lora_until_${k}`)?.value ?? timing.active_until;
            names.push(sn);
            curves.push(sc ?? [{x:0,y:1},{x:0.5,y:1},{x:1,y:1}]);
        }

        if(names.length) groups.unshift({ names, curves, colors:[], ...timing });

        const chainIn = n.inputs?.find(i=>i.name==="chain_in");
        if(chainIn?.link!=null){ const lnk=graph.links?.[chainIn.link]; if(lnk) walkChain(lnk.origin_id); }
    }
    const lnk = graph.links?.[linkId];
    if(lnk) walkChain(lnk.origin_id);
    // Assign colours after all groups collected so indices are stable
    for(let gi=0; gi<groups.length; gi++){
        groups[gi].colors = groups[gi].names.map((n,pi) => getSlotColor(gi, gi, pi, groups[gi].names.length));
    }
    return groups;
}

app.registerExtension({
    name: "CyclicSampler.KSamplerOverview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if(nodeData.name !== "CyclicKSampler") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            onNodeCreated?.apply(this, arguments);
            // Expand node upward to make room — store extra height in property
            this._ovH = OV_H + 20; // graph height + legend row
        };

        // Draw overview above the node using onDrawBackground
        const onDrawBg = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            onDrawBg?.apply(this, arguments);
            const node   = this;
            const W      = node.size[0];
            const H      = OV_H;
            const M      = 6;
            const ox     = M;
            const titleH = LiteGraph.NODE_TITLE_HEIGHT ?? 30;
            const oy     = -titleH - H - 28;
            const iW     = W - M*2;
            const iH     = H - 16;

            // Always save/restore at the top level — never let errors corrupt canvas state
            ctx.save();
            try {
                drawOverview(ctx, node, ox, oy, iW, iH, H);
            } catch(e) {
                console.warn("[CyclicOverview]", e);
            } finally {
                ctx.restore();
            }

            // Legend outside clip — own save/restore
            ctx.save();
            try {
                const groups = collectSlotGroups(node);
                if(groups.length > 0){
                    // One pill per builder node — stacked LoRAs joined on same line
                    ctx.font = "8px monospace";
                    const lbh = 13, lbgap = 3, dotR = 3, pad = 6;
                    let colIdx = 0;
                    ctx.textAlign = "left";
                    for(let gi=0; gi<groups.length; gi++){
                        const g     = groups[gi];
                        // Use group's own colour array so legend matches curves
                        const col = (g.colors && g.colors[0]) ? g.colors[0] : SLOT_COLORS[colIdx % SLOT_COLORS.length];
                        colIdx += g.names.length;
                        // Build label with primary name bright, stacked names lighter
                        const primary = g.names[0] ?? "";
                        const stacked = g.names.slice(1);
                        const primaryLabel = "LoRA : " + primary;
                        const stackedLabel = stacked.length ? ", " + stacked.join(", ") : "";
                        const fullLabel = primaryLabel + stackedLabel;
                        const tw    = ctx.measureText(fullLabel).width;
                        const lbw   = tw + pad*2 + dotR*2 + 4;
                        const lbx   = ox;
                        const lby   = oy - (groups.length - gi) * (lbh + lbgap) - 2;
                        ctx.fillStyle = "rgba(20,20,20,0.80)";
                        ctx.beginPath(); ctx.roundRect(lbx, lby, lbw, lbh, 3); ctx.fill();
                        ctx.strokeStyle = col + "99"; ctx.lineWidth = 1;
                        ctx.beginPath(); ctx.roundRect(lbx, lby, lbw, lbh, 3); ctx.stroke();
                        // Dot in primary colour
                        ctx.fillStyle = col;
                        ctx.beginPath(); ctx.arc(lbx+pad+dotR, lby+lbh/2, dotR, 0, Math.PI*2); ctx.fill();
                        // Primary name in full colour
                        const tx = lbx+pad+dotR*2+4;
                        ctx.fillStyle = col;
                        ctx.fillText(primaryLabel, tx, lby+lbh*0.76);
                        // Stacked names in dimmed version of same colour
                        if(stackedLabel){
                            const pw = ctx.measureText(primaryLabel).width;
                            // Each stacked name in its own distinct colour
                            let cx3 = tx + pw;
                            const stackedParts = stacked.map((n,i) => ({
                                text: (i===0?", ":", ") + n,
                                col: (g.colors && g.colors[i+1]) ? g.colors[i+1] : col+"88"
                            }));
                            for(const sp of stackedParts){
                                ctx.fillStyle = sp.col;
                                ctx.fillText(sp.text, cx3, lby+lbh*0.76);
                                cx3 += ctx.measureText(sp.text).width;
                            }
                        }
                    }
                }
            } catch(e) {
                console.warn("[CyclicOverview legend]", e);
            } finally {
                ctx.restore();
            }
        };


        // Make the node taller to expose the area above the title bar
        const getExtraTop = nodeType.prototype.getExtraTop ?? null;
        nodeType.prototype.getExtraTop = function() {
            const base = getExtraTop?.apply(this, arguments) ?? 0;
            return base + OV_H + 68;
        };
    },
});

// ── Extension ─────────────────────────────────────────────────────────────────

app.registerExtension({
    name: "CyclicSampler.LoRAStack",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if(nodeData.name!==NODE_TYPE) return;

        const onNodeCreated=nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated=function(){
            onNodeCreated?.apply(this,arguments);

            // Hide widgets replaced by curve
            for(const n of ["strength_start","strength_mid","strength_end","curve"])
                hideWidget(this.widgets?.find(w=>w.name===n));

            // Hide python-side STRING for strength_curve (primary slot)
            hideWidget(this.widgets?.find(w=>w.name==="strength_curve"));

            // Note: lora_name_2..5 are no longer in INPUT_TYPES, so no need to hide them.
            // They are created dynamically by addLoraRow when user clicks + Add LoRA.

            // Insert primary curve after lora_name
            const loraIdx=this.widgets.findIndex(w=>w.name==="lora_name");
            const curveW=makeCurveWidget(this,"strength_curve");
            const ci=this.widgets.indexOf(curveW);
            if(ci!==-1) this.widgets.splice(ci,1);
            this.widgets.splice(loraIdx+1,0,curveW);

            this.addWidget("button","＋ Add LoRA",null,()=>addLoraRow(this));
            this.addWidget("button","－ Remove LoRA",null,()=>removeLoraRow(this));


            this.setSize([this.size[0],this.computeSize()[1]]);
        };

        const onConfigure=nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure=function(config){
            onConfigure?.apply(this,arguments);

            // Restore extra LoRA rows from saved properties — pass saved data directly
            const savedCount=this.properties?.lora_stack_count??0;
            const currentCount=countExtraSlots(this);
            for(let i=currentCount;i<savedCount;i++){
                const n=i+2;
                const savedName =this.properties?.[`lora_name_${n}`]??null;
                const savedCurveStr=this.properties?.[`strength_curve_${n}`]??null;
                let savedCurve=null;
                if(savedCurveStr){ try{ savedCurve=JSON.parse(savedCurveStr); }catch(e){} }
                const savedStart=this.properties?.[`lora_start_${n}`]??0.0;
                const savedUntil=this.properties?.[`lora_until_${n}`]??1.0;
                addLoraRow(this, savedName, savedCurve, savedStart, savedUntil);
            }
            // Defer only the name restore (COMBO value may get overwritten by widgets_values)
            const self=this;
            setTimeout(()=>{
                for(let n=2;n<=savedCount+1;n++){
                    const savedName=self.properties?.[`lora_name_${n}`];
                    if(savedName){
                        const nw=self.widgets?.find(w=>w.name===`lora_name_${n}`);
                        if(nw && (nw.value==="None"||!nw.value)) nw.value=savedName;
                    }
                    // Re-apply curve
                    const savedCurveStr=self.properties?.[`strength_curve_${n}`];
                    if(savedCurveStr){
                        const cw=self.widgets?.find(w=>w.name===`strength_curve_${n}`&&w.type==="STRENGTH_CURVE");
                        if(cw){ try{ cw.value=JSON.parse(savedCurveStr); }catch(e){} }
                    }
                    // Re-apply start/until
                    const sw=self.widgets?.find(w=>w.name===`lora_start_${n}`);
                    if(sw && self.properties?.[`lora_start_${n}`]!=null) sw.value=self.properties[`lora_start_${n}`];
                    const uw=self.widgets?.find(w=>w.name===`lora_until_${n}`);
                    if(uw && self.properties?.[`lora_until_${n}`]!=null) uw.value=self.properties[`lora_until_${n}`];
                }
                self.setDirtyCanvas(true);
            }, 150);

            // Re-anchor buttons to end
            const a=this.widgets?.find(w=>w.name==="＋ Add LoRA");
            const r=this.widgets?.find(w=>w.name==="－ Remove LoRA");
            if(a&&r){
                this.widgets=this.widgets.filter(w=>w!==a&&w!==r);
                this.widgets.push(a,r);
            }

            this.setSize([this.size[0],this.computeSize()[1]]);
        };

        // Save extra slot count, lora names AND curve data into properties
        const onSerialize=nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize=function(data){
            onSerialize?.apply(this,arguments);
            if(!data.properties) data.properties={};
            const count=countExtraSlots(this);
            data.properties.lora_stack_count=count;
            for(let n=2;n<=count+1;n++){
                const nameW=this.widgets?.find(w=>w.name===`lora_name_${n}`);
                if(nameW) data.properties[`lora_name_${n}`]=nameW.value;
                const curveW=this.widgets?.find(w=>w.name===`strength_curve_${n}`&&w.type==="STRENGTH_CURVE");
                if(curveW) data.properties[`strength_curve_${n}`]=JSON.stringify(curveW.value);
                const startW=this.widgets?.find(w=>w.name===`lora_start_${n}`);
                if(startW) data.properties[`lora_start_${n}`]=startW.value;
                const untilW=this.widgets?.find(w=>w.name===`lora_until_${n}`);
                if(untilW) data.properties[`lora_until_${n}`]=untilW.value;
            }
        };
    },
});
