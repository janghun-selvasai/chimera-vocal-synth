/** Render the frozen onset corpus through the exact free-text studio path. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initEngine } from "../../tests/harness.ts";
import { writeWav } from "../lib/wav.ts";
import type { BodyName } from "../../src/worklet/protocol.ts";
import type { Plan, VoiceSource } from "../../src/wasm/types.ts";
await initEngine();
const { synthesize } = await import("../../src/korean/synthesize.ts");
const { call } = await import("../../src/wasm/chimera.ts");
const { PRESETS } = await import("../../src/ui/body.ts");
const { VoiceModel } = await import("../../src/ui/analysis.ts");
const { candidatePlan, candidateSource } = await import("./onset-variants.ts");

const [root, variant, split] = process.argv.slice(2);
if (!root || !variant || !["development", "holdout"].includes(split))
  throw Error("Usage: onset-render.ts root variant development|holdout");
const corpus = JSON.parse(
  readFileSync("docs/korean-speech/onset-study.json", "utf8"),
);
const rows: { id: string; text: string }[] = [];
for (const [i, word] of (corpus.words as string[]).entries()) {
  if (split === "development")
    rows.push(
      { id: "word" + i, text: word },
      { id: "dev" + i, text: corpus.development.replace("{}", word) },
    );
  else rows.push({ id: "test" + i, text: corpus.holdout.replace("{}", word) });
}
if (split === "development")
  rows.push({ id: "question", text: corpus.question });
else
  [...corpus.transfer, ...corpus.guards].forEach((text: string, i: number) =>
    rows.push({ id: "extra" + i, text }),
  );
const dir = join(root, variant);
mkdirSync(dir, { recursive: true });
for (const voice of corpus.voices as BodyName[]) {
  const preset = call<VoiceSource>("koSpeaker", { body: voice });
  const profile = candidateSource(
    variant === "studio" ? "baseline" : variant,
    voice,
    preset,
  );
  const model = new VoiceModel(PRESETS[voice], 48000);
  try {
    for (const { id, text } of rows) {
      let plan: Plan | undefined;
      const take = await synthesize(
        text,
        false,
        new AbortController().signal,
        voice,
        {
          ...profile,
          shapePlan: (original) => {
            plan =
              variant === "studio"
                ? original
                : candidatePlan(variant, original, voice, text);
            return plan;
          },
        },
        variant === "studio" ? "studio" : "adducted",
      );
      const name = join(dir, voice + "-" + id);
      if (
        !take.samples.every(Number.isFinite) ||
        !take.samples.some((v) => Math.abs(v) > 0.001)
      )
        throw Error("Invalid audio " + name);
      writeWav(name + ".wav", [take.samples], take.rate);
      const probe = take.frames.map(({ t, nPh, nOr }) => {
        const pose = VoiceModel.articFromArray(t.artic);
        const frame = model.frame(pose);
        const area = t.glottalArea;
        return [
          t.clock,
          frame.lipArea,
          Math.min(...t.orAreas),
          t.pressureRms[nPh + nOr - 2] * 0.1,
          t.flow.at(-1),
          area.reduce((a, b) => a + b, 0) / area.length,
          Math.max(...area),
          t.voicing,
          t.f0,
        ];
      });
      writeFileSync(
        name + ".json",
        JSON.stringify({
          text,
          voice,
          variant,
          profile,
          rate: take.rate,
          segments: take.segments,
          plan,
          columns: [
            "sec",
            "lipAreaCm2",
            "oralMinCm2",
            "anteriorPressureRmsPa",
            "lipFlowCm3s",
            "scopeMeanGlottalCm2",
            "scopeMaxGlottalCm2",
            "voicing",
            "f0Hz",
          ],
          probe,
        }),
      );
    }
  } finally {
    model.dispose();
  }
}
