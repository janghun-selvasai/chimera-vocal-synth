import { call, chimeraModule } from "../wasm/chimera.ts";
import type { HumanArtic, VoiceSource } from "../wasm/types.ts";
import { PRESETS } from "../ui/body.ts";
import type {
  BodyName,
  FromWorklet,
  TelemetryMessage,
  ToWorklet,
} from "../worklet/protocol.ts";

/** A manual session owns its audio thread. Closing it also frees its engine on tab changes. */
export async function openManual(
  body: BodyName,
  signal: AbortSignal,
  onFrame: (frame: TelemetryMessage) => void,
  onError: (error: Error) => void,
) {
  const ctx = new AudioContext({
    sampleRate: 48000,
    latencyHint: "interactive",
  });
  const close = () => {
    if (ctx.state !== "closed") void ctx.close();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    await ctx.resume();
    signal.throwIfAborted();
    const inline = document.getElementById("worklet-data")?.textContent;
    const url = inline
      ? "data:text/javascript;base64," + inline.trim()
      : (await import("../worklet/processor.ts?worker&url")).default;
    await ctx.audioWorklet.addModule(url);
    signal.throwIfAborted();
    const node = new AudioWorkletNode(ctx, "chimera", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { module: chimeraModule() },
    });
    const send = (msg: ToWorklet) => node.port.postMessage(msg);
    node.port.onmessage = ({ data }: MessageEvent<FromWorklet>) => {
      if (signal.aborted) return;
      if (data.type === "telemetry") onFrame(data);
      if (data.type === "error") onError(new Error(data.message));
    };
    node.onprocessorerror = () =>
      onError(new Error("실시간 음성 엔진이 중단되었습니다."));
    signal.addEventListener(
      "abort",
      () => {
        node.port.onmessage = null;
        node.disconnect();
        node.port.close();
      },
      { once: true },
    );
    const profile = call<VoiceSource>("koSpeaker", { body });
    send({ type: "body", body: PRESETS[body] });
    send({
      type: "source",
      values: { f0: profile.f0, brightness: profile.brightness, voiced: true },
    });
    node.connect(ctx.destination);
    return {
      pose(values: HumanArtic, tipFree: boolean) {
        send({ type: "artic", values, tipFree });
      },
      breath(pressure: number) {
        send({ type: "source", values: { pressure } });
        send({ type: "gate", level: pressure > 0 ? 1 : 0 });
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", close);
    close();
    throw error;
  }
}
