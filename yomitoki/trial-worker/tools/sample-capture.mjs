// 文章全般のサンプル用：本物のGeminiで測り、ページが描いた結果（segments・測り直し・二周目）をそのまま取り出す。
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRequest } from "../src/providers.js";
const PAGE = process.argv[2];
const RUNS = Number(process.env.RUNS || 3);
const env = { PROVIDER: "gemini", GEMINI_MODEL: "gemini-2.5-flash", GEMINI_API_KEY: process.env.GEMINI_API_KEY };
const TEXT = fs.readFileSync(new URL("./sample-general.txt", import.meta.url), "utf8").trim();
const browser = await chromium.launch();
const out = [];
for (let r = 0; r < RUNS; r++) {
  const page = await browser.newPage();
  await page.route("**/yomitoki/index.html", async route => {
    const res = await route.fetch(); let html = await res.text();
    html = html.replace(/render\(result, false, question\.length > 0, mode\);/g, "window.__results=(window.__results||[]).concat([JSON.parse(JSON.stringify(result))]); render(result, false, question.length > 0, mode);");
    return route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-type": "text/html; charset=utf-8" } });
  });
  await page.route("https://yomitoki-free.takibilab.workers.dev/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    if (path === "/start") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 3, sessionToken: "a".repeat(64) }) });
    if (path === "/finish") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 2 }) });
    const { payload } = JSON.parse(req.postData()); payload.generationConfig.maxOutputTokens = 8192;
    const { url, init } = buildRequest(env, payload); const res = await fetch(url, init);
    return route.fulfill({ status: res.status, headers: h, body: await res.text() });
  });
  await page.goto(PAGE + "index.html");
  await page.check("#mode-general");
  await page.fill("#reply", TEXT);
  await page.check("#deepCheck");
  await page.click("#run");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 300000 }).catch(() => {});
  const data = await page.evaluate(() => ({
    results: window.__results || [],
    status: document.getElementById("status").textContent,
    remeasured: document.getElementById("remeasured").textContent,
    finalShown: !document.getElementById("final-block").hidden,
    final: document.getElementById("remeasured-final").textContent,
    recheck: document.getElementById("recheck").innerText
  }));
  out.push(data);
  console.log(`\n===== run ${r + 1} =====\n状態：${data.status}\n測り直し：${data.remeasured}\n最終版：${data.finalShown ? data.final : "（なし）"}\n二周目：${data.recheck.replace(/\s+/g, " ")}`);
  const last = data.results[data.results.length - 1];
  if (last) for (const s of last.segments) console.log(`  [${s.type}] ${(s.flags || []).join("・") || "-"} | ${s.text.slice(0, 40)} | ${s.note || ""}`);
  await page.close();
}
fs.writeFileSync("sample-capture.json", JSON.stringify(out, null, 2));
console.log("\nJSON_BEGIN\n" + JSON.stringify(out) + "\nJSON_END");
await browser.close();
