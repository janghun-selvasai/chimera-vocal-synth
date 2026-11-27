import { NEUTRAL, type HumanArtic } from "../wasm/engine.ts";
import { PRESETS } from "../ui/body.ts";
import { VoiceModel } from "../ui/analysis.ts";
import type { BodyName, TelemetryMessage } from "../worklet/protocol.ts";
import type { HandleId } from "../ui/render/anatomy.ts";
import {
  STUDIO_CONDITION,
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
import { speechUrl } from "./speechAudio.ts";
import { openManual } from "./manual.ts";
import { utteranceView } from "./utteranceView.ts";

export type StudioMode = "tts" | "prepare";
type AnimationMode = "auto" | "manual" | "film";
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const filmShots = [
  [
    "성문",
    "폐에서 올라온 날숨이 성대 사이를 지나며 성문 면적 변화에 따라 맥동합니다.",
  ],
  ["인두", "성문을 지난 흐름이 혀뿌리 뒤쪽 인두를 통과합니다."],
  [
    "혀와 입천장",
    "혀의 높이가 통로의 단면적을 바꾸고 성도의 공명에 영향을 줍니다.",
  ],
  [
    "입술",
    "입술의 열림과 돌출이 출구 모양을 정하고 소리가 입 밖으로 방사됩니다.",
  ],
];

export function setupStudio() {
  const view = el("mouth-stage"),
    canvas = el<HTMLCanvasElement>("live-head"),
    stage = new MouthStage(canvas);
  const title = el("stage-state"),
    phones = el("live-phones"),
    progress = el("stage-progress"),
    lipFlow = el("lip-flow");
  const voiceSelect = el<HTMLSelectElement>("studio-voice"),
    voice = () => voiceSelect.value as BodyName;
  const speed = el<HTMLInputElement>("guide-speed"),
    breath = el<HTMLInputElement>("breath"),
    part = el<HTMLSelectElement>("manual-part");
  let mode: StudioMode = "tts",
    animation: AnimationMode = "auto";
  let ctx: AudioContext | undefined,
    source: AudioBufferSourceNode | undefined,
    job: AbortController | undefined,
    raf = 0;
  const wordAudio = el<HTMLAudioElement>("word-audio");
  let speechSpeed = 1,
    filmSpeed = 1,
    wordUrl: string | undefined;
  function clearWordAudio() {
    if (!wordUrl) return;
    wordAudio.onended = null;
    wordAudio.pause();
    wordAudio.removeAttribute("src");
    wordAudio.load();
    URL.revokeObjectURL(wordUrl);
    wordUrl = undefined;
  }
  let ttsTake: Utterance | undefined,
    position = 0;
  let bufferTake: Utterance | undefined, buffer: AudioBuffer | undefined;
  let lastPose = { ...NEUTRAL },
    lastGuide: ReturnType<typeof guideFrame> | undefined,
    lastFrame: TelemetryMessage | null = null;
  let manual: Awaited<ReturnType<typeof openManual>> | undefined,
    target = { ...NEUTRAL },
    tipFree = true;
  let drag:
    | { pointer: number; id: HandleId; x: number; y: number; pose: HumanArtic }
    | undefined;
  const status = () => el(mode + "-status");
  const stopButton = () =>
    el(mode + "-form").querySelector<HTMLButtonElement>(".stop")!;
  const analysis = utteranceView(inspect, () => void resume());
  const length = (take: Utterance) => take.samples.length / take.rate;

  function draw(
    pose: HumanArtic,
    dt = 0,
    guide?: ReturnType<typeof guideFrame>,
    frame: TelemetryMessage | null = null,
  ) {
    lastPose = pose;
    lastGuide = guide;
    lastFrame = frame;
    const u = frame?.t.flow.at(-1);
    lipFlow.textContent = u === undefined ? "—" : u.toFixed(1);
    stage.draw(pose, dt, guide, frame);
  }
  function progressAt(fraction: number) {
    const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    progress.style.setProperty("--progress", percent + "%");
    progress.setAttribute("aria-valuenow", String(percent));
  }
  function stop() {
    clearWordAudio();
    job?.abort();
    job = undefined;
    manual = undefined;
    if (drag && canvas.hasPointerCapture(drag.pointer))
      canvas.releasePointerCapture(drag.pointer);
    drag = undefined;
    cancelAnimationFrame(raf);
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = undefined;
    }
    stage.film = null;
    el("film-effect").textContent = el("film-reading").textContent = "";
    stopButton().disabled = true;
  }
  function idle() {
    stop();
    stage.resetTrails();
    status().textContent = "";
    title.textContent = "대기";
    phones.textContent = stage.manualPart
      ? "조작할 부위를 선택하세요."
      : "발음 기호";
    progressAt(0);
    draw(stage.manualPart ? target : { ...NEUTRAL });
  }
  function symbols(take: Utterance) {
    phones.replaceChildren(
      ...take.segments.map((s) => {
        const span = document.createElement("span");
        span.textContent = s.displayIpa ?? s.ipa;
        return span;
      }),
    );
  }
  function snapshot(take: Utterance, t: number, dt = 0) {
    const sample = playbackAt(take, t);
    draw(sample.pose, dt, undefined, sample.telemetry);
    const i = take.segments.findIndex((s) => s.start <= t && t < s.end);
    const old = phones.querySelector(".active"),
      active = phones.children[i];
    if (active !== old) {
      old?.classList.remove("active");
      active?.classList.add("active");
    }
    progressAt(t / length(take));
    if (mode === "tts") {
      position = t;
      analysis.render(t, sample.telemetry);
    }
  }
  function inspect(t: number) {
    if (mode !== "tts" || !ttsTake) return;
    stop();
    stage.resetTrails();
    snapshot(ttsTake, Math.max(0, Math.min(t, length(ttsTake))));
    title.textContent = "구간 확인";
    status().textContent = "선택한 시각의 성도와 성대입니다.";
  }
  function play(take: Utterance, active: AbortSignal, offset = 0) {
    active.throwIfAborted();
    symbols(take);
    stage.film = null;
    el("film-effect").textContent = el("film-reading").textContent = "";
    stage.resetTrails();
    stopButton().disabled = false;
    title.textContent = status().textContent = "발화 중";
    let previous = offset;
    function paint(t: number) {
      snapshot(take, t, Math.min(0.05, Math.max(0, t - previous)));
      previous = t;
    }
    function finish() {
      cancelAnimationFrame(raf);
      snapshot(take, length(take));
      job = undefined;
      stopButton().disabled = true;
      title.textContent = "완료";
      status().textContent = "재생 완료";
    }
    if (mode === "prepare" && animation === "auto") {
      // Both the interpolation and sampled pressure/flow follow the pitch-preserving media clock.
      wordAudio.playbackRate = speechSpeed;
      wordAudio.onended = () => {
        clearWordAudio();
        finish();
      };
      const tick = () => {
        if (active.aborted || !wordUrl) return;
        paint(wordAudio.currentTime);
        raf = requestAnimationFrame(tick);
      };
      void wordAudio.play().catch((e) => failure(active, e));
      tick();
      return;
    }
    if (bufferTake !== take || !buffer) {
      buffer = ctx!.createBuffer(1, take.samples.length, take.rate);
      buffer.copyToChannel(take.samples, 0);
      bufferTake = take;
    }
    const node = ctx!.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx!.destination);
    source = node;
    const began = ctx!.currentTime - offset;
    const tick = () => {
      if (source !== node) return;
      paint(Math.min(length(take), Math.max(offset, ctx!.currentTime - began)));
      raf = requestAnimationFrame(tick);
    };
    node.onended = () => {
      if (source !== node) return;
      node.disconnect();
      source = undefined;
      finish();
    };
    node.start(0, offset);
    tick();
  }
  function failure(active: AbortSignal, e: unknown) {
    if (active.aborted) return;
    idle();
    status().textContent = e instanceof Error ? e.message : String(e);
  }
  async function resume() {
    if (!ttsTake || mode !== "tts" || !ctx) return;
    stop();
    const active = (job = new AbortController());
    try {
      await ctx.resume();
      active.signal.throwIfAborted();
      play(ttsTake, active.signal, position >= length(ttsTake) ? 0 : position);
    } catch (e) {
      failure(active.signal, e);
    }
  }
  function animate(take: Utterance, signal: AbortSignal) {
    const film = animation === "film",
      reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!film) {
      wordUrl = speechUrl(take);
      wordAudio.src = wordUrl;
      wordAudio.preservesPitch = true;
      wordAudio.load();
    }
    const targetPose = playbackAt(take, 0).pose,
      steps = reduce ? [] : movingParts(targetPose);
    const total = film ? 8 : steps.length * STEP_SECONDS + HOLD_SECONDS;
    const vowel = take.segments.find((s) => s.kind === "vowel");
    const first = take.segments[0];
    const from = Math.max(0, first.start - 0.02);
    const until = vowel ? (vowel.start + vowel.end) / 2 : first.end;
    let previous = performance.now(),
      elapsed = 0;
    title.textContent = film ? "공기의 여정" : "첫소리 준비";
    phones.textContent = film ? "" : "첫소리  /" + take.first + "/";
    const tick = (now: number) => {
      if (signal.aborted) return;
      const dt = Math.max(0, (now - previous) / 1000);
      previous = now;
      elapsed += film ? dt * filmSpeed : dt;
      if (elapsed >= total) {
        try {
          play(take, signal);
        } catch (error) {
          failure(signal, error);
        }
        return;
      }
      if (film) {
        const fraction = elapsed / total,
          index = Math.min(3, Math.floor(fraction * 4));
        const playbackFraction = reduce ? index / 3 : fraction;
        const sampleTime = from + (until - from) * playbackFraction;
        const shot = playbackAt(take, sampleTime);
        const phone = take.segments.find(
          (s) => s.start <= sampleTime && sampleTime < s.end,
        );
        phones.textContent =
          "발화 " +
          sampleTime.toFixed(3) +
          "초" +
          (phone
            ? " · /" + (phone.displayIpa ?? phone.ipa) + "/"
            : " · 날숨 준비");
        stage.film = reduce ? index / 4 : fraction;
        draw(
          shot.pose,
          reduce ? 0 : Math.min(0.05, dt),
          undefined,
          shot.telemetry,
        );
        title.textContent = index + 1 + " / 4 · " + filmShots[index][0];
        if (el("film-effect").textContent !== filmShots[index][1]) {
          el("film-effect").textContent = filmShots[index][1];
          status().textContent = "공기의 여정 · " + filmShots[index][0];
        }
        el("film-reading").textContent = stage.filmReading;
      } else {
        const guide = guideFrame(targetPose, steps, elapsed);
        status().textContent = guide.part
          ? guide.part.name +
            " 위치 잡기 · " +
            (guide.index + 1) +
            " / " +
            steps.length
          : "첫 입모양 준비 완료";
        draw(
          reduce ? targetPose : guide.pose,
          Math.min(0.05, dt),
          reduce ? undefined : guide,
        );
      }
      progressAt(elapsed / total);
      raf = requestAnimationFrame(tick);
    };
    tick(previous);
  }
  function configure() {
    const direct = mode === "prepare" && animation === "manual";
    stage.manualPart = direct ? (part.value as HandleId) : null;
    // Full head keeps both the glottis and lips in reach during direct manipulation.
    stage.closeUp = mode === "prepare" && animation === "auto";
    canvas.tabIndex = direct ? 0 : -1;
    canvas.classList.toggle("interactive", direct);
    el("speed-label").textContent =
      animation === "film" ? "경로 탐색 속도" : "발화 속도";
    speed.value = String(animation === "film" ? filmSpeed : speechSpeed);
    el("speed-read").textContent = speed.value + "×";
    el("manual-controls").hidden = animation !== "manual";
    el("word-controls").hidden = animation === "manual";
    el("film-reading").hidden = mode !== "prepare" || animation !== "film";
    el("film-reading").textContent = "";
    el("prepare-start").textContent =
      animation === "manual" ? "실시간 발성" : "진행";
    el("mode-hint").textContent = {
      auto: "첫 입모양이 완성되면 단어를 읽습니다. 발화 속도를 바꾸면 말소리와 입 움직임이 함께 느려지거나 빨라집니다.",
      manual:
        "단면의 색점을 끌면 발성이 시작됩니다. 부위를 선택한 뒤 단면에서 방향키로도 움직일 수 있습니다.",
      film: "단어의 첫소리부터 모음까지 느리게 펼쳐 봅니다. 밝은 점은 관찰 위치이며, 각 위치의 압력과 기류는 합성 모델의 계산값입니다. 마지막에 단어를 들려줍니다.",
    }[animation];
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]"))
      b.setAttribute("aria-pressed", String(b.dataset.mode === animation));
  }
  function show(next: StudioMode) {
    stop();
    mode = next;
    el(next + "-form")
      .querySelector(".transport")!
      .before(el("studio-voice-field"));
    el(next + "-work").append(view);
    stage.setBody(PRESETS[voice()]);
    configure();
    idle();
    if (next === "tts" && ttsTake) {
      symbols(ttsTake);
      inspect(position);
    }
  }
  async function start() {
    idle();
    const active = (job = new AbortController()),
      signal = active.signal;
    try {
      if (mode === "prepare" && animation === "manual") {
        stopButton().disabled = false;
        status().textContent = "실시간 음성 엔진을 여는 중…";
        let previous = performance.now();
        const live = await openManual(
          voice(),
          signal,
          (f) => {
            const now = performance.now();
            draw(
              VoiceModel.articFromArray(f.t.artic),
              Math.min(0.05, (now - previous) / 1000),
              undefined,
              f,
            );
            previous = now;
          },
          (e) => failure(signal, e),
        );
        signal.throwIfAborted();
        manual = live;
        live.pose(target, tipFree);
        live.breath(Number(breath.value));
        title.textContent = "직접 조작";
        status().textContent = "실시간 발성 중";
        phones.textContent = "조작 부위 · " + part.selectedOptions[0].text;
        return;
      }
      const field = el<HTMLInputElement>(mode + "-input");
      let text: string;
      try {
        text = validateInput(field.value, mode === "prepare");
        field.removeAttribute("aria-invalid");
      } catch (e) {
        field.setAttribute("aria-invalid", "true");
        field.focus();
        throw e;
      }
      ctx ??= new AudioContext();
      const ready = ctx.resume();
      stopButton().disabled = false;
      status().textContent = "음성을 합성하는 중…";
      title.textContent = "합성 중";
      const [take] = await Promise.all([
        synthesize(
          text,
          mode === "prepare" && animation === "auto",
          signal,
          voice(),
          undefined,
          STUDIO_CONDITION,
        ),
        ready,
      ]);
      signal.throwIfAborted();
      if (mode === "tts") {
        ttsTake = take;
        analysis.set(take);
        play(take, signal);
      } else animate(take, signal);
    } catch (e) {
      failure(signal, e);
    }
  }
  function movePart(id: HandleId, origin: HumanArtic, dx: number, dy: number) {
    target = stage.move(id, origin, dx, dy);
    if (id === "tip") tipFree = false;
    manual?.pose(target, tipFree);
    if (!manual) draw(target);
  }
  canvas.onpointerdown = (e) => {
    if (!stage.manualPart || drag) return;
    const box = canvas.getBoundingClientRect(),
      id = stage.pick(e.clientX - box.left, e.clientY - box.top);
    if (!id) return;
    if (!job) void start();
    part.value = id;
    part.dispatchEvent(new Event("change"));
    canvas.focus();
    drag = {
      pointer: e.pointerId,
      id,
      x: e.clientX,
      y: e.clientY,
      pose: { ...lastPose },
    };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  canvas.onpointermove = (e) => {
    if (drag?.pointer === e.pointerId)
      movePart(drag.id, drag.pose, e.clientX - drag.x, e.clientY - drag.y);
  };
  canvas.onlostpointercapture = () => {
    drag = undefined;
  };
  canvas.onkeydown = (e) => {
    if (!stage.manualPart) return;
    const direction: Record<string, [number, number]> = {
      ArrowUp: [0, -8],
      ArrowDown: [0, 8],
      ArrowLeft: [-8, 0],
      ArrowRight: [8, 0],
    };
    if (!direction[e.key]) return;
    e.preventDefault();
    if (!job) void start();
    movePart(stage.manualPart, lastPose, ...direction[e.key]);
  };
  part.onchange = () => {
    stage.manualPart = part.value as HandleId;
    phones.textContent = "조작 부위 · " + part.selectedOptions[0].text;
    draw(lastPose, 0, undefined, lastFrame);
  };
  speed.oninput = () => {
    if (animation === "film") filmSpeed = Number(speed.value);
    else {
      speechSpeed = Number(speed.value);
      if (wordUrl) wordAudio.playbackRate = speechSpeed;
    }
    el("speed-read").textContent = speed.value + "×";
  };
  breath.oninput = () => {
    el("breath-read").textContent = Number(breath.value).toFixed(1) + " cmH₂O";
    manual?.breath(Number(breath.value));
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]"))
    b.onclick = () => {
      if (b.dataset.mode === animation) return;
      stop();
      animation = b.dataset.mode as AnimationMode;
      configure();
      idle();
    };
  for (const id of ["tts", "prepare"] as const) {
    const form = el<HTMLFormElement>(id + "-form"),
      field = el<HTMLInputElement>(id + "-input");
    form.onsubmit = (e) => {
      e.preventDefault();
      void start();
    };
    form.querySelector<HTMLButtonElement>(".stop")!.onclick = () => {
      if (mode === "tts" && ttsTake && source) inspect(position);
      else idle();
      status().textContent = "정지했습니다.";
    };
    field.oninput = () => {
      field.removeAttribute("aria-invalid");
      if (id === "tts") {
        ttsTake = undefined;
        analysis.set();
      }
      idle();
    };
    for (const b of form.querySelectorAll<HTMLButtonElement>(
      ".suggestions button",
    ))
      b.onclick = () => {
        field.value = b.textContent!;
        field.dispatchEvent(new Event("input"));
        field.focus();
      };
    el<HTMLButtonElement>(id + "-start").disabled = false;
  }
  voiceSelect.onchange = () => {
    ttsTake = undefined;
    analysis.set();
    target = { ...NEUTRAL };
    tipFree = true;
    stage.setBody(PRESETS[voice()]);
    idle();
  };
  new ResizeObserver(() =>
    stage.draw(lastPose, 0, lastGuide, lastFrame),
  ).observe(canvas);
  window.addEventListener("pagehide", stop);
  return { show, stop };
}
