type Condition = "original" | "before" | "after";
interface Take {
  wav: string;
  duration: number;
  lag: number | null;
  rimeMs?: number;
  pitch: number;
  f0: [number, number | null][];
}
interface Row {
  text: string;
  loweredOnset?: boolean;
  takes: Record<Condition, Take>;
}
interface Pack {
  words: string[];
  voices: Record<string, { rows: Row[] }>;
}

const conditions: [Condition, string, string][] = [
  ["original", "원음", "#e5eaf3"],
  ["before", "조정 전", "#f3ae78"],
  ["after", "조정 후", "#7ce3ca"],
];
const names: Record<string, string> = {
  male: "남성",
  female: "여성",
  child: "아동",
};
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function unpack(take: Take) {
  // The local fitter writes mono PCM16 WAVs with a 44-byte header.
  const bytes = Uint8Array.from(atob(take.wav), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return {
    bytes,
    rate: view.getUint32(24, true),
    samples: new Int16Array(bytes.buffer, 44),
  };
}

function listeningClip(takes: Take[]) {
  const chunks = takes.map(unpack);
  const rate = chunks[0].rate,
    gap = Math.round(0.26 * rate);
  const length = chunks.reduce(
    (n, c) => n + c.samples.length,
    gap * (chunks.length - 1),
  );
  const wav = new Uint8Array(44 + 2 * length);
  wav.set(chunks[0].bytes.subarray(0, 44));
  const header = new DataView(wav.buffer);
  header.setUint32(4, wav.length - 8, true);
  header.setUint32(40, wav.length - 44, true);
  let offset = 44;
  const levels: number[] = [];
  const hop = Math.round(rate * 0.01);
  for (const c of chunks) {
    wav.set(c.bytes.subarray(44), offset);
    offset += c.samples.length * 2 + gap * 2;
    for (let a = 0; a < c.samples.length; a += hop) {
      let power = 0;
      const end = Math.min(c.samples.length, a + hop);
      for (let i = a; i < end; i++) power += (c.samples[i] / 32768) ** 2;
      levels.push(power / (end - a));
    }
  }
  const floor = Math.max(...levels) * 0.001;
  const active = levels.filter((p) => p > floor);
  return {
    url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })),
    rms: Math.sqrt(
      active.reduce((s, p) => s + p, 0) / Math.max(1, active.length),
    ),
  };
}

