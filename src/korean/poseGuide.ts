import { NEUTRAL, type ArticKey, type HumanArtic } from "../wasm/engine.ts";
import { VoiceModel } from "../ui/analysis.ts";
import { PRESETS, sameBody, type BodyMix } from "../ui/body.ts";
import type { TelemetryMessage } from "../worklet/protocol.ts";
import { AnatomyRenderer, type HandleId } from "../ui/render/anatomy.ts";

interface Part {
  id: HandleId;
  name: string;
  keys: ArticKey[];
  color: string;
}
const parts: Part[] = [
  { id: "jaw", name: "턱", keys: ["jaw"], color: "#f8a08d" },
  {
    id: "tongue",
    name: "혀몸",
    keys: ["tbX", "tbY", "root", "dorsum", "lateral"],
    color: "#83e8a4",
  },
  { id: "tip", name: "혀끝", keys: ["ttX", "ttY", "ttCurl"], color: "#85c7ff" },
  { id: "velum", name: "연구개", keys: ["velum"], color: "#dbd6ff" },
  {
    id: "larynx",
    name: "후두",
    keys: ["larynx", "epilarynx", "ventricular"],
    color: "#acbfd9",
  },
  {
    id: "lips",
    name: "입술",
    keys: ["lipAp", "lipProt", "lipWidth", "labiodental"],
    color: "#ffa7c6",
  },
];
export function movingParts(target: HumanArtic) {
  return parts.filter((part) =>
    part.keys.some((k) => Math.abs(target[k] - NEUTRAL[k]) > 0.012),
  );
}
type Point = { x: number; y: number };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
export const STEP_SECONDS = 0.88;
export const HOLD_SECONDS = 0.3;

export function guideFrame(target: HumanArtic, steps: Part[], elapsed: number) {
  const index = Math.floor(elapsed / STEP_SECONDS);
  const part = steps[index];
  const phase = elapsed / STEP_SECONDS - index;
  const drag = ease((phase - 0.32) / 0.52);
  const pose = { ...NEUTRAL };
  // Changes below the display threshold still arrive exactly at the first PCM pose.
  const residual = ease(elapsed / Math.max(0.15, STEP_SECONDS * steps.length));
  for (const p of parts) {
    const at = steps.indexOf(p);
    const f = at < 0 ? residual : at < index ? 1 : at === index ? drag : 0;
    for (const key of p.keys) pose[key] = lerp(NEUTRAL[key], target[key], f);
  }
  return { pose, part, previous: steps[index - 1], phase, drag, index };
}
type GuideFrame = ReturnType<typeof guideFrame>;

export class MouthStage {
  private model = new VoiceModel(PRESETS.male, 48000);
  private renderer = new AnatomyRenderer();
  closeUp = false;
  manualPart: HandleId | null = null;
  film: number | null = null;
  filmReading = "";
  private anchors: { id: HandleId; x: number; y: number }[] = [];
  private pixelsPerUnit = 1;

  pick(x: number, y: number) {
    return this.anchors
      .map((a) => ({ ...a, distance: Math.hypot(a.x - x, a.y - y) }))
      .filter((a) => a.distance <= 25)
      .sort((a, b) => a.distance - b.distance)[0]?.id;
  }

