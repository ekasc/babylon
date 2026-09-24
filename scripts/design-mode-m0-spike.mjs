#!/usr/bin/env node
// M0 spike: one hand-driven review pass with the existing tool surface semantics.
// Serves a real fixture page, drives Chromium the way sim-tools would
// (open tab, emulate mobile + desktop, settle, screenshot, console + page
// errors, ax + text snapshot), and writes a review bundle to disk.
// Bounded: fixed viewports, fixed settle constants, single pass, no retries.
// Usage: node scripts/design-mode-m0-spike.mjs [--fix]
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = "/tmp/babylon-design-m0";
const FIXED = process.argv.includes("--fix");

// Settle policy under test (constants, not magic — M0 must name these for M1).
const SELECTOR_SIGNAL = "#app[data-ready='true']";
const SELECTOR_TIMEOUT_MS = 8000;
const QUIET_PERIOD_MS = 800;
const NAV_TIMEOUT_MS = 15000;

const VIEWPORTS = [
  {
    id: "chrome-laptop",
    width: 1440,
    height: 900,
    dpr: 2,
    mobile: false,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  },
  {
    id: "iphone",
    width: 393,
    height: 852,
    dpr: 3,
    mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  },
];

// Fixture: brief says hero + pricing + footer. Seeded defects (unless --fix):
//  - pricing section missing entirely
//  - hero padding 8px instead of 48px (wrong spacing)
//  - one console.error + one uncaught page error on load
function fixtureHtml(fixed) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aoi — Tasks</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#111}
.hero{padding:${fixed ? "48px" : "8px"};background:#f4f4f5}
.pricing{padding:32px;background:#fff;border-top:1px solid #e4e4e7}
footer{padding:24px;color:#666}
</style></head><body>
<div id="app" data-ready="false">
<header class="hero"><h1>Aoi task screen</h1><p>Today, three tasks.</p></header>
${fixed ? `<section class="pricing"><h2>Pricing</h2><ul><li>Free</li><li>Pro</li></ul></section>` : `<!-- pricing intentionally missing (seeded defect) -->`}
<footer>Footer</footer>
</div>
<script>
console.error("[fixture] seeded console error: analytics endpoint unreachable");
setTimeout(() => { document.getElementById("app").dataset.ready = "true"; }, 300);
setTimeout(() => { throw new Error("[fixture] seeded page error: null widget config"); }, 100);
</script>
</body></html>`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const html = fixtureHtml(FIXED);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  console.log(`[m0] serving fixture (${FIXED ? "fixed" : "defective"}) at ${url}`);

  const browser = await chromium.launch();
  const bundle = { url, fixed: FIXED, viewports: [] };
  try {
    for (const v of VIEWPORTS) {
      const t0 = Date.now();
      const context = await browser.newContext({
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: v.dpr,
        userAgent: v.ua,
        isMobile: v.mobile,
        hasTouch: v.mobile,
      });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 500));
      });
      page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err).slice(0, 500)));

      const navStart = Date.now();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      // Settle: selector signal + fixed quiet period (mirrors did-stop-loading gap).
      let selectorMs = null;
      try {
        await page.waitForSelector(SELECTOR_SIGNAL, { timeout: SELECTOR_TIMEOUT_MS });
        selectorMs = Date.now() - navStart;
      } catch {
        console.log(`[m0] ${v.id}: selector signal MISSED (${SELECTOR_SIGNAL})`);
      }
      await page.waitForTimeout(QUIET_PERIOD_MS);
      const settleMs = Date.now() - navStart;

      const shotPath = join(OUT, `${FIXED ? "fix" : "base"}-${v.id}.png`);
      await page.screenshot({ path: shotPath });
      const text = ((await page.evaluate("document.body ? document.body.innerText : ''")) ?? "").slice(0, 8000);
      let ax = "";
      try {
        const snap = await page.accessibility.snapshot();
        ax = JSON.stringify(snap).slice(0, 6000);
      } catch {
        ax = "(ax snapshot failed)";
      }
      bundle.viewports.push({
        viewport: v.id,
        width: v.width,
        height: v.height,
        selectorMs,
        settleMs,
        totalMs: Date.now() - t0,
        consoleErrors,
        pageErrors,
        textChars: text.length,
        textHead: text.slice(0, 300),
        axChars: ax.length,
        screenshot: shotPath,
      });
      console.log(`[m0] ${v.id}: settle=${settleMs}ms console=${consoleErrors.length} pageerr=${pageErrors.length} text=${text.length} ax=${ax.length} -> ${shotPath}`);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const outPath = join(OUT, `${FIXED ? "fix" : "base"}-bundle.json`);
  await writeFile(outPath, JSON.stringify(bundle, null, 2));
  console.log(`[m0] bundle -> ${outPath}`);
}

main().catch((e) => {
  console.error("[m0] FAILED:", e?.message ?? e);
  process.exit(1);
});
