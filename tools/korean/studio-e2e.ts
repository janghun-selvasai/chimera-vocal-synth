/** Run against a built Korean demo. Usage: bun tools/korean/studio-e2e.ts [url] */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5318/korean.html";
const browser = await chromium.launch({ headless: true });
try {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const page = await browser.newPage({ reducedMotion });
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(url);
    await page.locator("#tts-start:enabled").waitFor();
    // A changing flow number alone does not prove the particles reach the canvas.
    const particleInk = await page.locator("#live-head").evaluateHandle(element => {
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
          probe.setTransform(new DOMMatrix().scale(mirror.width / canvas.width, mirror.height / canvas.height).multiply(ctx.getTransform()));
          probe.lineWidth = ctx.lineWidth;
          probe.stroke(path);
          if (probe.getImageData(0, 0, mirror.width, mirror.height).data.some((v, i) => i % 4 === 3 && v > 10)) {
            ink.add(panel);
            probe.reset();
          }
        }
        if (path) stroke(path); else stroke();
      };
      return ink;
    });
    await page.getByRole("tab", { name: "첫 입모양" }).click();
    const voice = reducedMotion === "reduce" ? "child" : "female";
    await page.getByRole("combobox", { name: "음색", exact: true }).selectOption(voice);
    await page.locator("#prepare-input").fill("국물");
    const flow = await page.locator("#lip-flow").evaluateHandle(node => {
      const values: number[] = [];
      new MutationObserver(() => {
        const value = Number(node.textContent);
        if (Number.isFinite(value)) values.push(value);
      }).observe(node, { childList: true });
      return values;
    });
    // Keep every announcement, including a drag step shown for just the first animation frame.
    const changes = await page.locator("#prepare-status").evaluateHandle(status => {
      const history: string[] = [];
      new MutationObserver(() => history.push(status.textContent ?? "")).observe(status, { childList: true });
      return history;
    });
    await page.getByRole("button", { name: "진행", exact: true }).click();
    await page.locator("#prepare-status", { hasText: "재생 완료" }).waitFor();
    const history = await changes.jsonValue();
    assert.equal(history.some(s => s.includes("위치 잡기")), reducedMotion === "no-preference");
    assert.ok(history.includes("첫 입모양 준비 완료"));
    assert.ok(history.includes("발화 중"));
    await page.getByRole("tab", { name: "텍스트 읽기" }).click();
    const wordFlow = await flow.evaluate(values => values.splice(0));
    assert.ok(wordFlow.some(u => Math.abs(u) > 1));
    assert.equal(await page.getByLabel("음색").inputValue(), voice);
    await page.getByLabel("음색").selectOption("male");
    await page.locator("#tts-input").fill("같이 먹어?");
    await page.locator("#tts-start").click();
    await page.locator("#tts-status", { hasText: "재생 완료" }).waitFor();
    const sentenceFlow = await flow.jsonValue();
    assert.ok(sentenceFlow.some(u => Math.abs(u) > 1));
    assert.equal(await page.locator("#lip-flow").textContent(), "—");
    assert.deepEqual(await particleInk.evaluate(ink => [...ink].sort()), ["prepare-panel", "tts-panel"]);
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
