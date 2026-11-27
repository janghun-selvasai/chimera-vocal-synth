import { NEUTRAL } from "../wasm/engine.ts";
import { PRESETS } from "../ui/body.ts";
import type { BodyName, TelemetryMessage } from "../worklet/protocol.ts";
import {
  synthesize,
  validateInput,
  playbackAt,
  type Utterance,
} from "./synthesize.ts";
import {
  MouthStage,
  movingParts,
  guideFrame,
  STEP_SECONDS,
  HOLD_SECONDS,
} from "./poseGuide.ts";

export type StudioMode = "tts" | "prepare";
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export function setupStudio() {
  const view = el("mouth-stage"),
    stage = new MouthStage(el<HTMLCanvasElement>("live-head"));
  const title = el("stage-state"),
    phones = el("live-phones"),
    progress = el("stage-progress");
  const voiceSelect = el<HTMLSelectElement>("studio-voice");
  const fortisSelect = el<HTMLSelectElement>("studio-fortis");
  const voice = () => voiceSelect.value as BodyName;
  const lipFlow = el("lip-flow");
  let mode: StudioMode = "tts",
    ctx: AudioContext | undefined;
  let job: AbortController | undefined,
    source: AudioBufferSourceNode | undefined,
    raf = 0;
  let lastPose = { ...NEUTRAL },
    lastGuide: ReturnType<typeof guideFrame> | undefined;
  let lastFrame: TelemetryMessage | null = null;
  const status = () => el(mode + "-status");
  const stopButton = () =>
    el(mode + "-form").querySelector<HTMLButtonElement>(".stop")!;
  function draw(
    pose = lastPose,
    dt = 0,
    guide?: ReturnType<typeof guideFrame>,
    frame: TelemetryMessage | null = null,
  ) {
    lastPose = pose;
    lastGuide = guide;
    lastFrame = frame;
    const flow = frame?.t.flow.at(-1);
    lipFlow.textContent = flow === undefined ? "—" : flow.toFixed(1);
    stage.draw(pose, dt, guide, frame);
  }
  function setProgress(value: number) {
    const percent = Math.round(100 * Math.max(0, Math.min(1, value)));
    progress.setAttribute("aria-valuenow", String(percent));
    progress.style.setProperty("--progress", percent + "%");
  }
  function stop() {
    job?.abort();
    job = undefined;
    cancelAnimationFrame(raf);
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = undefined;
    }
    stopButton().disabled = true;
  }
  function reset(message = "") {
    stop();
    title.textContent = "대기";
    phones.textContent = "발음 기호";
    status().textContent = message;
    setProgress(0);
    draw({ ...NEUTRAL });
  }
  function show(next: StudioMode) {
    reset();
    mode = next;
    stage.closeUp = next === "prepare";
    el(next + "-form")
      .querySelector(".transport")!
      .before(el("studio-voice-field"));
    stage.setBody(PRESETS[voice()]);
    el(next + "-panel").append(view);
    view.hidden = false;
    reset();
  }
  function play(take: Utterance, signal: AbortSignal) {
    signal.throwIfAborted();
    const buffer = ctx!.createBuffer(1, take.samples.length, take.rate);
    buffer.copyToChannel(take.samples, 0);
    const node = ctx!.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx!.destination);
    source = node;
    stage.resetTrails();
    const started = ctx!.currentTime;
    const symbols = take.segments.map((s) => {
      const span = document.createElement("span");
      span.textContent = s.ipa;
      return span;
    });
    phones.replaceChildren(...symbols);
    let previous = 0,
      previousPhone = -1;
    title.textContent = "발화 중";
    status().textContent = "발화 중";
    const tick = () => {
      if (signal.aborted) return;
      const t = ctx!.currentTime - started,
        index = take.segments.findIndex((s) => t >= s.start && t < s.end);
      if (previousPhone !== index) {
        symbols[previousPhone]?.classList.remove("active");
        symbols[index]?.classList.add("active");
        previousPhone = index;
      }
      const { pose, telemetry } = playbackAt(take, t);
      draw(
        pose,
        Math.max(0, Math.min(0.05, t - previous)),
        undefined,
        telemetry,
      );
      previous = t;
      setProgress(t / buffer.duration);
      raf = requestAnimationFrame(tick);
    };
    node.onended = () => {
      if (signal.aborted) return;
      cancelAnimationFrame(raf);
      node.disconnect();
      source = undefined;
      job = undefined;
      symbols[previousPhone]?.classList.remove("active");
      draw(playbackAt(take, buffer.duration).pose);
      setProgress(1);
      title.textContent = "완료";
      status().textContent = "재생 완료";
      stopButton().disabled = true;
    };
    node.start(started);
    tick();
  }
  function prepare(
    take: Utterance,
    signal: AbortSignal,
    fail: (e: unknown) => void,
  ) {
    const target = playbackAt(take, 0).pose;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const steps = reduce ? [] : movingParts(target);
    const total = steps.length * STEP_SECONDS + HOLD_SECONDS;
    const began = performance.now();
    let previous = 0,
      shown = -2;
    title.textContent = "첫소리 준비";
    phones.textContent = "첫소리  /" + take.first + "/";
    function tick(now: number) {
      if (signal.aborted) return;
      const t = Math.max(0, (now - began) / 1000);
      if (t >= total) {
        draw(target);
        try {
          play(take, signal);
        } catch (e) {
          fail(e);
        }
        return;
      }
      const frame = guideFrame(target, steps, t);
      if (frame.index !== shown) {
        status().textContent = frame.part
          ? frame.part.name +
            " 위치 잡기 · " +
            (frame.index + 1) +
            " / " +
            steps.length
          : "첫 입모양 준비 완료";
        shown = frame.index;
      }
      draw(
        reduce ? target : frame.pose,
        Math.min(0.05, t - previous),
        reduce ? undefined : frame,
      );
      previous = t;
      raf = requestAnimationFrame(tick);
    }
    tick(began);
  }
  async function start() {
    reset();
    const field = el<HTMLInputElement | HTMLTextAreaElement>(mode + "-input");
    let text: string;
    try {
      text = validateInput(field.value, mode === "prepare");
      field.removeAttribute("aria-invalid");
    } catch (e) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
      status().textContent = e instanceof Error ? e.message : String(e);
      return;
    }
    const active = new AbortController();
    job = active;
    function fail(e: unknown) {
      if (active.signal.aborted) return;
      reset(e instanceof Error ? e.message : String(e));
    }
    try {
      ctx ??= new AudioContext();
      // Resume during the submit gesture, before rendering or animating, including on mobile.
      const ready = ctx.resume();
      stopButton().disabled = false;
      status().textContent = "음성을 합성하는 중…";
      title.textContent = "합성 중";
      const [take] = await Promise.all([
        synthesize(text, mode === "prepare", active.signal, voice(), undefined,
          fortisSelect.value === "adducted" ? "adducted" : "clear"),
        ready,
      ]);
      active.signal.throwIfAborted();
      if (mode === "prepare") prepare(take, active.signal, fail);
      else play(take, active.signal);
    } catch (e) {
      fail(e);
    }
  }
  for (const tab of ["tts", "prepare"] as const) {
    const form = el<HTMLFormElement>(tab + "-form");
    const field = el<HTMLInputElement | HTMLTextAreaElement>(tab + "-input");
    form.onsubmit = (e) => {
      e.preventDefault();
      void start();
    };
    form.querySelector<HTMLButtonElement>(".stop")!.onclick = () =>
      reset("정지했습니다.");
    field.oninput = () => {
      field.removeAttribute("aria-invalid");
      reset();
    };
    for (const b of form.querySelectorAll<HTMLButtonElement>(
      ".suggestions button",
    )) {
      b.onclick = () => {
        field.value = b.textContent!;
        field.dispatchEvent(new Event("input"));
        field.focus();
      };
    }
    el<HTMLButtonElement>(tab + "-start").disabled = false;
  }
  voiceSelect.onchange = () => {
    stage.setBody(PRESETS[voice()]);
    reset();
  };
  fortisSelect.onchange = () => reset();
  new ResizeObserver(() =>
    stage.draw(lastPose, 0, lastGuide, lastFrame),
  ).observe(view);
  window.addEventListener("pagehide", stop);
  return { show, stop };
}
