import type { Utterance } from "./synthesize.ts";

/** Float WAV lets the pitch-preserving browser player read the original mono samples. */
export function speechUrl({ samples, rate }: Utterance) {
  const bytes = samples.byteLength;
  const header = new ArrayBuffer(44);
  const h = new DataView(header);
  function tag(offset: number, name: string) {
    for (let i = 0; i < name.length; i++)
      h.setUint8(offset + i, name.charCodeAt(i));
  }
  tag(0, "RIFF");
  h.setUint32(4, 36 + bytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 3, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * 4, true);
  h.setUint16(32, 4, true);
  h.setUint16(34, 32, true);
  tag(36, "data");
  h.setUint32(40, bytes, true);
  return URL.createObjectURL(
    new Blob([header, samples], { type: "audio/wav" }),
  );
}
