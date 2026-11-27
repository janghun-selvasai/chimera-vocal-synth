/** Internal batch renderer used by reference_fit.py. All sound comes from the studio WASM. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initEngine } from "../../tests/harness.ts";
import type {
  ArticKey,
  HumanArtic,
  BodyMix,
  Plan,
} from "../../src/wasm/types.ts";
import type { BodyName } from "../../src/worklet/protocol.ts";
await initEngine();
const { synthesize } = await import("../../src/korean/synthesize.ts");
const { VoiceModel } = await import("../../src/ui/analysis.ts");
const { PRESETS } = await import("../../src/ui/body.ts");

interface Fit {
  f0: number;
  brightness?: number;
  body?: BodyMix;
  time?: [number, number][];
  pitch?: [number, number][];
  aspirationShift?: number;
  preclose?: boolean;
  adaptSpeed?: boolean;
  vowels?: Record<string, [number, number]>;
  vowelMix?: number;
}
interface Job {
  id: string;
  text: string;
  voice: BodyName;
  fit?: Fit;
  /** Vowel segment index and measured onset in a connected-speech reference take. */
  lowerOnset?: { vowel: number; at: number };
}

function adjust(
  plan: Plan,
  fit: Fit,
  poses: Record<string, Partial<HumanArtic>>,
): Plan {
  const knots = fit.time!;
  function warp(t: number): number {
    const right = knots.findIndex(([x]) => x > t);
    if (right === 0) return knots[0][1] + t - knots[0][0];
    if (right === -1) {
      const [x, y] = knots[knots.length - 1];
      return y + t - x;
    }
    const [a, b] = knots[right - 1],
      [c, d] = knots[right];
    return b + ((t - a) * (d - b)) / (c - a);
  }
  const gestures: Plan["gestures"] = plan.gestures.flatMap((g) => {
    const targets = { ...g.targets };
    const goal = poses[g.label ?? ""];
    if (goal) {
      for (const key of Object.keys(goal) as ArticKey[]) {
        if (targets[key] !== undefined)
          targets[key] += (fit.vowelMix ?? 0) * (goal[key]! - targets[key]);
      }
    }
    if (fit.pitch?.length) {
      delete targets.f0;
      delete targets.pitchSt;
    }
    if (!Object.keys(targets).length) return [];
    const t0 = warp(g.t0),
      t1 = warp(g.t1);
    const shift = g.label === "aspiration" ? (fit.aspirationShift ?? 0) : 0;
    const preclose =
      fit.preclose && g.label === "p" && targets.lipAp !== undefined;
    return [
      {
        ...g,
        targets,
        t0: preclose ? 0 : t0,
        speed: fit.adaptSpeed
          ? (g.speed ?? 1) *
            Math.max(1, Math.min(2.5, (g.t1 - g.t0) / Math.max(0.005, t1 - t0)))
          : g.speed,
        t1: Math.max(t0, t1 + shift),
        rampIn: preclose ? 0 : t0 - warp(g.t0 - g.rampIn),
        rampOut: warp(g.t1 + g.rampOut) - t1,
        releaseHold:
          g.releaseHold === undefined
            ? undefined
            : warp(g.t1 + g.releaseHold) - t1,
      },
    ];
  });
  // The measured contour includes the release pitch cue and question intonation.
  for (const [t, hz] of fit.pitch ?? []) {
    gestures.push({
      t0: t - 0.01,
      t1: t + 0.01,
      rampIn: 0.02,
      rampOut: 0.02,
      targets: { f0: hz },
      strength: 5,
      label: "reference pitch",
      releaseHold: undefined,
    });
  }
  return {
    end: warp(plan.end),
    gestures,
    segments: plan.segments.map((s) => ({
      ...s,
      t0: warp(s.t0),
      t1: warp(s.t1),
    })),
  };
}

const [jobsFile, out] = process.argv.slice(2);
const jobs: Job[] = JSON.parse(readFileSync(jobsFile, "utf8"));
for (const { id, text, voice, fit, lowerOnset } of jobs) {
  const poses: Record<string, Partial<HumanArtic>> = {};
  if (fit?.vowels) {
    const model = new VoiceModel(fit.body ?? PRESETS[voice], 48000);
    try {
      for (const [ipa, [f1, f2]] of Object.entries(fit.vowels))
        poses[ipa] = model.articForFormants(f1, f2);
    } finally {
      model.dispose();
    }
  }
  const take = await synthesize(
    text,
    false,
    new AbortController().signal,
    voice,
    fit && {
      ...fit,
      shapePlan: (original) => {
        const plan = fit.time ? adjust(original, fit, poses) : original;
        if (!lowerOnset) return plan;
        const { vowel, at } = lowerOnset;
        const stop = plan.segments[vowel - 1],
          u = plan.segments[vowel];
        if (
          !stop ||
          !["p", "b"].includes(stop.ipa) ||
          u?.ipa !== "u" ||
          at < u.t0 ||
          at + 0.06 > u.t1
        ) {
          throw new Error(
            "Expected the voiced onset inside the target /u/ after a labial stop",
          );
        }
        const hold = Math.max(stop.t0, at - 0.02);
        return {
          ...plan,
          gestures: [
            ...plan.gestures,
            {
              t0: hold,
              t1: at + 0.015,
              rampIn: Math.min(0.065, hold - stop.t0),
              rampOut: 0.045,
              strength: 1,
              targets: { pitchSt: -3 },
              label: "target onset pitch",
            },
          ],
        };
      },
    },
  );
  // The driver reads lossless little-endian float PCM, then writes the listening WAV once.
  writeFileSync(join(out, id + ".f32"), Buffer.from(take.samples.buffer));
  writeFileSync(
    join(out, id + ".json"),
    JSON.stringify({ rate: take.rate, segments: take.segments }),
  );
}
