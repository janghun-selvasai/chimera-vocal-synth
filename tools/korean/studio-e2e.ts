/** Run against a built Korean demo. Usage: bun tools/korean/studio-e2e.ts [url] */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5318/korean.html";
const browser = await chromium.launch({ headless: true });
try {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const page = await browser.newPage({ reducedMotion });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      // Sample the audio being delivered to the device, including silence after breath is shut off.
      const connect = AudioWorkletNode.prototype.connect;
      AudioWorkletNode.prototype.connect = function (
        this: AudioWorkletNode,
        dest: AudioNode,
      ) {
        const node = this;
        const probe = node.context.createAnalyser();
        connect.call(node, probe as never);
        Object.assign(window, { probe });
        return connect.call(node, dest as never);
      } as typeof connect;
    });
    await page.goto(url);
    await page.locator("#tts-start:enabled").waitFor();
    assert.equal(await page.getByRole("tab").count(), 3);
    assert.equal(await page.locator("#studio-fortis").count(), 0);
    // A changing flow number alone does not prove the particles reach the canvas.
    const particleInk = await page
      .locator("#live-head")
      .evaluateHandle((element) => {
        const canvas = element as HTMLCanvasElement;
        const ctx = canvas.getContext("2d")!;
        const ink = new Set<string>();
        const mirror = document.createElement("canvas");
        mirror.width = 240;
        mirror.height = 180;
        const probe = mirror.getContext("2d", { willReadFrequently: true })!;
        const stroke = ctx.stroke.bind(ctx);
        ctx.stroke = (path?: Path2D) => {
          const panel = canvas.closest('[role="tabpanel"]')!.id;
          if (path && ctx.strokeStyle === "#ffe2a8" && !ink.has(panel)) {
            probe.setTransform(
              new DOMMatrix()
                .scale(
                  mirror.width / canvas.width,
                  mirror.height / canvas.height,
                )
                .multiply(ctx.getTransform()),
            );
            probe.lineWidth = ctx.lineWidth;
            probe.stroke(path);
            if (
              probe
                .getImageData(0, 0, mirror.width, mirror.height)
                .data.some((v, i) => i % 4 === 3 && v > 10)
            ) {
              ink.add(panel);
              probe.reset();
            }
          }
          if (path) stroke(path);
          else stroke();
        };
        return ink;
      });
    await page.getByRole("tab", { name: "애니메이션" }).click();
    const voice = reducedMotion === "reduce" ? "child" : "female";
    await page
      .getByRole("combobox", { name: "음색", exact: true })
      .selectOption(voice);
    await page.locator("#prepare-input").fill("국물");
    const flow = await page.locator("#lip-flow").evaluateHandle((node) => {
      const values: number[] = [];
      new MutationObserver(() => {
        const value = Number(node.textContent);
        if (Number.isFinite(value)) values.push(value);
      }).observe(node, { childList: true });
      return values;
    });
    // Keep every announcement, including a drag step shown for just the first animation frame.
    const changes = await page
      .locator("#prepare-status")
      .evaluateHandle((status) => {
        const history: string[] = [];
        new MutationObserver(() =>
          history.push(status.textContent ?? ""),
        ).observe(status, { childList: true });
        return history;
      });
    await page.getByRole("button", { name: "진행", exact: true }).click();
    await page.locator("#prepare-status", { hasText: "재생 완료" }).waitFor();
    const history = await changes.jsonValue();
    assert.equal(
      history.some((s) => s.includes("위치 잡기")),
      reducedMotion === "no-preference",
    );
    assert.ok(history.includes("첫 입모양 준비 완료"));
    assert.ok(history.includes("발화 중"));
    // Time both phases separately. Only the spoken word should respond to the speed control.
    if (reducedMotion === "no-preference") {
      await page.locator("#prepare-input").fill("하나하나하나");
      const timings = [];
      for (const speed of [0.5, 2]) {
        await page.locator("#guide-speed").fill(String(speed));
        const measured = await page.evaluate(async () => {
          const audio =
            document.querySelector<HTMLAudioElement>("#word-audio")!;
          const status = document.querySelector("#stage-state")!;
          const start =
            document.querySelector<HTMLButtonElement>("#prepare-start")!;
          let preparing = 0;
          const observer = new MutationObserver(() => {
            if (status.textContent === "첫소리 준비")
              preparing = performance.now();
          });
          observer.observe(status, { childList: true });
          const began = new Promise<number>((resolve) =>
            audio.addEventListener(
              "playing",
              () => resolve(performance.now()),
              { once: true },
            ),
          );
          const ended = new Promise<number>((resolve) =>
            audio.addEventListener("ended", () => resolve(performance.now()), {
              once: true,
            }),
          );
          start.click();
          const speech = await began;
          const result = {
            guide: speech - preparing,
            elapsed: (await ended) - speech,
            preservesPitch: audio.preservesPitch,
          };
          observer.disconnect();
          return result;
        });
        assert.ok(measured.preservesPitch);
        timings.push(measured);
      }
      assert.ok(
        Math.abs(timings[0].guide - timings[1].guide) < 400,
        JSON.stringify(timings),
      );
      assert.ok(
        timings[0].elapsed > 3 * timings[1].elapsed,
        JSON.stringify(timings),
      );
      console.log("First-pose and speech durations in ms (0.5x, 2x):", timings);
      await page.locator("#prepare-input").fill("하나하나하나하나하나하나");
      await page.locator("#guide-speed").fill("0.5");
      await page.locator("#prepare-start").click();
      const audio = page.locator("#word-audio");
      await page.waitForFunction(
        "document.querySelector('#word-audio').currentTime > 0.08",
      );
      await page.locator("#guide-speed").fill("2");
      const skew = await audio.evaluate(async (el) => {
        const a = el as HTMLAudioElement;
        // Let the device drain frames already queued at the previous rate.
        await new Promise((r) => setTimeout(r, 400));
        const t = a.currentTime,
          now = performance.now();
        await new Promise((r) => setTimeout(r, 420));
        const cursor =
          Number(
            document
              .querySelector("#stage-progress")!
              .getAttribute("aria-valuenow"),
          ) / 100;
        return {
          rate: ((a.currentTime - t) * 1000) / (performance.now() - now),
          error: Math.abs(a.currentTime / a.duration - cursor),
        };
      });
      assert.ok(
        skew.rate > 1.5 && skew.rate < 2.5 && skew.error < 0.09,
        JSON.stringify(skew),
      );
      await page.locator("#prepare-status", { hasText: "재생 완료" }).waitFor();
    }
    await page.getByRole("tab", { name: "텍스트 읽기" }).click();
    const wordFlow = await flow.evaluate((values) => values.splice(0));
    assert.ok(wordFlow.some((u) => Math.abs(u) > 1));
    assert.equal(
      await page.getByLabel("음색", { exact: true }).inputValue(),
      voice,
    );
    await page.getByLabel("음색", { exact: true }).selectOption("male");
    await page.locator("#tts-input").fill("같이 먹어?");
    await page.locator("#tts-start").click();
    await page.locator("#tts-status", { hasText: "재생 완료" }).waitFor();
    const sentenceFlow = await flow.jsonValue();
    assert.ok(sentenceFlow.some((u) => Math.abs(u) > 1));
    assert.ok(
      Number.isFinite(Number(await page.locator("#lip-flow").textContent())),
    );
    await page.locator("#release").click();
    const burst = Number(await page.locator("#seek").inputValue());
    assert.ok(burst > 0);
    await page.locator("#voice").click();
    assert.ok(Number(await page.locator("#seek").inputValue()) >= burst);
    await page.locator("#resume").click();
    await page.locator("#tts-status", { hasText: "재생 완료" }).waitFor();
    assert.deepEqual(await particleInk.evaluate((ink) => [...ink].sort()), [
      "prepare-panel",
      "tts-panel",
    ]);
    await page.getByRole("tab", { name: "음색 비교" }).click();
    await page.locator("#speaker-controls:visible").waitFor();
    const values = async (selector: string) =>
      (await page.locator(".speaker-card " + selector).allTextContents()).map(
        parseFloat,
      );
    const lengths = await values(".tract"),
      pitches = await values(".pitch");
    assert.equal(lengths.length, 3);
    assert.ok(lengths[0] > lengths[1] && lengths[1] > lengths[2]);
    assert.ok(pitches[0] < pitches[1] && pitches[1] < pitches[2]);
    await page.locator("#speaker-vowel").selectOption({ index: 1 });
    const pictures = () =>
      page
        .locator(".speaker-card canvas")
        .evaluateAll((cs) =>
          cs.map((c) => (c as HTMLCanvasElement).toDataURL()),
        );
    const before = await pictures();
    await page.getByRole("button", { name: "성인 여성 듣기" }).click();
    await page.waitForTimeout(160);
    const during = await pictures();
    assert.equal(
      before[0],
      during[0],
      "male card moved while listening to female",
    );
    assert.notEqual(before[1] === during[1], true, "female card stayed still");
    assert.equal(
      before[2],
      during[2],
      "child card moved while listening to female",
    );
    await page
      .locator("#speaker-status", { hasText: "성인 여성 재생 중" })
      .waitFor();
    await page.getByRole("button", { name: "아동 듣기" }).click();
    await page
      .locator("#speaker-status", { hasText: "아동 재생 완료" })
      .waitFor();
    await page.locator("#speaker-text").fill("시와 씨");
    assert.ok(await page.locator("#speaker-controls").isHidden());
    await page.getByRole("button", { name: "비교하기" }).click();
    await page.locator("#speaker-controls:visible").waitFor();
    await page.getByRole("button", { name: "성인 남성 듣기" }).click();
    await page.getByRole("tab", { name: "애니메이션" }).click();
    await page.locator("#prepare-panel:visible").waitFor();
    assert.ok(await page.locator("#speaker-stop").isDisabled());
    await page.getByRole("button", { name: "공기의 여정" }).click();
    await page.locator("#guide-speed").fill("2");
    await page.locator("#prepare-start").click();
    await page.locator("#film-reading", { hasText: "Pa" }).waitFor();
    await page.locator("#stage-state", { hasText: "입술" }).waitFor();
    await page.locator("#prepare-status", { hasText: "재생 완료" }).waitFor();
    await page.getByRole("button", { name: "직접 조작" }).click();
    await page.locator("#prepare-start").click();
    await page
      .locator("#prepare-status", { hasText: "실시간 발성 중" })
      .waitFor();
    const rms = () => {
      const probe = (window as unknown as { probe: AnalyserNode }).probe;
      const pcm = new Float32Array(probe.fftSize);
      probe.getFloatTimeDomainData(pcm);
      return Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / pcm.length);
    };
    await page.waitForFunction("(" + rms.toString() + ")() > 0.002");
    await page.locator("#manual-part").selectOption("lips");
    await page.locator("#live-head").focus();
    await page.keyboard.press("ArrowDown");
    await page.locator("#breath").fill("0");
    await page.waitForFunction("(" + rms.toString() + ")() < 0.0001");
    await page.locator("#breath").fill("9");
    await page.waitForFunction("(" + rms.toString() + ")() > 0.002");
    await page.locator("#tts").click();
    await page.waitForFunction("window.probe.context.state === 'closed'");
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
