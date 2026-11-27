import { initChimera } from "../wasm/chimera.ts";
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
const get = (id: string) => document.getElementById(id)!;
async function main() {
  const packed = get("engine-data")?.textContent?.trim();
  await initChimera(
    packed ? Uint8Array.from(atob(packed), (c) => c.charCodeAt(0)) : undefined,
  );
  const [{ setupStudio }, { setupSpeakers }] = await Promise.all([
    import("./studio.ts"),
    import("./speakers.ts"),
  ]);
  const studio = setupStudio();
  let speakers: ReturnType<typeof setupSpeakers> | undefined;
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('nav [role="tab"]'),
  );
  function select(id: string) {
    studio.stop();
    speakers?.leave();
    for (const tab of tabs) {
      const selected = tab.id === id;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      get(tab.getAttribute("aria-controls")!).hidden = !selected;
    }
    get("status").hidden = true;
    if (id === "speakers") {
      speakers ??= setupSpeakers();
      speakers.show();
    } else studio.show(id === "prepare" ? "prepare" : "tts");
  }
  const fromHash = () =>
    tabs.find((b) => "#" + b.id === location.hash)?.id ?? "tts";
  for (const [i, tab] of tabs.entries()) {
    tab.onclick = () => {
      if (location.hash === "#" + tab.id) select(tab.id);
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
  window.addEventListener("hashchange", () => select(fromHash()));
  select(fromHash());
}
main().catch((e) => {
  get("status").hidden = false;
  get("status").textContent = "자료를 열 수 없습니다. " + e.message;
});
