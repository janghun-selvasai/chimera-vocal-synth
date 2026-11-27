import { expect, test } from "bun:test";
import { initEngine } from "./harness.ts";
await initEngine();
const { synthesize, playbackAt, validateInput } =
  await import("../src/korean/synthesize.ts");
const { guideFrame, movingParts, STEP_SECONDS } =
  await import("../src/korean/poseGuide.ts");
const { ARTIC_KEYS, NEUTRAL } = await import("../src/wasm/engine.ts");

test("the Korean timeline preserves the tense sibilant after planning", async () => {
  const signal = new AbortController().signal;
  const take = await synthesize("살과 쌀이 달라요.", false, signal);
  const sibilants = take.segments.filter(s => s.ipa === "s");
  expect(sibilants.map(s => s.displayIpa ?? s.ipa)).toEqual(["s", "s͈"]);
  const prepared = await synthesize("씨", true, signal);
  expect(prepared.first).toBe("ɕ͈");
});

test("a prepared word starts at its measured first PCM pose and keeps the whole initial consonant", async () => {
  const signal = new AbortController().signal;
  const bul = await synthesize("불", true, signal);
  const dal = await synthesize("달", true, signal);
  expect(bul.segments.map((s) => s.ipa)).toEqual(["p", "u", "l"]);
  expect(dal.first).toBe("t");
  expect(bul.segments[0].start).toBeGreaterThanOrEqual(0);
  expect(bul.segments[0].end - bul.segments[0].start).toBeGreaterThan(0.07);
  expect(playbackAt(bul, 0).pose.lipAp).toBeLessThan(NEUTRAL.lipAp - 0.2);
  expect(playbackAt(dal, 0).pose.ttY).toBeGreaterThan(
    playbackAt(bul, 0).pose.ttY + 0.1,
  );
  for (const word of [bul, dal]) {
    const target = playbackAt(word, 0).pose,
      parts = movingParts(target);
    const initial = guideFrame(target, parts, 0),
      final = guideFrame(target, parts, STEP_SECONDS * parts.length);
    for (const key of ARTIC_KEYS) {
      expect(initial.pose[key]).toBeCloseTo(NEUTRAL[key], 5);
      expect(final.pose[key]).toBeCloseTo(target[key], 5);
    }
    expect(word.samples.every(Number.isFinite)).toBe(true);
    expect(word.samples.some((s) => Math.abs(s) > 0.01)).toBe(true);
  }
});

test("each Korean voice renders its own tract flow, pressure and voiced pitch on the PCM clock", async () => {
  const pitches: number[] = [],
    lengths: number[] = [];
  for (const voice of ["male", "female", "child"] as const) {
    const take = await synthesize(
      "아",
      false,
      new AbortController().signal,
      voice,
    );
    const duration = take.samples.length / take.rate;
    const samplesPerFrame = take.rate * 0.01;
    expect(take.frames.length).toBe(
      1 + Math.ceil(take.samples.length / samplesPerFrame),
    );
    expect(playbackAt(take, duration).telemetry).toBe(take.frames.at(-1)!);
    const vowel = take.segments[0];
    const t = (vowel.start + vowel.end) / 2;
    const frame = playbackAt(take, t).telemetry;
    expect(frame.t.clock).toBeCloseTo(Math.floor(t * 100) / 100, 5);
    expect(frame.t.flow.length).toBe(frame.nPh + frame.nOr);
    expect(frame.t.pressureRms.length).toBe(frame.t.flow.length);
    expect(frame.t.flow.some((u) => Math.abs(u) > 1)).toBe(true);
    expect(Math.max(...frame.t.pressureRms)).toBeGreaterThan(0);
    pitches.push(frame.t.f0);
    lengths.push(frame.t.phLen + frame.t.orLen);
  }
  expect(pitches[1]).toBeGreaterThan(pitches[0] * 1.4);
  expect(pitches[2]).toBeGreaterThan(pitches[1] * 1.3);
  expect(lengths[1]).toBeLessThan(lengths[0]);
  expect(lengths[2]).toBeLessThan(lengths[1]);
});

test("dropping one studio view keeps a second view of the same tract usable", async () => {
  const { VoiceModel } = await import("../src/ui/analysis.ts");
  const { PRESETS } = await import("../src/ui/body.ts");
  const first = new VoiceModel(PRESETS.male, 48000);
  const second = new VoiceModel(PRESETS.male, 48000);
  first.dispose();
  try {
    expect(second.transfer(NEUTRAL).formants.length).toBeGreaterThanOrEqual(2);
  } finally {
    second.dispose();
  }
});

test("reference pitch steers the source without altering the next stock utterance", async () => {
  const signal = new AbortController().signal;
  const stock = await synthesize("부", false, signal);
  const candidate = await synthesize("부", false, signal, "male", { f0: 185, brightness: 0.4 });
  const stockAgain = await synthesize("부", false, signal);
  const vowel = stock.segments[1];
  const middle = (vowel.start + vowel.end) / 2;
  expect(playbackAt(candidate, middle).telemetry.t.f0).toBeGreaterThan(playbackAt(stock, middle).telemetry.t.f0 * 1.4);
  expect(stockAgain.samples).toEqual(stock.samples);
});

test("free text uses Korean phonology and can be cancelled before playback", async () => {
  const sentence = await synthesize(
    "같이 먹어?",
    false,
    new AbortController().signal,
  );
  expect(sentence.segments.map((s) => s.ipa).join("")).toContain("mʌgʌ");
  expect(validateInput("  같이 먹어? ".normalize("NFD"), false)).toBe(
    "같이 먹어?",
  );
  expect(() => validateInput("두 단어", true)).toThrow();
  expect(() => validateInput("한글123", false)).toThrow();
  expect(() => validateInput("...", false)).toThrow();
  const control = new AbortController();
  control.abort();
  await expect(synthesize("먹어", true, control.signal)).rejects.toThrow();
});
