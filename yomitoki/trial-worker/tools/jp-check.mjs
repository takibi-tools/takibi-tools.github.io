// 日本語版：同じ文を何度か測り、判定の揃い方と書き直し（ぼかしの残り）をまとめて見る。
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRequest } from "../src/providers.js";
const PAGE = process.argv[2];
const RUNS = Number(process.env.RUNS || 3);
const env = { PROVIDER: "gemini", GEMINI_MODEL: "gemini-2.5-flash", GEMINI_API_KEY: process.env.GEMINI_API_KEY };
const read = f => fs.readFileSync(new URL("./" + f, import.meta.url), "utf8").trim();
const cases = [
  { name: "早起きのインプ稼ぎ投稿・文章全般", mode: "general", question: "", text: read("sample-general.txt") },
  { name: "長い回答文・AIの返答", mode: "ai", question: "生成AIを使うと、人間の考える力は落ちますか？", text: read("stability-sample.txt") },
  { name: "長い回答文・文章全般", mode: "general", question: "", text: read("stability-sample.txt") }
];
const HEDGE = /という話を聞くこともあ|という話もあ|と言われることもあ|という声もあ|という見方もあ|と考える(人|方)もいるかもしれ|言及されている(もの|こと)もあ|一部の(研究|企業|専門家|調査)|一部では|可能性を秘め/g;
const browser = await chromium.launch();
let md = "# 日本語版の確認\n";
for (const c of cases) {
  const runs = [];
  for (let r = 0; r < RUNS; r++) {
    const page = await browser.newPage();
    await page.route("**/yomitoki/index.html", async route => {
      const res = await route.fetch(); let html = await res.text();
      html = html.replace(/render\(result, false, question\.length > 0, mode\);/g, "window.__results=(window.__results||[]).concat([JSON.parse(JSON.stringify(result))]); render(result, false, question.length > 0, mode);");
      return route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-type": "text/html; charset=utf-8" } });
    });
    let calls = 0;
    await page.route("https://yomitoki-free.takibilab.workers.dev/**", async route => {
      const req = route.request(); const path = new URL(req.url()).pathname;
      const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
      if (path === "/start") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 3, sessionToken: "a".repeat(64) }) });
      if (path === "/finish") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 2 }) });
      calls++;
      const { payload } = JSON.parse(req.postData()); payload.generationConfig.maxOutputTokens = 8192;
      const { url, init } = buildRequest(env, payload); const res = await fetch(url, init);
      return route.fulfill({ status: res.status, headers: h, body: await res.text() });
    });
    await page.goto(PAGE + "index.html");
    await page.check(c.mode === "general" ? "#mode-general" : "#mode-ai");
    if (c.question) await page.fill("#question", c.question);
    await page.fill("#reply", c.text);
    await page.check("#deepCheck");
    await page.click("#run");
    await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 300000 }).catch(() => {});
    const d = await page.evaluate(() => ({ results: window.__results || [], status: document.getElementById("status").textContent,
      first: document.getElementById("remeasured").textContent, finalShown: !!document.querySelector("#history .ver"),
      final: (function(){ var v = document.querySelectorAll("#history .ver"); return v.length ? v[v.length-1].querySelector(".remeasured-text").textContent : ""; })(),
      recheck: (document.getElementById("history").innerText + " " + document.getElementById("recheck").innerText),
      finalCheck: "" }));
    d.calls = calls; runs.push(d); await page.close();
  }
  const sets = runs.map(r => (r.results[0] || { segments: [] }).segments.map(s => s.type + "/" + ((s.flags || []).slice().sort().join("+") || "なし")));
  const n = Math.max(...sets.map(x => x.length));
  let same = 0; for (let i = 0; i < n; i++) if (new Set(sets.map(x => x[i])).size === 1) same++;
  md += `\n## ${c.name}\n\n判定（区分と指摘）が全回同じ：${same}/${n}文\n`;
  runs.forEach((r, k) => {
    const last = r.finalShown ? r.final : r.first;
    const hedges = [...new Set((last.match(HEDGE) || []))];
    md += `\n### ${k + 1}回目（呼び出し${r.calls}回）\n- 状態：${r.status}\n- 最終版：${r.finalShown ? "あり" : "なし"}\n- 最後に残った文のぼかし：${hedges.length ? hedges.join("、") : "なし"}\n- 二周目：${r.recheck.replace(/\s+/g, " ").slice(0, 260)}\n${r.finalShown ? "- 最終版の確認：" + r.finalCheck.replace(/\s+/g, " ").slice(0, 200) + "\n" : ""}- 一回目：${r.first.replace(/\s+/g, " ").slice(0, 400)}\n${r.finalShown ? "- 最終版：" + r.final.replace(/\s+/g, " ").slice(0, 400) + "\n" : ""}`;
  });
}
await browser.close();
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
