import { PRESETS } from "../ui/body.ts";
import { MouthStage } from "./poseGuide.ts";
import { STUDIO_CONDITION, synthesize, validateInput, playbackAt, type Utterance } from "./synthesize.ts";

const voices = [
  ["male", "성인 남성"],
  ["female", "성인 여성"],
  ["child", "아동"],
] as const;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupSpeakers() {
  const field = byId<HTMLInputElement>("speaker-text");
  const status = byId("speaker-status");
  const controls = byId("speaker-controls");
  const vowel = byId<HTMLSelectElement>("speaker-vowel");
  const seek = byId<HTMLInputElement>("speaker-seek");
  const stopButton = byId<HTMLButtonElement>("speaker-stop");
  const group = byId("speaker-cards");
  const note = byId("speaker-note");
  const cards = voices.map(([id, name], index) => {
    const card = document.createElement("article");
    card.className = "speaker-card";
    card.innerHTML = `<header><h2>${name}</h2><button type="button" aria-label="${name} 듣기">▶ 듣기</button></header>
      <canvas aria-label="${name} 성도 단면"></canvas>
      <dl><dt>성도 길이</dt><dd class="tract"></dd></dl>
      <div class="meter" aria-hidden="true"><i class="ph"></i><i class="oral"></i></div>
      <div class="split"><span></span> · <span></span></div>
      <dl><dt>성대 진동 · F0</dt><dd class="pitch"></dd></dl>
      <div class="meter" aria-hidden="true"><i class="f0"></i></div>
      <dl><dt>공명 · F1 / F2</dt><dd class="resonance"></dd></dl>`;
    group.append(card);
    const stage = new MouthStage(card.querySelector("canvas")!);
    stage.setBody(PRESETS[id]);
    card.querySelector("button")!.onclick = () => void listen(index);
    return { stage, card, time: 0 };
  });

  let takes: Utterance[] = [];
  let job: AbortController | undefined;
  let context: AudioContext | undefined;
  let source: AudioBufferSourceNode | undefined;
  let raf = 0, playbackToken = 0, position = 0, playOffset = 0;
  const duration = () => takes[0] ? takes[0].samples.length / takes[0].rate : 0;

  function stop() {
    ++playbackToken;
    cancelAnimationFrame(raf);
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = undefined;
    }
    stopButton.disabled = true;
    for (const { card } of cards) card.classList.remove("playing");
  }

  function draw(time: number, dt = 0, only?: number) {
    if (!takes.length) return;
    position = Math.min(duration(), Math.max(0, time));
    seek.value = String(position);
    byId("speaker-time").textContent = position.toFixed(2) + " / " + duration().toFixed(2) + "초";
    cards.forEach(({ stage }, i) => {
      if (only !== undefined && i !== only) return;
      cards[i].time = position;
      const { pose, telemetry } = playbackAt(takes[i], position);
      stage.draw(pose, dt, undefined, telemetry);
    });
  }

  function redrawCards() {
    cards.forEach(({ stage, time }, i) => {
      if (!takes[i]) return;
      const { pose, telemetry } = playbackAt(takes[i], time);
      stage.draw(pose, 0, undefined, telemetry);
    });
  }

  function measure() {
    const segmentIndex = Number(vowel.value);
    const readings = cards.map(({ card, stage }, i) => {
      const seg = takes[i].segments[segmentIndex];
      const { pose, telemetry: { t } } = playbackAt(takes[i], (seg.start + seg.end) / 2);
      const [f1, f2] = stage.formantsAt(pose);
      const length = t.phLen + t.orLen;
      const write = (selector: string, value: string) => {
        card.querySelector(selector)!.textContent = value;
      };
      const bar = (selector: string, percent: number) => {
        card.querySelector<HTMLElement>(selector)!.style.width = Math.min(100, percent) + "%";
      };
      write(".tract", length.toFixed(1) + " cm");
      write(".split span:first-child", "인두 " + t.phLen.toFixed(1));
      write(".split span:last-child", "구강 " + t.orLen.toFixed(1) + " cm");
      write(".pitch", t.voicing > 0.35 ? Math.round(t.f0) + " Hz" : "무성");
      write(".resonance", [f1, f2].map(f => f ? Math.round(f) : "—").join(" / ") + " Hz");
      bar(".ph", 100 * t.phLen / 22);
      bar(".oral", 100 * t.orLen / 22);
      bar(".f0", t.voicing > 0.35 ? 100 * t.f0 / 400 : 0);
      return { length, hz: t.voicing > 0.35 ? t.f0 : 0 };
    });
    const [male, female] = readings;
    const difference = byId("speaker-difference");
    const delta = male.length - female.length;
    const hz = female.hz - male.hz;
    difference.hidden = false;
    difference.textContent = "이 모음에서 여성 프리셋의 성도는 남성 프리셋보다 " +
      Math.abs(delta).toFixed(1) + (delta >= 0 ? " cm 짧습니다." : " cm 깁니다.") +
      (female.hz && male.hz ? " 성대는 초당 " + Math.round(Math.abs(hz)) +
        (hz >= 0 ? "번 더 진동합니다." : "번 덜 진동합니다.") : "");
    const seg = takes[0].segments[segmentIndex];
    draw((seg.start + seg.end) / 2);
  }

  async function listen(index: number) {
    stop();
    const take = takes[index];
    if (!take) return;
    const token = playbackToken;
    try {
      context ??= new AudioContext();
      await context.resume();
      if (playbackToken !== token) return;
      const buffer = context.createBuffer(1, take.samples.length, take.rate);
      buffer.copyToChannel(take.samples, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      source = node;
      const start = context.currentTime - playOffset;
      cards[index].stage.resetTrails();
      cards[index].card.classList.add("playing");
      status.textContent = voices[index][1] + " 재생 중";
      stopButton.disabled = false;
      const tick = () => {
        if (source !== node) return;
        const t = context!.currentTime - start;
        draw(t, Math.min(0.05, Math.max(0, t - position)), index);
        raf = requestAnimationFrame(tick);
      };
      node.onended = () => {
        stop();
        draw(take.samples.length / take.rate, 0, index);
        status.textContent = voices[index][1] + " 재생 완료";
      };
      node.start(0, playOffset);
      tick();
    } catch (error) {
      if (playbackToken !== token) return;
      stop();
      status.textContent = error instanceof Error ? error.message : "재생할 수 없습니다.";
    }
  }

  function clear() {
    job?.abort();
    stop();
    takes = [];
    playOffset = 0;
    byId("speaker-difference").hidden = true;
    group.hidden = note.hidden = controls.hidden = true;
  }
  async function build() {
    clear();
    const controller = new AbortController();
    job = controller;
    try {
      const text = validateInput(field.value, false);
      const rendered = [];
      for (const [id, name] of voices) {
        status.textContent = name + " 음성을 합성하는 중…";
        rendered.push(await synthesize(text, false, controller.signal, id, undefined, STUDIO_CONDITION));
      }
      controller.signal.throwIfAborted();
      takes = rendered;
      const options = takes[0].segments.flatMap((s, i) => {
        if (s.kind !== "vowel") return [];
        return [new Option("/" + s.ipa + "/ · " + ((s.start + s.end) / 2).toFixed(2) + "초", String(i))];
      });
      vowel.replaceChildren(...options);
      seek.max = String(duration());
      group.hidden = note.hidden = controls.hidden = false;
      measure();
      status.textContent = "각 목소리의 듣기를 눌러 비교하세요.";
    } catch (error) {
      if (controller.signal.aborted) return;
      clear();
      status.textContent = error instanceof Error ? error.message : "합성할 수 없습니다.";
    }
  }

  byId<HTMLFormElement>("speaker-form").onsubmit = e => { e.preventDefault(); void build(); };
  field.oninput = () => { clear(); status.textContent = "비교하기를 눌러 새 문장을 합성하세요."; };
  vowel.onchange = () => { stop(); playOffset = 0; measure(); status.textContent = "선택한 모음의 중간 시점"; };
  seek.oninput = () => {
    stop();
    playOffset = Number(seek.value);
    if (playOffset >= duration()) playOffset = 0;
    for (const { stage } of cards) stage.resetTrails();
    draw(Number(seek.value));
    status.textContent = "듣기를 누르면 선택한 위치에서 재생합니다.";
  };
  stopButton.onclick = () => { stop(); status.textContent = "재생 정지"; };
  new ResizeObserver(() => {
    if (!group.hidden && group.offsetWidth) redrawCards();
  }).observe(group);
  return {
    show() {
      if (takes.length) { redrawCards(); status.textContent = "각 목소리의 듣기를 눌러 비교하세요."; }
      else void build();
    },
    leave() { job?.abort(); stop(); },
  };
}
