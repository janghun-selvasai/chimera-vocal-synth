import { chimeraModule } from "../wasm/chimera.ts";
import {
  activation,
  ARTIC_KEYS,
  koreanPhrases,
  planPhrases,
  type Gesture,
  type HumanArtic,
} from "../wasm/engine.ts";
import { writeGestures } from "../wasm/wire.ts";
import { VoiceModel } from "../ui/analysis.ts";
import { TELE_HEADER } from "../worklet/telemetry.ts";

const RATE = 48000;
const STRIDE = 480; // One model pose per 10 ms of the actual output.
const BODY = { female: 0, child: 0 };
type VoiceExports = { memory: WebAssembly.Memory } & Record<
  string,
  (...args: number[]) => number
>;

export interface Utterance {
  samples: Float32Array<ArrayBuffer>;
  rate: number;
  poses: HumanArtic[];
  first: string;
  segments: { ipa: string; start: number; end: number }[];
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

export async function synthesize(
  text: string,
  prepare: boolean,
  signal: AbortSignal,
): Promise<Utterance> {
  const phrases = koreanPhrases(text);
  const plan = planPhrases(phrases, {
    body: BODY,
    t0: prepare ? 0.3 : 0.08,
    f0: 112,
  });
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
    const source = new Float64Array(
      x.memory.buffer,
      x.engine_values(h),
      32,
    ).fill(NaN);
    source[0] = 112;
    source[2] = 7.2;
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
    const poses: HumanArtic[] = [];
    const readPose = () => {
      const p = x.engine_telemetry(h) + 8 * TELE_HEADER;
      return VoiceModel.articFromArray(
        new Float64Array(x.memory.buffer, p, ARTIC_KEYS.length),
      );
    };
    poses.push(readPose());
    let lastYield = performance.now();
    for (let i = 0; i < samples.length; i += STRIDE) {
      const size = Math.min(STRIDE, samples.length - i);
      const p = x.engine_render(h, size);
      samples.set(new Float32Array(x.memory.buffer, p, size), i);
      poses.push(readPose());
      if (performance.now() - lastYield > 14) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
        lastYield = performance.now();
      }
    }
    return {
      samples,
      rate: RATE,
      poses,
      first: first.ipa,
      segments: plan.segments.map((s) => ({
        ipa: s.ipa,
        start: s.t0 - timeOffset,
        end: s.t1 - timeOffset,
      })),
    };
  } finally {
    x.engine_free(h);
  }
}

export function poseAt(utterance: Utterance, seconds: number): HumanArtic {
  const index = Math.max(0, (seconds * RATE) / STRIDE);
  const i = Math.min(Math.floor(index), utterance.poses.length - 1);
  const a = utterance.poses[i],
    b = utterance.poses[i + 1];
  if (!b) return a;
  const pose = { ...a };
  for (const key of ARTIC_KEYS) pose[key] += (b[key] - a[key]) * (index - i);
  return pose;
}
