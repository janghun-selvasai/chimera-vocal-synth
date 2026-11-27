import { call, chimeraModule } from "../wasm/chimera.ts";
import {
  activation,
  ARTIC_KEYS,
  koreanPhrases,
  planPhrases,
  type Gesture,
  type HumanArtic,
  type VoiceSource,
  type Plan,
  type BodyMix,
} from "../wasm/engine.ts";
import { writeGestures } from "../wasm/wire.ts";
import { VoiceModel } from "../ui/analysis.ts";
import { PRESETS } from "../ui/body.ts";
import type { BodyName, TelemetryMessage } from "../worklet/protocol.ts";
import {
  decodeTelemetry,
  TELE_HEADER,
  TELE_LABELS,
  telemetryLength,
} from "../worklet/telemetry.ts";

const RATE = 48000;
const STRIDE = 480; // One model pose per 10 ms of the actual output.
// The CLI's "clear" condition and both studio views use the same source preset.
type VoiceExports = { memory: WebAssembly.Memory } & Record<
  string,
  (...args: number[]) => number
>;

export interface Utterance {
  samples: Float32Array<ArrayBuffer>;
  rate: number;
  frames: TelemetryMessage[];
  first: string;
  segments: { ipa: string; displayIpa?: string; kind: string; start: number; end: number }[];
}

export function validateInput(input: string, single: boolean): string {
  const text = input.normalize("NFC").trim();
  if (!/[가-힣]/u.test(text)) throw new Error("읽을 한글을 입력해 주세요.");
  if (single && !/^[가-힣]+$/u.test(text))
    throw new Error("띄어쓰기와 문장부호 없이 한 단어를 입력해 주세요.");
  if (/[^가-힣\s\p{P}]/u.test(text))
    throw new Error("숫자와 영문은 한글로 풀어 써 주세요.");
  return text;
}

// Hold just the first phoneme's active articulatory gestures in advance. Breath, pitch
// and noise start on the original score. This retains the complete initial consonant.
function prepareGestures(
  gestures: Gesture[],
  probe: number,
  until: number,
): Gesture[] {
  const result: Gesture[] = [];
  for (const g of gestures) {
    const weight = activation(g, probe);
    if (weight <= 0) continue;
    const targets: Partial<HumanArtic> = {};
    for (const key of ARTIC_KEYS)
      if (g.targets[key] !== undefined) targets[key] = g.targets[key];
    if (Object.keys(targets).length)
      result.push({
        targets,
        t0: 0,
        t1: until,
        rampIn: 0,
        rampOut: 0.025,
        strength: g.strength * weight,
        speed: g.speed,
        label: "prepare",
      });
  }
  return result;
}

/** Optional controls for reconstructing a recorded utterance with the physical model. */
export interface ReferenceControls {
  f0: number;
  brightness?: number;
  body?: BodyMix;
  shapePlan?: (plan: Plan) => Plan;
}

export async function synthesize(
  text: string,
  prepare: boolean,
  signal: AbortSignal,
  voice: BodyName = "male",
  reference?: ReferenceControls,
  condition: "clear" | "adducted" = "clear",
): Promise<Utterance> {
  const body = reference?.body ?? PRESETS[voice];
  const profile = call<VoiceSource>("koSpeaker", { body: voice });
  const f0 = reference?.f0 ?? profile.f0;
  const phrases = koreanPhrases(text, condition);
  const original = planPhrases(phrases, {
    body,
    t0: prepare ? 0.3 : 0.08,
    f0,
  });
  const plan = reference?.shapePlan?.(original) ?? original;
  const first = plan.segments[0];
  if (!first) throw new Error("발음할 수 있는 한글을 입력해 주세요.");
  const gestures = [...plan.gestures];
  let skip = 0;
  if (prepare) {
    const voicedControls = plan.gestures.filter((g) =>
      Object.keys(g.targets).some(
        (k) => !ARTIC_KEYS.includes(k as keyof HumanArtic),
      ),
    );
    const acousticStart = Math.min(
      first.t0,
      ...voicedControls.map((g) => g.t0 - g.rampIn),
    );
    skip = Math.max(0, Math.floor(acousticStart * RATE));
    const probe = first.t0 + Math.min(0.045, (first.t1 - first.t0) * 0.45);
    gestures.unshift(...prepareGestures(plan.gestures, probe, first.t0));
  }
  if (gestures.length > 4000)
    throw new Error("문장이 깁니다. 두 문장으로 나누어 읽어 주세요.");
  signal.throwIfAborted();
  const x = new WebAssembly.Instance(chimeraModule(), {})
    .exports as unknown as VoiceExports;
  const h = x.engine_new(RATE);
  try {
    if (body.female || body.child) x.engine_set_body(h, body.female, body.child);
    const source = new Float64Array(
      x.memory.buffer,
      x.engine_values(h),
      32,
    ).fill(NaN);
    source[0] = f0;
    source[2] = profile.pressure;
    source[11] = reference?.brightness ?? profile.brightness;
    x.engine_set_source(h);
    const count = writeGestures(
      x.memory.buffer,
      x.engine_records(h),
      gestures,
      4000,
    );
    x.engine_schedule(h, count, 0, 0);
    // Stop precisely at the first retained PCM sample; frame zero is the handoff pose.
    for (let n = 0; n < skip; n += STRIDE)
      x.engine_render(h, Math.min(STRIDE, skip - n));
    const timeOffset = skip / RATE;
    const samples = new Float32Array(
      Math.ceil((plan.end + 0.16) * RATE) - skip,
    );
    const readFrame = (): TelemetryMessage => {
      const p = x.engine_telemetry(h);
      const memory = x.memory.buffer;
      const length = telemetryLength(new Float64Array(memory, p, TELE_HEADER));
      const frame = decodeTelemetry(
        new Float64Array(memory, p, length),
        new Uint8Array(memory, x.engine_tele_labels(h), TELE_LABELS),
      );
      return { ...frame, type: "telemetry", body, load: 0, beatStep: -1 };
    };
    const frames = [readFrame()];
    let lastYield = performance.now();
    for (let i = 0; i < samples.length; i += STRIDE) {
      const size = Math.min(STRIDE, samples.length - i);
      const p = x.engine_render(h, size);
      samples.set(new Float32Array(x.memory.buffer, p, size), i);
      frames.push(readFrame());
      if (performance.now() - lastYield > 14) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
        lastYield = performance.now();
      }
    }
    return {
      samples,
      rate: RATE,
      frames,
      first: first.displayIpa ?? first.ipa,
      segments: plan.segments.map((s) => ({
        ipa: s.ipa,
        displayIpa: s.displayIpa,
        kind: s.kind,
        start: s.t0 - timeOffset,
        end: s.t1 - timeOffset,
      })),
    };
  } finally {
    x.engine_free(h);
  }
}

/** Interpolate the pose on the PCM clock. Flow and pressure use the most recent measured frame. */
export function playbackAt(take: Utterance, seconds: number) {
  const sample = Math.min(
    take.samples.length,
    Math.max(0, seconds * take.rate),
  );
  const i =
    sample >= take.samples.length
      ? take.frames.length - 1
      : Math.floor(sample / STRIDE);
  const telemetry = take.frames[i];
  const pose = VoiceModel.articFromArray(telemetry.t.artic);
  const next = take.frames[i + 1];
  if (next) {
    const span = Math.min(STRIDE, take.samples.length - i * STRIDE);
    const fraction = (sample - i * STRIDE) / span;
    ARTIC_KEYS.forEach((key, j) => {
      pose[key] += (next.t.artic[j] - pose[key]) * fraction;
    });
  }
  return { telemetry, pose };
}