  move(id: HandleId, origin: HumanArtic, dx: number, dy: number) {
    const x = dx / this.pixelsPerUnit,
      y = -dy / this.pixelsPerUnit;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));
    const a = { ...origin };
    switch (id) {
      case "tongue":
        a.tbX += x;
        a.tbY += y;
        break;
      case "tip":
        a.ttX += x;
        a.ttY += y;
        break;
      case "lips":
        a.lipAp = clamp(a.lipAp - y * 1.2, -0.4, 2.4);
        a.lipProt = clamp(a.lipProt + x, -0.2, 1.5);
        break;
      case "jaw":
        a.jaw = clamp(a.jaw - y, -0.1, 2.6);
        break;
      case "larynx":
        a.larynx = clamp(a.larynx + y, -1.6, 1.6);
        break;
      case "velum":
        a.velum = clamp(a.velum - y * 0.9, 0, 1.4);
        break;
    }
    return a;
  }
  constructor(private canvas: HTMLCanvasElement) {
    this.renderer.resize(600, 368);
  }

  setBody(body: BodyMix) {
    if (sameBody(this.model.body, body)) return;
    this.model.dispose();
    this.model = new VoiceModel(body, 48000);
  }

  lipArea(pose:HumanArtic) { return this.model.frame(pose).lipArea; }

  formantsAt(pose: HumanArtic) {
    return this.model.transfer(pose).formants;
  }

  resetTrails() {
    this.renderer = new AnatomyRenderer();
    this.renderer.resize(600, 368);
  }

  draw(
    pose: HumanArtic,
    dt = 0,
    guide?: GuideFrame,
    telemetry: TelemetryMessage | null = null,
  ) {
    const c = this.canvas,
      box = c.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = Math.min(devicePixelRatio, 2);
    const w = box.width,
      h = box.height;
    if (
      c.width !== Math.round(w * ratio) ||
      c.height !== Math.round(h * ratio)
    ) {
      c.width = Math.round(w * ratio);
      c.height = Math.round(h * ratio);
    }
    const g = c.getContext("2d")!;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const r = this.renderer;
    // Centre the sagittal projection itself; the standard renderer also reserves a readout column.
    const frame = this.model.frame(pose);
    // Travel along this rendered pose's airway, passing the narrowest oral section before the lips.
    const grid = frame.grid;
    let section = 0;
    if (this.film !== null) {
      const firstOral = Math.max(
        1,
        grid.findIndex((p) => p.s >= frame.pharynxLength),
      );
      let constriction = firstOral;
      for (
        let i = firstOral;
        i < grid.length - 2 && grid[i].s < frame.teethS;
        i++
      )
        if (grid[i].area < grid[constriction].area) constriction = i;
      const stops = [
        0,
        Math.floor(firstOral / 2),
        constriction,
        grid.length - 1,
      ];
      const phase = Math.min(this.film * 4, 3.9999);
      const i = Math.floor(phase);
      section = Math.round(
        lerp(
          stops[i],
          stops[Math.min(3, i + 1)],
          ease((phase - i - 0.3) / 0.7),
        ),
      );
    }
    const scale =
      this.film !== null
        ? Math.min(h / 175, w / 240)
        : this.closeUp
          ? Math.min(h / 194, w / 250)
          : Math.min(h / 365, w / 370);
    const center =
      this.film !== null
        ? grid[section].mid
        : this.closeUp
          ? { x: 3.7, y: 6.9 }
          : { x: 0.8, y: 0 };
    const ox = w / 2 - r.X(center) * scale;
    const oy =
      this.closeUp || this.film !== null
        ? h / 2 - r.Y(center) * scale
        : (h - 368 * scale) / 2;
    g.translate(ox, oy);
    g.scale(scale, scale);
    this.pixelsPerUnit = scale * r.pxPerCm * this.model.tract.scale;
    r.draw(
      g,
      this.model,
      frame,
      pose,
      telemetry,
      { pressure: true, particles: true, grid: false, calipers: false },
      { hover: null, drag: null, dt, formants: [], slots: [], info: [] },
    );
    if (this.manualPart) {
      this.anchors = r.handles(this.model, frame, pose).map(({ id, pos }) => {
        const x = r.X(pos),
          y = r.Y(pos);
        g.beginPath();
        g.arc(x, y, (id === this.manualPart ? 10 : 6) / scale, 0, 2 * Math.PI);
        g.fillStyle = "#0e2735";
        g.fill();
        g.strokeStyle = parts.find((part) => part.id === id)!.color;
        g.lineWidth = (id === this.manualPart ? 3 : 1.5) / scale;
        g.stroke();
        return { id, x: ox + x * scale, y: oy + y * scale };
      });
    }
    if (this.film !== null && telemetry) {
      const sample = grid[section];
      g.lineWidth = 3 / scale;
      g.strokeStyle = "#7ce3ca";
      g.beginPath();
      g.moveTo(r.X(frame.glottis), r.Y(frame.glottis));
      for (const p of grid.slice(0, section + 1))
        g.lineTo(r.X(p.mid), r.Y(p.mid));
      g.stroke();
      g.strokeStyle = "#ffc47e";
      g.beginPath();
      g.moveTo(r.X(sample.inner), r.Y(sample.inner));
      g.lineTo(r.X(sample.outer), r.Y(sample.outer));
      g.stroke();
      g.beginPath();
      g.arc(r.X(sample.mid), r.Y(sample.mid), 5 / scale, 0, Math.PI * 2);
      g.fillStyle = "#fff2bf";
      g.fill();
      const t = telemetry.t;
      const nodes = this.model.nodeS(t.phLen, t.orLen);
      let node = 0;
      for (let i = 1; i < nodes.length; i++)
        if (Math.abs(nodes[i] - sample.s) < Math.abs(nodes[node] - sample.s))
          node = i;
      this.filmReading =
        "단면 " +
        sample.area.toFixed(2) +
        " cm²  ·  압력 RMS " +
        (0.1 * t.pressureRms[node]).toFixed(1) +
        " Pa  ·  기류 " +
        t.flow[node].toFixed(1) +
        " cm³/s";
      if (t.noiseLevel > 1 && t.noiseNode >= 0) {
        const noiseS = this.model.branchS(t.noiseNode, t.phLen, t.orLen);
        if (noiseS >= 0 && Math.abs(sample.s - noiseS) < 1.5)
          this.filmReading += " · 이 부근에 난류 음원";
      }
    }
    const part = guide?.part;
    if (!guide || !part) return;
    const handles = r.handles(this.model, frame, pose);
    const anchor = (id: HandleId): Point => {
      // Grasp the moving lower edge; aperture changes can leave the lip midpoint stationary.
      const p =
        id === "lips"
          ? frame.lowerLip[6]
          : handles.find((v) => v.id === id)!.pos;
      return { x: r.X(p), y: r.Y(p) };
    };
    const here = anchor(part.id);
    const from = guide.previous
      ? anchor(guide.previous.id)
      : { x: here.x + 70, y: here.y - 58 };
    const approach = ease(guide.phase / 0.32);
    const point = {
      x: lerp(from.x, here.x, approach),
      y: lerp(from.y, here.y, approach) - 12 * Math.sin(approach * Math.PI),
    };
    const held = guide.phase >= 0.32 && guide.phase < 0.84;
    g.strokeStyle = part.color;
    g.lineWidth = held ? 2.6 : 1.4;
    g.beginPath();
    g.arc(here.x, here.y, held ? 11 : 15, 0, 2 * Math.PI);
    g.stroke();
    if (held) {
      g.fillStyle = part.color + "35";
      g.fill();
    }
    g.save();
    g.translate(point.x, point.y);
    // Keep the pointer and its label the same screen size in the magnified mouth view.
    g.scale(1 / scale, 1 / scale);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(2, 23);
    g.lineTo(8, 17);
    g.lineTo(14, 26);
    g.lineTo(19, 23);
    g.lineTo(13, 14);
    g.lineTo(22, 13);
    g.closePath();
    g.fillStyle = held ? part.color : "#f5faff";
    g.strokeStyle = "#10202c";
    g.lineWidth = 2.2;
    g.stroke();
    g.fill();
    if (held) {
      g.font = "600 13px system-ui";
      const length = g.measureText(part.name).width + 14;
      g.fillStyle = "#10212e";
      g.fillRect(20, 16, length, 23);
      g.fillStyle = part.color;
      g.fillText(part.name, 27, 32);
    }
    g.restore();
  }
}
