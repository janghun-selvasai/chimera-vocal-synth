/** Geometry for the liaison figure, from the same native telemetry as the replay. */
import { readFileSync, writeFileSync } from "node:fs";
import { initChimera } from "../../src/wasm/chimera.ts";
import { TeleTrack } from "../../src/show/tele.ts";
await initChimera(new Uint8Array(readFileSync("src/wasm/chimera.wasm")));
const { VoiceModel } = await import("../../src/ui/analysis.ts");
const [stem, output] = process.argv.slice(2);
const track = new TeleTrack(
  new Uint8Array(readFileSync(stem + ".tele")).buffer,
);
const model = new VoiceModel(track.body, track.sampleRate);
const frames = Array.from({ length: track.frames }, (_, i) => {
  const artic = VoiceModel.articFromArray(track.message(i).t.artic);
  const { tongue, upperLip, lowerLip, outer, jawBone, tip, tongueCenter } =
    model.frame(artic);
  return {
    t: i / track.rate,
    tongue,
    upperLip,
    lowerLip,
    outer,
    jawBone,
    tip,
    tongueCenter,
  };
});
writeFileSync(output, JSON.stringify(frames));
model.dispose();
