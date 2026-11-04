// 英語版よみとき（takibi-lab）を本物のGeminiで一度ずつ測り、表示を確かめる。
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRequest } from "../src/providers.js";
const PAGE = process.argv[2];
const env = { PROVIDER: "gemini", GEMINI_MODEL: "gemini-2.5-flash", GEMINI_API_KEY: process.env.GEMINI_API_KEY };
const samples = [
  { name: "Any text: experience + overgeneralization", mode: "general", question: "",
    reply: "My coworker got promoted after only six months here. Everyone in this industry knows that if you don't change jobs every two years, your career is over. My manager rejected my proposal last week because she doesn't like me." },
  { name: "AI reply: invented experience", mode: "ai", question: "Should I quit my job?",
    reply: "You should definitely quit your job! I quit mine last year and never looked back. Studies show 90% of people who switch careers are happier. You will succeed for sure." }
];
const browser = await chromium.launch();
let md = "# 英語版よみとき：本物のGeminiで確認\n\n";
for (const s of samples) {
  const page = await browser.newPage();
  await page.route("https://yomitoki-free.takibilab.workers.dev/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    if (path === "/start") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 3, sessionToken: "a".repeat(64) }) });
    if (path === "/finish") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 2 }) });
    const { payload } = JSON.parse(req.postData());
    payload.generationConfig.maxOutputTokens = 8192;
    const { url, init } = buildRequest(env, payload);
    const res = await fetch(url, init);
    return route.fulfill({ status: res.status, headers: h, body: await res.text() });
  });
  await page.goto(PAGE);
  await page.check(s.mode === "general" ? "#mode-general" : "#mode-ai");
  if (s.question) await page.fill("#question", s.question);
  await page.fill("#reply", s.reply);
  await page.click("#run");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 }).catch(() => {});
  const g = async (id) => ((await page.textContent("#" + id).catch(() => "")) || "").replace(/\s+/g, " ").trim();
  md += `## ${s.name}\n\n- 元の文：${s.reply}\n- 状態：${await g("status")}\n- 物差し：${await g("result-mode")}\n- 総評：${await g("summary")}\n- 指摘：${await g("findings")}\n- 題：${await g("remeasured-title")}\n- 測り直した文：${await g("remeasured")}\n- 二周目：${await g("recheck")}\n\n`;
  await page.close();
}
await browser.close();
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
