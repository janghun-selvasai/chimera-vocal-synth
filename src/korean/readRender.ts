/** Import one native 'render korean ... --trace' triplet, including float WAVs. */
import { TeleTrack } from "../show/tele.ts";
import type { Take } from "./lab.ts";

function base64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 16384)
    raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(raw);
}
export async function readRender(
  files: File[],
): Promise<{ text: string; take: Take }> {
  const stems = new Set(files.map((f) => f.name.replace(/\.[^.]+$/, "")));
  if (stems.size !== 1 || files.length !== 3)
    throw new Error("같은 렌더의 파일 세 개가 필요합니다.");
  const file = (ext: string) => {
    const f = files.find((f) => f.name.endsWith("." + ext));
    if (!f) throw Error(ext + " 파일이 필요합니다.");
    return f;
  };
  const [wav, tele, d] = await Promise.all([
    file("wav").arrayBuffer(),
    file("tele").arrayBuffer(),
    file("json").text().then(JSON.parse),
  ]);
  const track = new TeleTrack(tele);
  const h = new DataView(wav);
  const code = h.getUint16(20, true),
    fs = h.getUint32(24, true),
    bits = h.getUint16(34, true);
  if (
    new TextDecoder().decode(wav.slice(36, 40)) !== "data" ||
    h.getUint16(22, true) !== 1 ||
    !((code === 1 && bits === 16) || (code === 3 && bits === 32)) ||
    fs !== track.sampleRate ||
    fs !== d.sampleRate ||
    !d.probes?.length ||
    !d.plan?.segments?.length
  )
    throw Error("CHIMERA 한국어 렌더 형식을 확인하세요.");
  const n = (wav.byteLength - 44) / (bits / 8),
    hop = fs / 1000;
  if (
    !Number.isInteger(hop) ||
    Math.ceil(n / hop) !== d.probes.length ||
    Math.floor(n / track.hop) + 1 !== track.frames
  )
    throw Error("렌더 길이가 일치하지 않습니다.");
  let energy = 0;
  const envelope: number[][] = [];
  for (let i = 0; i < n; i += hop) {
    let lo = 0,
      hi = 0;
    for (let j = i; j < Math.min(n, i + hop); j++) {
      const s =
        bits === 16
          ? h.getInt16(44 + j * 2, true)
          : 32767 * h.getFloat32(44 + j * 4, true);
      energy += (s / 32767) ** 2;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    envelope.push([lo, hi]);
  }
  const probes = d.probes as number[][];
  return {
    text: d.text,
    take: {
      wav: base64(new Uint8Array(wav)),
      tele: base64(new Uint8Array(tele)),
      length: n / fs,
      segments: d.plan.segments,
      metrics: {},
      envelope,
      pitch: probes
        .filter((_, i) => i % 2 === 0)
        .map((p) => (p[2] >= 0.2 ? p[7] : null)),
      voiced: probes.map((p) => p[2] >= 0.2 ? "1" : "0").join(""),
      glottal: probes.map((p) => p[4]),
      rms: Math.sqrt(energy / n),
      ipa: d.plan.segments.map((s: { ipa: string }) => s.ipa).join(" "),
    },
  };
}
