import type { Session } from "./lab.ts";

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
interface Trial {
  key: string;
  a: string;
  b?: string;
}
export function setupListening(session: Session) {
  const el = (id: string) => document.getElementById(id)!;
  const kind = el("task") as HTMLSelectElement;
  const aa = el("playA") as HTMLButtonElement,
    bb = el("playB") as HTMLButtonElement;
  const sound = new Audio();
  const stop = () => sound.pause();
  const words = ["bul", "pul", "ppul", "dal", "tal", "ttal"];
  const responses: string[][] = [
    ["task", "trial", "target", "A_condition", "B_condition", "response"],
  ];
  let deck: Trial[] = [],
    index = 0;
  const played = new Set<string>();
  function show() {
    stop();
    played.clear();
    const tr = deck[index];
    el("answers").replaceChildren();
    aa.hidden = !tr;
    bb.hidden = !tr?.b;
    el("trial").textContent = tr
      ? `문항 ${index + 1} / ${deck.length}`
      : "이 항목의 청취가 끝났습니다. 응답을 저장할 수 있습니다.";
    if (!tr) return;
    aa.textContent = tr.b ? "A 재생" : "재생";
    const options = tr.b
      ? ["A", "B", "차이 없음"]
      : words
          .slice(
            words.indexOf(tr.key) < 3 ? 0 : 3,
            words.indexOf(tr.key) < 3 ? 3 : 6,
          )
          .map((w) => session[w].text)
          .concat("모르겠음");
    for (const option of options) {
      const b = document.createElement("button");
      b.textContent = option;
      b.disabled = true;
      b.onclick = () => {
        responses.push([
          kind.value,
          String(index + 1),
          session[tr.key].text,
          tr.a,
          tr.b ?? "",
          option,
        ]);
        index++;
        show();
      };
      el("answers").append(b);
    }
  }
  function reset() {
    deck =
      kind.value === "id"
        ? shuffle(
            words.flatMap((key) =>
              ["baseline", "vot", "pitch", "full"].map((a) => ({ key, a })),
            ),
          )
        : shuffle(
            ["statement", "question", "comma", "inside", "rules"].map((key) => {
              const [a, b] = shuffle(["baseline", "full"]);
              return { key, a, b };
            }),
          );
    index = 0;
    show();
  }
  let side = "A";
  sound.onended = () => {
    played.add(side);
    const ready = played.has("A") && (!deck[index]?.b || played.has("B"));
    el("answers")
      .querySelectorAll("button")
      .forEach((b) => (b.disabled = !ready));
  };
  function play(which: "A" | "B") {
    stop();
    const tr = deck[index];
    side = which;
    const takes = session[tr.key].takes,
      take = takes[which === "A" ? tr.a : tr.b!];
    const reference = Math.min(...Object.values(takes).map((v) => v.rms));
    sound.volume = Math.min(1, reference / Math.max(1e-9, take.rms));
    sound.src = "data:audio/wav;base64," + take.wav;
    void sound.play();
  }
  aa.onclick = () => play("A");
  bb.onclick = () => play("B");
  kind.onchange = reset;
  el("save").onclick = () => {
    const escape = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    const url = URL.createObjectURL(
      new Blob(
        ["\ufeff" + responses.map((r) => r.map(escape).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "chimera-korean-listening.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  reset();
  return stop;
}
