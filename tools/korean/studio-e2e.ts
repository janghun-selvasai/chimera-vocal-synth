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
    await page.getByRole("tab", { name: "첫 입모양" }).click();
    await page.locator("#prepare-input").fill("국물");
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
    await page.locator("#tts-input").fill("같이 먹어?");
    await page.locator("#tts-start").click();
    await page.locator("#tts-status", { hasText: "재생 완료" }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
