import { expect, test } from "bun:test";
import { initEngine } from "./harness.ts";
await initEngine();
const { synthesize, poseAt, validateInput } =
  await import("../src/korean/synthesize.ts");
const { guideFrame, movingParts, STEP_SECONDS } =
  await import("../src/korean/poseGuide.ts");
const { ARTIC_KEYS, NEUTRAL } = await import("../src/wasm/engine.ts");

test("a prepared word starts at its measured first PCM pose and keeps the whole initial consonant", async () => {
  const signal = new AbortController().signal;
  const bul = await synthesize("불", true, signal);
  const dal = await synthesize("달", true, signal);
  expect(bul.segments.map((s) => s.ipa)).toEqual(["p", "u", "l"]);
  expect(dal.first).toBe("t");
  expect(bul.segments[0].start).toBeGreaterThanOrEqual(0);
  expect(bul.segments[0].end - bul.segments[0].start).toBeGreaterThan(0.07);
  expect(bul.poses[0].lipAp).toBeLessThan(NEUTRAL.lipAp - 0.2);
  expect(dal.poses[0].ttY).toBeGreaterThan(bul.poses[0].ttY + 0.1);
  for (const word of [bul, dal]) {
    const target = word.poses[0],
      parts = movingParts(target);
    const initial = guideFrame(target, parts, 0),
      final = guideFrame(target, parts, STEP_SECONDS * parts.length);
    for (const key of ARTIC_KEYS) {
      expect(initial.pose[key]).toBeCloseTo(NEUTRAL[key], 5);
      expect(final.pose[key]).toBeCloseTo(poseAt(word, 0)[key], 5);
    }
    expect(word.samples.every(Number.isFinite)).toBe(true);
    expect(word.samples.some((s) => Math.abs(s) > 0.01)).toBe(true);
  }
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
