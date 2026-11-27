import { initChimera } from "../wasm/chimera.ts";
import { TeleTrack } from "../show/tele.ts";
import type { PlannedSegment } from "../wasm/types.ts";

type Metrics = {
  burstMs?: number;
  voiceMs?: number;
  votMs?: number;
  wavHz?: number;
};
export interface Take {
  wav: string;
  tele: string;
  length: number;
  segments: PlannedSegment[];
  metrics: Metrics;
  glottal: number[];
  voiced: string;
  rms: number;
  envelope: number[][];
  pitch: (number | null)[];
  ipa: string;
}
export type Session = Record<
  string,
  { text: string; takes: Record<string, Take> }
>;
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const audio = get<HTMLAudioElement>("audio");
const word = get<HTMLSelectElement>("word"),
  condition = get<HTMLSelectElement>("condition");
const seek = get<HTMLInputElement>("seek"),
  site = get<HTMLInputElement>("site");
const names: Record<string, string> = {
  baseline: "개선 전",
  contour: "문장 억양",
  rhythm: "억양 + 모음 길이",
  vot: "VOT만 · 운율 고정",
  pitch: "VOT + F0",
  full: "개선 후 · VOT + F0 + 음질",
  medial: "구절 안쪽 F0도 적용",
};
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const left = 54,
  right = 10;

function surface(id: string) {
  const c = get<HTMLCanvasElement>(id),
    rect = c.getBoundingClientRect();
  const width = rect.width,
    height = rect.height,
    dpr = Math.min(2, devicePixelRatio);
  if (
    c.width !== Math.round(width * dpr) ||
    c.height !== Math.round(height * dpr)
  ) {
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
  }
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  return { g, width, height };
}

function timeline(take: Take, t: number) {
  const { g, width: w } = surface("time"),
    span = w - left - right;
  const x = (s: number) => left + (s / take.length) * span;
  g.font = "12px system-ui";
  g.fillStyle = "#b5c3ca";
  g.fillText("출력", 0, 34);
  g.fillText("F0", 0, 89);
  g.fillText("Hz", 0, 105);
  g.fillText("음소", 0, 141);
  for (const y of [37, 77, 113, 150]) {
    g.fillStyle = "#32424d";
    g.fillRect(left, y, span, 1);
  }
  // All conditions share one amplitude and frequency scale.
  g.strokeStyle = "#b6d3df";
  g.beginPath();
  for (let px = 0; px < span; px++) {
    const i = Math.floor((px / span) * take.envelope.length),
      j = Math.max(i + 1, Math.ceil(((px + 1) / span) * take.envelope.length));
    let lo = 0,
      hi = 0;
    for (let k = i; k < Math.min(j, take.envelope.length); k++) {
      lo = Math.min(lo, take.envelope[k][0]);
      hi = Math.max(hi, take.envelope[k][1]);
    }
    g.moveTo(left + px, 37 - (48 * hi) / 32767);
    g.lineTo(left + px, 37 - (48 * lo) / 32767);
  }
  g.stroke();
  g.strokeStyle = "#79e2ca";
  g.lineWidth = 2;
  g.beginPath();
  let gap = true;
  take.pitch.forEach((hz, i) => {
    if (hz === null) {
      gap = true;
      return;
    }
    const y = 115 - (hz - 60) * 0.54;
    if (gap) g.moveTo(x(i * 0.002), y);
    else g.lineTo(x(i * 0.002), y);
    gap = false;
  });
  g.stroke();
  g.lineWidth = 1;
  g.fillStyle = "#b5c3ca";
  g.fillText("130", 22, 80);
  g.fillText("65", 27, 114);
  take.segments.forEach((s, i) => {
    g.fillStyle = i % 2 ? "#2b414d" : "#24343e";
    g.fillRect(x(s.t0), 124, x(s.t1) - x(s.t0) - 1, 23);
    if (x(s.t1) - x(s.t0) > 10) {
      g.fillStyle = "#edf3f3";
      g.textAlign = "center";
      g.fillText(s.ipa, x((s.t0 + s.t1) / 2), 140);
      g.textAlign = "left";
    }
  });
  for (const [ms, col] of [
    [take.metrics.burstMs, "#f2bc77"],
    [take.metrics.voiceMs, "#91b7ff"],
  ] as const) {
    if (ms === undefined) continue;
    g.fillStyle = col;
    g.fillRect(x(ms / 1000), 5, 1.5, 142);
  }
  const tick = take.length > 1.6 ? 0.4 : 0.2;
  g.fillStyle = "#a8b8c0";
  for (let s = 0; s < take.length; s += tick) {
    g.fillText(s.toFixed(1) + " s", x(s) - 5, 169);
  }
  g.fillStyle = "#fff";
  g.fillRect(x(t), 3, 1.5, 148);
}