export function setupReference() {
  const voice = el<HTMLSelectElement>("ref-voice"),
    item = el<HTMLSelectElement>("ref-item");
  const gain = el<HTMLInputElement>("ref-gain");
  const plot = el<HTMLCanvasElement>("ref-plot"),
    status = el("ref-status");
  let pack: Pack | undefined, loading: Promise<void> | undefined;
  let shown: Row[] = [];
  const cards = conditions.map(([key, name, color]) => {
    const card = document.createElement("article");
    card.className = "panel ref-card";
    const title = document.createElement("h3");
    title.textContent = name;
    title.style.color = color;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.setAttribute("aria-label", name + " 듣기");
    const caption = document.createElement("p");
    card.append(title, audio, caption);
    el("ref-audio").append(card);
    audio.onplay = () => {
      for (const c of cards) if (c.audio !== audio) c.audio.pause();
    };
    return { key, audio, caption, url: "", rms: 1 };
  });
  function stop() {
    for (const c of cards) c.audio.pause();
  }
  function volume() {
    const common = Math.min(...cards.map((c) => c.rms));
    for (const c of cards)
      c.audio.volume =
        gain.checked && c.rms > 0 ? Math.min(1, common / c.rms) : 1;
  }
  function draw() {
    if (shown.length !== 1 || !plot.clientWidth) return;
    const w = plot.clientWidth,
      h = plot.clientHeight,
      ratio = Math.min(devicePixelRatio, 2);
    plot.width = Math.round(w * ratio);
    plot.height = Math.round(h * ratio);
    const ctx = plot.getContext("2d")!;
    ctx.scale(ratio, ratio);
    const takes = shown[0].takes;
    const duration =
      Math.max(...conditions.map(([k]) => takes[k].duration)) / 1000;
    const highest = Math.max(
      ...conditions.flatMap(([k]) => takes[k].f0.map((p) => p[1] ?? 0)),
    );
    const hzMax = Math.ceil(Math.max(250, highest) / 100) * 100;
    const x = (s: number) => 36 + (s / duration) * (w - 50);
    const y = (hz: number) => h - 24 - (hz / hzMax) * (h - 40);
    ctx.font = "12px system-ui";
    ctx.fillStyle = "#c3d1d8";
    ctx.lineWidth = 1;
    for (let hz = 0; hz <= hzMax; hz += 100) {
      ctx.fillText(String(hz), 4, y(hz) + 4);
      ctx.strokeStyle = "#304351";
      ctx.beginPath();
      ctx.moveTo(34, y(hz));
      ctx.lineTo(w - 10, y(hz));
      ctx.stroke();
    }
    for (let s = 0; s < duration - 0.01; s += duration > 0.7 ? 0.2 : 0.1)
      ctx.fillText(s.toFixed(1) + "초", x(s) - 6, h - 4);
    for (const [key, , color] of conditions) {
      ctx.strokeStyle = color;
      ctx.lineWidth = key === "after" ? 2.4 : 1.7;
      ctx.setLineDash(key === "before" ? [5, 3] : []);
      ctx.beginPath();
      let fresh = true;
      for (const [t, f] of takes[key].f0) {
        if (f === null) {
          fresh = true;
          continue;
        }
        if (fresh) ctx.moveTo(x(t), y(f));
        else ctx.lineTo(x(t), y(f));
        fresh = false;
      }
      ctx.stroke();
    }
  }
  function select() {
    if (!pack) return;
    stop();
    const rows = pack.voices[voice.value].rows;
    const indices = item.value.split(",").map(Number);
    shown = indices.map((i) => rows[i]);
    for (const c of cards) {
      if (c.url) URL.revokeObjectURL(c.url);
      const takes = shown.map((r) => r.takes[c.key]);
      const clip = listeningClip(takes);
      c.url = clip.url;
      c.rms = clip.rms;
      c.audio.src = c.url;
      c.caption.textContent =
        takes.length === 1
          ? "유성 구간 중앙값 " +
            takes[0].pitch +
            " Hz · 발화 " +
            takes[0].duration +
            " ms"
          : shown.map((r) => r.text).join(" → ");
      if (c.key === "after" && shown.some((r) => r.loweredOnset)) {
        c.caption.textContent += " · ‘불’ 모음 시작 음높이 낮춤";
      }
    }
    volume();
    plot.closest("figure")!.hidden = shown.length !== 1;
    draw();
    const tbody = el("ref-stops").querySelector("tbody")!;
    tbody.replaceChildren(
      ...rows.slice(0, 6).map((row) => {
        const tr = document.createElement("tr");
        for (const value of [
          row.text,
          conditions.map(([k]) => row.takes[k].lag).join(" / "),
          conditions.map(([k]) => row.takes[k].rimeMs).join(" / "),
        ]) {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        return tr;
      }),
    );
  }
  async function load() {
    const embedded = document.getElementById("reference-data");
    if (embedded) pack = JSON.parse(embedded.textContent!) as Pack;
    else {
      const res = await fetch("korean-lab/reference-local.json");
      if (!res.ok)
        throw new Error(
          "녹음 자료가 없는 빌드입니다. 녹음이 포함된 로컬 데모를 열어 주세요.",
        );
      pack = (await res.json()) as Pack;
    }
    for (const v of Object.keys(pack.voices))
      voice.add(new Option(names[v] ?? v, v));
    item.add(new Option("같이 먹어?", "6"));
    item.add(new Option("부 → 푸 → 뿌", "0,1,2"));
    item.add(new Option("불 → 풀 → 뿔", "3,4,5"));
    for (const [i, w] of pack.words.slice(0, 6).entries())
      item.add(new Option(w, String(i)));
    const requested = new URLSearchParams(location.search).get("item");
    const index = requested ? pack.words.indexOf(requested) : -1;
    if (index >= 0) item.value = String(index);
    status.hidden = true;
    el("ref-content").hidden = false;
    select();
  }
  voice.onchange = item.onchange = select;
  gain.onchange = volume;
  new ResizeObserver(draw).observe(plot);
  return {
    stop,
    async show() {
      try {
        await (loading ??= load());
        draw();
      } catch (error) {
        loading = undefined;
        status.hidden = false;
        status.textContent =
          error instanceof Error
            ? error.message
            : "비교 음원을 열 수 없습니다.";
      }
    },
  };
}
