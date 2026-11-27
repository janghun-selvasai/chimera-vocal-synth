/** Run against a Korean demo built with the three local speaker recordings. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const pageUrl = process.argv[2] ?? "http://127.0.0.1:5318/korean.html";
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pageUrl + "#reference");
  await page.locator("#ref-content:visible").waitFor();
  const audio = page.locator("#ref-audio audio");
  for (const voice of ["male", "female", "child"]) {
    await page.locator("#ref-voice").selectOption(voice);
    for (const id of ["0", "1", "2", "3", "4", "5", "6", "0,1,2", "3,4,5"]) {
      await page.locator("#ref-item").selectOption(id);
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll<HTMLAudioElement>("#ref-audio audio"),
        ].every((a) => a.readyState >= 1 && a.duration > 0),
      );
      if (id.includes(","))
        assert.ok(
          await audio
            .first()
            .evaluate((a) => (a as HTMLAudioElement).duration > 1),
        );
    }
    await page.locator("#ref-item").selectOption("6");
    for (let k = 0; k < 3; k++) {
      await audio.nth(k).evaluate((a) => (a as HTMLAudioElement).play());
      await page.waitForFunction((i) => {
        const a =
          document.querySelectorAll<HTMLAudioElement>("#ref-audio audio");
        return (
          a[i].currentTime > 0 && [...a].filter((s) => !s.paused).length === 1
        );
      }, k);
    }
  }
  await page.locator("#ref-stops summary").click();
  assert.equal(await page.locator("#ref-stops tbody tr").count(), 6);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("tab", { name: "텍스트 읽기" }).click();
  await page.locator("#tts-panel:visible").waitFor();
  assert.ok(
    await audio.evaluateAll((nodes) =>
      nodes.every((a) => (a as HTMLAudioElement).paused),
    ),
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
