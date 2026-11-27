import { expect, test } from "bun:test";
import { initEngine, WasmVoice } from "./harness.ts";
import type { Gesture } from "../src/wasm/types.ts";

await initEngine();
const { koreanPhrases, planPhrases } = await import("../src/wasm/engine.ts");

test("adducting before the first Korean fortis closure suppresses audible pre-roll", () => {
  function measure(condition: "clear" | "adducted") {
    const plan = planPhrases(koreanPhrases("뿔", condition), { body: { female: 0, child: 0 }, t0: 0.05, f0: 112 });
    const voice = new WasmVoice();
    voice.setSource({ f0: 112 });
    voice.schedule(plan.gestures, 0);
    const [stop, vowel] = plan.segments;
    const pcm = voice.render(Math.ceil(vowel.t1 * voice.fs));
    const peak = (start: number, end: number) =>
      pcm.subarray(Math.round(start * voice.fs), Math.round(end * voice.fs))
        .reduce((p, x) => Math.max(p, Math.abs(x)), 0);
    const steady = peak(vowel.t0 + 0.07, vowel.t0 + 0.12);
    expect(steady).toBeGreaterThan(0.001);
    return peak(0, stop.t0) / steady;
  }
  expect(measure("adducted")).toBeLessThan(measure("clear") / 2);
});

test("the worklet gesture record carries both Korean release controls into the voice", () => {
  const plan = planPhrases(koreanPhrases("뿔"), { body: { female: 0, child: 0 }, t0: 0.05, f0: 112 });
  function render(gestures: Gesture[]) {
    const voice = new WasmVoice();
    voice.setSource({ f0: 112 });
    voice.schedule(gestures, 0);
    return { score: voice.score(), audio: voice.render(18000) };
  }
  const full = render(plan.gestures);
  expect(full.score.find(g => g.label === "pressed release")?.targets.press).toBe(1);
  expect(full.score.find(g => g.label === "release pitch")?.targets.pitchSt).toBe(1.5);
  for (const label of ["pressed release", "release pitch"]) {
    const other = render(plan.gestures.filter(g => g.label !== label));
    const changed = full.audio.some((s,i) => Math.abs(s-other.audio[i]) > 0.001);
    expect(changed).toBe(true);
  }
});