const embedded = (id: string) =>
  document.getElementById(id)?.textContent?.trim();

async function loadComparison() {
  const packed = embedded("session-data");
  const raw = packed
    ? new Blob([bytes(packed)])
    : await (await fetch("./korean-lab/session.gz")).blob();
  const session: Session = await new Response(
    raw.stream().pipeThrough(new DecompressionStream("gzip")),
  ).json();
  const [{ VoiceModel }, { AnatomyRenderer }, { setupListening }] =
    await Promise.all([
      import("../ui/analysis.ts"),
      import("../ui/render/anatomy.ts"),
      import("./listening.ts"),
    ]);
  let model = new VoiceModel({ female: 0, child: 0 }, 48000);
  let renderer = new AnatomyRenderer(),
    take: Take,
    track: TeleTrack,
    previous = -1,
    frameId = 0;
  let lastWidth = 0;
  const measure = () => {
    const m = take.metrics;
    get("metric").textContent = m.wavHz
      ? `VOT ${m.votMs} ms · 모음 시작 F0 ${m.wavHz} Hz (WAV)`
      : "";
  };
  function draw(force = false) {
    if (get("explorer").hidden || !track) return;
    const t = audio.currentTime;
    if (!force && previous === t) return;
    const jumped = previous < 0 || previous > t || t - previous > 0.1;
    if (jumped) renderer = new AnatomyRenderer();
    const dt = jumped ? 0 : Math.min(0.05, t - previous);
    previous = t;
    const tele = track.message(track.indexAt(t)),
      a = VoiceModel.articFromArray(tele.t.artic);
    const { g, width, height } = surface("head");
    // Lay out the same sagittal projection at desktop width even on a small display.
    const scale = height / 310,
      virtualW = Math.max(565, width / scale);
    if (jumped || lastWidth !== virtualW) {
      renderer.resize(virtualW, 310);
      lastWidth = virtualW;
    }
    g.translate((width - virtualW * scale) / 2 + Math.min(90, width * 0.12), 0);
    g.scale(scale, scale);
    renderer.draw(
      g,
      model,
      model.frame(a),
      a,
      tele,
      { pressure: true, particles: true, grid: false, calipers: false },
      { hover: null, drag: null, dt, formants: [], slots: [], info: [] },
    );
    const n = Number(site.value);
    get("siteName").textContent =
      n < track.nPh
        ? `인두 ${n + 1}/${track.nPh}`
        : `구강 ${n - track.nPh + 1}/${track.nOr}`;
    get("pressure").textContent = (tele.t.pressureRms[n] * 0.1).toFixed(1);
    get("flow").textContent = tele.t.flow[n].toFixed(1);
    const f = surface("fold"),
      ms = Math.round(t * 1000);
    const arr = take.glottal.slice(Math.max(0, ms - 39), ms + 1);
    f.g.strokeStyle = "#e4a3bf";
    f.g.lineWidth = 2;
    f.g.beginPath();
    arr.forEach((y, i) => {
      const px = 5 + ((40 - arr.length + i) / 39) * (f.width - 10),
        py = f.height - 6 - clamp(y / 0.45, 0, 1) * (f.height - 12);
      if (i === 0) f.g.moveTo(px, py);
      else f.g.lineTo(px, py);
    });
    f.g.stroke();
    get("foldNote").textContent =
      `최근 40 ms 최댓값 ${Math.max(0, ...arr).toFixed(3)} cm² · ${take.voiced[ms] === "1" ? "유성" : "무성"}`;
    timeline(take, t);
    seek.value = String(t);
    get("clock").textContent = (t * 1000).toFixed(0) + " ms";
  }
  function loop() {
    draw();
    if (!audio.paused) frameId = requestAnimationFrame(loop);
  }
  audio.onplay = () => {
    cancelAnimationFrame(frameId);
    loop();
  };
  audio.onseeked = () => draw(true);
  audio.onpause = () => draw(true);
  audio.ontimeupdate = () => draw();
  function chooseTake() {
    audio.pause();
    take = session[word.value].takes[condition.value];
    track = new TeleTrack(bytes(take.tele).buffer);
    if (
      model.body.female !== track.body.female ||
      model.body.child !== track.body.child
    ) {
      model.dispose();
      model = new VoiceModel(track.body, track.sampleRate);
    }
    previous = -1;
    audio.src = "data:audio/wav;base64," + take.wav;
    seek.max = String(take.length);
    site.max = String(track.nPh + track.nOr - 1);
    site.value = String(track.nPh + Math.floor(track.nOr * 0.6));
    get("release").hidden = take.metrics.burstMs === undefined;
    get("voice").hidden = take.metrics.voiceMs === undefined;
    get("trans").textContent = "계획 음소   / " + take.ipa + " /";
    measure();
    draw(true);
  }
  function chooseWord() {
    const old = condition.value;
    condition.replaceChildren();
    for (const c of Object.keys(session[word.value].takes))
      condition.add(new Option(names[c], c));
    condition.value = session[word.value].takes[old]
      ? old
      : session[word.value].takes.full
        ? "full"
        : Object.keys(session[word.value].takes)[0];
    chooseTake();
  }
  for (const [key, v] of Object.entries(session).sort(
    ([a], [b]) =>
      Number(a.startsWith("context-")) - Number(b.startsWith("context-")),
  )) {
    if (key !== "context-bul") word.add(new Option(v.text, key));
  }
  const move = (s: number) => {
    audio.currentTime = clamp(s, 0, take.length);
    draw(true);
  };
  seek.oninput = () => move(Number(seek.value));
  site.oninput = () => draw(true);
  get("time").onclick = (e) => {
    const rect = get("time").getBoundingClientRect();
    move(
      ((e.clientX - rect.left - left) / (rect.width - left - right)) *
        take.length,
    );
  };
  get("release").onclick = () => move(take.metrics.burstMs! / 1000);
  get("voice").onclick = () => move(take.metrics.voiceMs! / 1000);
  word.onchange = chooseWord;
  condition.onchange = chooseTake;
  window.addEventListener("resize", () => draw(true));
  const files = get<HTMLInputElement>("import");
  files.onchange = async () => {
    if (!files.files?.length) return;
    try {
      const { readRender } = await import("./readRender.ts");
      const { take: local, text } = await readRender([...files.files]);
      session.custom = { text, takes: { custom: local } };
      names.custom = "가져온 렌더";
      word.querySelector('option[value="custom"]')?.remove();
      word.add(new Option(text, "custom"));
      word.value = "custom";
      chooseWord();
      get("importState").textContent = "불러왔습니다.";
    } catch (e) {
      get("importState").textContent = String(e);
    }
    files.value = "";
  };
  const stopBlind = setupListening(session);
  chooseWord();
  return {
    stop() {
      audio.pause();
      stopBlind();
    },
    redraw() {
      draw(true);
    },
  };
}

