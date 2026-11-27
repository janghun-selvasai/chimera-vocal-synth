import type { Utterance } from "./synthesize.ts";
import type { TelemetryMessage } from "../worklet/protocol.ts";

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const left = 52,
  right = 12;
function surface(canvas: HTMLCanvasElement) {
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  const dpi = Math.min(devicePixelRatio, 2);
  if (
    canvas.width !== Math.round(w * dpi) ||
    canvas.height !== Math.round(h * dpi)
  ) {
    canvas.width = Math.round(w * dpi);
    canvas.height = Math.round(h * dpi);
  }
  const g = canvas.getContext("2d")!;
  g.setTransform(dpi, 0, 0, dpi, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/** Anchor the PCM transient to a reopening in the rendered oral tube.
 * Geometry snapshots are 10 ms apart, so search the whole interval straddling the reopening.
 */
function openingTime(
  take: Utterance,
  start: number,
  end: number,
  area: (f: TelemetryMessage) => number,
) {
  let opening: number | undefined;
  const first = Math.max(1, Math.floor(Math.max(start, end - 0.04) * 100));
  const last = Math.min(take.frames.length - 1, Math.ceil((end + 0.04) * 100));
  for (let i = first; i <= last; i++) {
    const before = area(take.frames[i - 1]),
      after = area(take.frames[i]);
    if (
      before <= 0.02 &&
      after > 0.02 &&
      (opening === undefined ||
        Math.abs(i / 100 - end) < Math.abs(opening - end))
    )
      opening = i / 100;
  }
  return opening;
}

function measuredRelease(take: Utterance, opening: number) {
  const rate = take.rate,
    n = Math.round(rate * 0.001);
  const a = Math.max(1, Math.floor((opening - 0.013) * rate));
  const b = Math.min(take.samples.length, Math.ceil((opening + 0.008) * rate));
  if (b - a < n) return;
  // One-pole 1 kHz high-pass followed by a sliding 1 ms energy window.
  const alpha = Math.exp((-2 * Math.PI * 1000) / rate);
  const prefix = new Float64Array(b - a + 1);
  let hp = 0;
  for (let i = Math.max(1, a - n * 5); i < b; i++) {
    hp = alpha * (hp + take.samples[i] - take.samples[i - 1]);
    if (i >= a) prefix[i - a + 1] = prefix[i - a] + hp * hp;
  }
  let best = 0,
    peak = 0;
  for (let i = 0; i + n < prefix.length; i++) {
    const energy = prefix[i + n] - prefix[i];
    if (energy > peak) {
      best = i;
      peak = energy;
    }
  }
  if (peak / n > 1e-12) return (a + best + n / 2) / rate;
}

export function utteranceView(
  move: (t: number) => void,
  resume: () => void,
  lipArea: (f: TelemetryMessage) => number,
) {
  const time = el<HTMLCanvasElement>("time"),
    fold = el<HTMLCanvasElement>("fold");
  const seek = el<HTMLInputElement>("seek"),
    site = el<HTMLInputElement>("site");
  const openingButton = el<HTMLButtonElement>("opening");
  const release = el<HTMLButtonElement>("release"),
    voice = el<HTMLButtonElement>("voice");
  const play = el<HTMLButtonElement>("resume"),
    stopList = el<HTMLSelectElement>("analysis-stop");
  const background = document.createElement("canvas");
  let take: Utterance | undefined,
    duration = 0,
    position = 0,
    frame: TelemetryMessage | undefined;
  let markers: {
    label: string;
    plan: number;
    opening?: number;
    labial: boolean;
    release?: number;
    alreadyVoiced: boolean;
    voice?: number;
  }[] = [];
  let lows: number[] = [],
    highs: number[] = [];
  const plotWidth = () => Math.max(1, time.clientWidth - left - right);

  function chart() {
    const { g, w, h } = surface(time);
    if (!w || !h) return;
    const width = plotWidth(),
      x = (s: number) => left + (width * s) / duration;
    g.font = "12px system-ui";
    for (const [label, y] of [
      ["파형", 35],
      ["F0", 93],
      ["음소", 142],
    ] as const) {
      g.fillStyle = "#b6c8d4";
      g.fillText(label, 2, y);
      g.strokeStyle = "#344651";
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(w - right, y);
      g.stroke();
    }
    if (take) {
      const bins = lows.length;
      g.strokeStyle = "#85dec9";
      g.beginPath();
      for (let i = 0; i < bins; i++) {
        const px = left + (width * i) / bins;
        g.moveTo(px, 35 - highs[i] * 27);
        g.lineTo(px, 35 - lows[i] * 27);
      }
      g.stroke();
      let upper = 100;
      for (const { t } of take.frames)
        if (t.voicing > 0.2) upper = Math.max(upper, t.f0);
      upper = 50 * Math.ceil(upper / 50);
      g.fillStyle = "#b6c8d4";
      g.fillText(upper + " Hz", 2, 74);
      g.strokeStyle = "#ffbc82";
      g.lineWidth = 2;
      g.beginPath();
      let pen = false;
      take.frames.forEach(({ t }, i) => {
        if (t.voicing <= 0.2 || t.f0 <= 0) {
          pen = false;
          return;
        }
        const px = x(Math.min(duration, i / 100)),
          py = 119 - (47 * t.f0) / upper;
        if (pen) g.lineTo(px, py);
        else g.moveTo(px, py);
        pen = true;
      });
      g.stroke();
      g.lineWidth = 1;
      let nextLabel = left;
      for (const s of take.segments) {
        const a = x(Math.max(0, s.start)),
          b = x(s.end);
        g.fillStyle = s.kind === "vowel" ? "#22483f" : "#283b4e";
        g.fillRect(a, 127, Math.max(1, b - a - 1), 24);
        const label = s.displayIpa ?? s.ipa,
          wide = g.measureText(label).width;
        if ((a + b - wide) / 2 >= nextLabel && b - a >= wide) {
          g.fillStyle = "#eff6fa";
          g.fillText(label, (a + b - wide) / 2, 144);
          nextLabel = (a + b + wide) / 2 + 2;
        }
      }
      const marker = markers[stopList.selectedIndex];
      for (const [s, color] of [
        [marker?.opening, "#71ddbc"],
        [marker?.release, "#f6cb72"],
        [marker?.voice, "#a1b7ff"],
      ] as const) {
        if (s === undefined) continue;
        g.strokeStyle = color;
        g.setLineDash([3, 4]);
        g.beginPath();
        g.moveTo(x(s), 2);
        g.lineTo(x(s), 123);
        g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = "#b6c8d4";
      g.fillText("0 s", left, h - 3);
      const end = duration.toFixed(2) + " s";
      g.fillText(end, w - right - g.measureText(end).width, h - 3);
    }
    background.width = time.width;
    background.height = time.height;
    background.getContext("2d")!.drawImage(time, 0, 0);
  }
  function readings() {
    const { g, w, h } = surface(fold);
    if (!frame || !w) return;
    const t = frame.t,
      n = Number(site.value);
    el("siteName").textContent =
      n < frame.nPh
        ? "인두 " + (n + 1) + "/" + frame.nPh
        : "구강 " + (n - frame.nPh + 1) + "/" + frame.nOr;
    el("pressure").textContent = (0.1 * t.pressureRms[n]).toFixed(1);
    el("flow").textContent = t.flow[n].toFixed(1);
    const area = t.glottalArea,
      peak = Math.max(...area, 0.01);
    g.beginPath();
    g.strokeStyle = "#efa7c5";
    g.lineWidth = 2;
    area.forEach((v, i) => {
      const x = 2 + ((w - 4) * i) / (area.length - 1),
        y = h - 4 - ((h - 10) * v) / peak;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    el("foldNote").textContent =
      "표시 구간 최대 " +
      Math.max(...area).toFixed(3) +
      " cm² · " +
      (t.voicing > 0.2 ? "성대 진동 " + t.f0.toFixed(0) + " Hz" : "무성 구간");
  }
  function render(t: number, f?: TelemetryMessage) {
    position = t;
    frame = f;
    seek.value = String(t);
    el("clock").textContent = t.toFixed(3) + " s";
    const { g, w, h } = surface(time);
    if (background.width && background.height && w && h) {
      g.drawImage(background, 0, 0, w, h);
      if (take) {
        const x = left + (plotWidth() * t) / duration;
        g.strokeStyle = "#f4f7f9";
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h - 16);
        g.stroke();
      }
    }
    readings();
  }
  function selectMarker() {
    const marker = markers[stopList.selectedIndex];
    openingButton.disabled = marker?.opening === undefined;
    openingButton.textContent =
      marker && !marker.labial ? "구강 열림으로 이동" : "입술 열림으로 이동";
    release.disabled = marker?.release === undefined;
    voice.disabled = marker?.voice === undefined;
    const ms = (v?: number) =>
      v === undefined ? "미검출" : Math.round(1000 * v) + " ms";
    el("landmarks").textContent = marker
      ? [
          "계획 경계 " + ms(marker.plan),
          (marker.labial ? "입술" : "구강") + " 열림 " + ms(marker.opening),
          "파형 추정 파열 " + ms(marker.release),
          marker.alreadyVoiced
            ? "파열 전부터 유성"
            : "모델 유성 개시 " + ms(marker.voice),
          "단면·성대 측정 간격 10 ms",
        ].join(" · ")
      : take
        ? "이 발화에는 모음 앞 파열 표지가 없습니다."
        : "문장을 읽으면 파형과 발음 구간이 표시됩니다.";
    chart();
    render(position, frame);
  }
  function set(next?: Utterance) {
    take = next;
    position = 0;
    frame = undefined;
    lows = [];
    highs = [];
    markers = [];
    duration = next ? next.samples.length / next.rate : 0;
    seek.disabled = site.disabled = play.disabled = !next;
    seek.max = String(duration || 1);
    for (const id of ["pressure", "flow", "siteName"]) el(id).textContent = "—";
    el("foldNote").textContent = "";
    if (next) {
      const f = next.frames[0];
      site.max = String(f.nPh + f.nOr - 1);
      site.value = String(f.nPh + Math.floor(f.nOr / 2));
      const stride = Math.max(1, Math.ceil(next.samples.length / 1600));
      let peak = 0.0001;
      for (let i = 0; i < next.samples.length; i += stride) {
        let low = 0,
          high = 0;
        for (let j = i; j < Math.min(i + stride, next.samples.length); j++) {
          low = Math.min(low, next.samples[j]);
          high = Math.max(high, next.samples[j]);
        }
        lows.push(low);
        highs.push(high);
        peak = Math.max(peak, -low, high);
      }
      lows = lows.map((v) => v / peak);
      highs = highs.map((v) => v / peak);
      next.segments.forEach((s, i) => {
        const vowel = next.segments[i + 1];
        if (!["stop", "affricate"].includes(s.kind) || vowel?.kind !== "vowel")
          return;
        const labial = ["p", "b"].includes(s.ipa);
        const opening = openingTime(
          next,
          s.start,
          s.end,
          labial ? lipArea : (f) => Math.min(...f.t.orAreas),
        );
        const burst =
          opening === undefined ? undefined : measuredRelease(next, opening);
        const first = Math.max(0, Math.ceil((burst ?? opening ?? s.end) * 100));
        const voiced = (k: number) => (next.frames[k]?.t.voicing ?? 0) > 0.2;
        const alreadyVoiced =
          first >= 2 && [first - 2, first - 1, first, first + 1].every(voiced);
        let onset: number | undefined;
        if (!alreadyVoiced) {
          for (
            let k = first;
            k / 100 < vowel.end && k + 1 < next.frames.length;
            k++
          )
            if (voiced(k) && voiced(k + 1)) {
              onset = k / 100;
              break;
            }
        }
        markers.push({
          label:
            "/" + (s.displayIpa ?? s.ipa) + "/ · " + s.end.toFixed(2) + " s",
          plan: s.end,
          labial,
          opening,
          release: burst,
          alreadyVoiced,
          voice: onset,
        });
      });
    }
    stopList.replaceChildren(
      ...markers.map((m, i) => new Option(m.label, String(i))),
    );
    stopList.parentElement!.hidden = !markers.length;
    selectMarker();
  }
  stopList.onchange = selectMarker;
  openingButton.onclick = () => move(markers[stopList.selectedIndex].opening!);
  release.onclick = () => move(markers[stopList.selectedIndex].release!);
  voice.onclick = () => move(markers[stopList.selectedIndex].voice!);
  play.onclick = resume;
  seek.oninput = () => move(Number(seek.value));
  site.oninput = readings;
  time.onclick = (e) => {
    if (take)
      move(
        duration *
          Math.max(
            0,
            Math.min(
              1,
              (e.clientX - time.getBoundingClientRect().left - left) /
                plotWidth(),
            ),
          ),
      );
  };
  new ResizeObserver(() => {
    chart();
    render(position, frame);
  }).observe(time);
  set();
  return { set, render };
}
