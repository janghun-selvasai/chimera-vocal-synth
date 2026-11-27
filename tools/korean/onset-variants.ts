/** Independent interventions for the frozen free-text study. All controls act on phoneme classes. */
import type {
  ArticKey,
  Gesture,
  Plan,
  VoiceSource,
} from "../../src/wasm/types.ts";
import type { BodyName } from "../../src/worklet/protocol.ts";
import { VoiceModel } from "../../src/ui/analysis.ts";
import { PRESETS } from "../../src/ui/body.ts";
const controls: Record<string, string[]> = {
  ending: ["seal", "vowel", "medialPitch", "resonance", "ending"],
  protected: ["seal", "vowel", "medialPitch", "resonance", "protect"],
  balanced: ["seal", "vowel", "medialPitch", "resonance", "phrasing"],
  transitions: ["seal", "vowel", "medialPitch"],
  brief: ["brief"],
  focused: ["seal", "brief", "vowel", "phrasing", "resonance"],
  soft: ["soft"],
  medialPitch: ["medialPitch"],
  medialFlow: ["medialFlow"],
  contrast: ["seal", "vowel", "soft", "medialPitch", "medialFlow"],
  resonance: ["resonance"],
  phrasing: ["phrasing"],
  revised: [
    "seal",
    "vowel",
    "soft",
    "medialPitch",
    "medialFlow",
    "resonance",
    "phrasing",
  ],
  baseline: [],
  seal: ["seal"],
  lip: ["lip"],
  fold: ["fold"],
  vowel: ["vowel"],
  combined: ["seal", "lip", "fold", "vowel"],
  speaker: ["speaker"],
  rhythm: ["rhythm"],
  calibrated: ["seal", "speaker", "rhythm"],
  coordination: ["seal", "fold", "vowel"],
};
function enabled(variant: string, key: string) {
  if (!(variant in controls)) throw Error("Unknown condition " + variant);
  return controls[variant].includes(key);
}
export function candidateSource(
  variant: string,
  voice: BodyName,
  preset: VoiceSource,
) {
  if (!enabled(variant, "speaker"))
    return { f0: preset.f0, brightness: preset.brightness };
  const offset = { male: 3, female: 0.8, child: 0 }[voice];
  return {
    f0: preset.f0 * 2 ** (offset / 12),
    brightness: { male: 0.25, female: 0.18, child: 0.19 }[voice],
  };
}
export function candidatePlan(
  variant: string,
  input: Plan,
  voice: BodyName,
  text: string,
): Plan {
  if (variant === "baseline") return input;
  const gestures = input.gestures.map((g) => ({
    ...g,
    targets: { ...g.targets },
  }));
  for (const [i, stop] of input.segments.entries()) {
    if (
      !["p", "b"].includes(stop.ipa) ||
      input.segments[i + 1]?.kind !== "vowel"
    )
      continue;
    const cluster = gestures.filter(
      (g) =>
        g.t0 <= stop.t1 + 0.001 && g.t1 >= stop.t0 && g.t0 >= stop.t0 - 0.1,
    );
    const lip = cluster.find(
      (g) =>
        g.label === stop.ipa &&
        (g.targets.lipAp ?? 0) < 0 &&
        Object.keys(g.targets).length === 1,
    );
    if (!lip) continue;
    if (
      enabled(variant, "seal") &&
      (i === 0 || stop.t0 - input.segments[i - 1].t1 > 0.1)
    ) {
      // Seal during the silent lead-in, before lung pressure rises. Preserve the release boundary.
      lip.t0 = Math.max(0, stop.t0 - 0.125);
      lip.rampIn = 0.01;
    }
    const medial =
      stop.ipa === "b" &&
      input.segments[i - 1]?.kind === "vowel" &&
      stop.t0 - input.segments[i - 1].t1 < 0.025;
    if (medial && enabled(variant, "brief")) {
      const span = lip.t1 - lip.t0;
      lip.t0 += Math.min(0.029, 0.34 * span);
      lip.t1 -= Math.min(0.018, 0.22 * span);
      lip.targets.lipAp = -0.12;
    }
    if (medial && enabled(variant, "soft")) {
      lip.t0 = Math.min(lip.t1 - 0.018, lip.t0 + 0.018);
      lip.targets.lipAp = -0.12;
    }
    if (
      medial &&
      (enabled(variant, "medialPitch") || enabled(variant, "medialFlow"))
    ) {
      const targets: Gesture["targets"] = {};
      if (enabled(variant, "medialPitch")) targets.pitchSt = -2.0;
      if (enabled(variant, "medialFlow")) targets.abduction = 0.055;
      gestures.push({
        label: "lenis transition",
        t0: stop.t1 - 0.012,
        t1: stop.t1 + 0.024,
        rampIn: 0.016,
        rampOut: 0.038,
        strength: 2,
        targets,
      });
    }
    const tense = stop.displayIpa?.includes("͈"),
      aspirated = stop.displayIpa?.includes("ʰ");
    if (enabled(variant, "lip") && tense) lip.t1 -= 0.008;
    if (enabled(variant, "fold")) {
      const fold = cluster.find(
        (g) => g.label === (tense ? "fortis adduction" : "aspiration"),
      );
      if (fold && (tense || aspirated)) fold.t1 -= tense ? 0.007 : 0.012;
    }
    if (enabled(variant, "vowel")) {
      const press = cluster.find((g) => g.label === "pressed release");
      if (press && tense) press.targets.press = 0.55;
      const pitch = cluster.find((g) => g.label === "release pitch");
      if (pitch && aspirated)
        pitch.targets.pitchSt = (pitch.targets.pitchSt ?? 0) + 1.5;
    }
  }
  if (enabled(variant, "speaker")) {
    // Retract and round the /ʌ/ gesture slightly; compare its output LPC poles across voices.
    for (const g of gestures.filter(
      (g) => g.label === "ʌ" && g.targets.tbX !== undefined,
    )) {
      g.targets.tbX! -= 0.22;
      g.targets.lipProt = (g.targets.lipProt ?? 0) + 0.16;
    }
  }
  if (enabled(variant, "resonance") && gestures.some((g) => g.label === "ʌ")) {
    const model = new VoiceModel(PRESETS[voice], 48000);
    try {
      const target = (
        { male: [500, 970], female: [770, 1140], child: [555, 1100] } as const
      )[voice];
      const pose = model.articForFormants(target[0], target[1]);
      for (const g of gestures.filter((g) => g.label === "ʌ"))
        for (const key of Object.keys(pose) as ArticKey[])
          if (g.targets[key] !== undefined && pose[key] !== undefined)
            g.targets[key]! += 0.4 * (pose[key]! - g.targets[key]!);
    } finally {
      model.dispose();
    }
  }
  const plan = { ...input, gestures };
  if (
    (enabled(variant, "phrasing") ||
      enabled(variant, "protect") ||
      enabled(variant, "ending")) &&
    /[?？]\s*$/u.test(text)
  ) {
    const vowels = plan.segments.filter((s) => s.kind === "vowel");
    if (vowels.length < 3) return plan;
    const compressible = vowels.filter((v, index) => {
      if (enabled(variant, "ending")) return index >= vowels.length - 2;
      if (!enabled(variant, "protect")) return true;
      const i = plan.segments.indexOf(v);
      return ![plan.segments[i - 1], plan.segments[i + 1]].some(
        (s) => s && ["p", "b"].includes(s.ipa),
      );
    });
    const spans = compressible.map((v) => ({
      start: v.t0 + Math.min(0.085, (v.t1 - v.t0) * 0.55),
      end: v.t1,
    }));
    const map = (t: number) =>
      t -
      0.48 *
        spans.reduce(
          (total, s) => total + Math.max(0, Math.min(t, s.end) - s.start),
          0,
        );
    const last = vowels.at(-1)!;
    const final = gestures
      .filter(
        (g) => g.label === "pitch" && g.targets.f0 && g.t0 >= last.t0 - 0.06,
      )
      .at(-1);
    if (final)
      final.targets.f0! *= { male: 0.98, female: 0.84, child: 0.9 }[voice];
    if (enabled(variant, "ending") && voice !== "male") {
      const d = last.t1 - last.t0;
      gestures.push({
        label: "question tail",
        targets: { pitchSt: voice === "female" ? -2.5 : 1 },
        t0: last.t0 + 0.78 * d,
        t1: last.t1,
        rampIn: 0.3 * d,
        rampOut: 0.025,
        strength: 1,
      });
    }
    return {
      segments: plan.segments.map((s) => ({
        ...s,
        t0: map(s.t0),
        t1: map(s.t1),
      })),
      gestures: gestures.map((g) => ({
        ...g,
        t0: map(g.t0),
        t1: map(g.t1),
        rampIn: map(g.t0) - map(g.t0 - g.rampIn),
        rampOut: map(g.t1 + g.rampOut) - map(g.t1),
        releaseHold:
          g.releaseHold === undefined
            ? undefined
            : map(g.t1 + g.releaseHold) - map(g.t1),
      })),
      end: map(plan.end),
    };
  }
  if (
    !enabled(variant, "rhythm") ||
    !/[?？]\s*$/u.test(text) ||
    input.segments.filter((s) => s.kind === "vowel").length < 3
  )
    return plan;
  const last = input.segments.at(-1)!;
  const floor = input.segments[0].t0;
  const factor = { male: 0.8, female: 0.82, child: 0.77 }[voice];
  const time = (t: number) => (t <= floor ? t : floor + (t - floor) * factor);
  const endPitch = gestures
    .filter(
      (g) =>
        g.label === "pitch" &&
        g.targets.f0 !== undefined &&
        g.t0 >= last.t0 - 0.06,
    )
    .at(-1);
  if (endPitch)
    endPitch.targets.f0! *= { male: 0.97, female: 0.81, child: 0.88 }[voice];
  const warp = (g: Gesture) => ({
    ...g,
    t0: time(g.t0),
    t1: time(g.t1),
    rampIn: time(g.t0) - time(g.t0 - g.rampIn),
    rampOut: time(g.t1 + g.rampOut) - time(g.t1),
    releaseHold:
      g.releaseHold === undefined
        ? undefined
        : time(g.t1 + g.releaseHold) - time(g.t1),
    speed: (g.speed ?? 1) / factor,
  });
  return {
    segments: input.segments.map((s) => ({
      ...s,
      t0: time(s.t0),
      t1: time(s.t1),
    })),
    gestures: gestures.map(warp),
    end: time(plan.end),
  };
}