async function main() {
  const wasm = embedded("engine-data");
  await initChimera(wasm ? bytes(wasm) : undefined);
  const { setupStudio } = await import("./studio.ts");
  const studio = setupStudio();
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('nav [role="tab"]'),
  );
  const status = get("status");
  let comparison: Awaited<ReturnType<typeof loadComparison>> | undefined;
  let loading: ReturnType<typeof loadComparison> | undefined;
  let navigation = 0;
  async function select(id: string) {
    const current = ++navigation;
    studio.stop();
    comparison?.stop();
    for (const tab of tabs) {
      const selected = tab.id === id;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      get(tab.getAttribute("aria-controls")!).hidden = !selected;
    }
    status.hidden = true;
    if (id === "tts" || id === "prepare") {
      studio.show(id);
      return;
    }
    if (!comparison) {
      get("explorer").hidden = get("listener").hidden = true;
      status.hidden = false;
      status.textContent = "비교 음원을 여는 중…";
      try {
        comparison = await (loading ??= loadComparison());
      } catch {
        loading = undefined;
        if (current === navigation)
          status.textContent =
            "비교 음원을 열 수 없습니다. 탭을 눌러 다시 시도해 주세요.";
        return;
      }
      if (current !== navigation) return;
      status.hidden = true;
      get(id === "explore" ? "explorer" : "listener").hidden = false;
    }
    if (id === "explore") comparison.redraw();
  }
  const fromHash = () =>
    tabs.find((b) => "#" + b.id === location.hash)?.id ?? "tts";
  for (const [i, tab] of tabs.entries()) {
    tab.onclick = () => {
      if (location.hash === "#" + tab.id) void select(tab.id);
      else location.hash = tab.id;
    };
    tab.onkeydown = (e) => {
      const n = tabs.length;
      const dest = (
        {
          ArrowRight: (i + 1) % n,
          ArrowLeft: (i + n - 1) % n,
          Home: 0,
          End: n - 1,
        } as Record<string, number>
      )[e.key];
      if (dest === undefined) return;
      e.preventDefault();
      tabs[dest].focus();
      tabs[dest].click();
    };
  }
  window.addEventListener("hashchange", () => void select(fromHash()));
  await select(fromHash());
}
main().catch((e) => {
  get("status").hidden = false;
  get("status").textContent = "자료를 열 수 없습니다. " + e.message;
});
