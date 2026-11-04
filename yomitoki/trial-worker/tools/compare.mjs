// 無料版の裏側をGeminiとOpenAIで入れ替えたとき、よみとき本体の結果がどう変わるかを並べる。
// 本物のページ（yomitoki/free/）をブラウザで開き、/generate だけをこの場で各社のAPIへつなぐ。
// 使い方: GEMINI_API_KEY=... OPENAI_API_KEY=... node tools/compare.mjs http://localhost:8765/yomitoki/free/
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRequest, droppableParam, isOpenAI, openAIToGemini } from "../src/providers.js";

const PAGE = process.argv[2];
const PRICES = { // 100万トークンあたりのドル（2026-11-04 公式料金表で確認）
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gpt-6-luna": { in: 0.10, out: 0.50 },
  "gpt-6.1-terra": { in: 1.00, out: 5.00 }
};
const providers = [
  { label: "Gemini（gemini-2.5-flash）", env: { PROVIDER: "gemini", GEMINI_MODEL: "gemini-2.5-flash", GEMINI_API_KEY: process.env.GEMINI_API_KEY } },
  { label: "GPT（gpt-6-luna）", env: { PROVIDER: "openai", OPENAI_MODEL: "gpt-6-luna", OPENAI_API_KEY: process.env.OPENAI_API_KEY } }
];
const samples = [
  { name: "転職の相談への返答", mode: "ai", question: "転職するか迷っています。今の会社は安定しているけど、やりたいことができません。",
    reply: "絶対に転職すべきです！あなたなら必ず成功します。調査によると、転職した人の9割が前より幸せになっています。私も以前、同じように悩んで転職し、本当に良かったと思っています。迷っている時間がもったいないですよ。" },
  { name: "発表前の不安への返答", mode: "ai", question: "明日、初めて人前で発表します。うまくいくか不安です。",
    reply: "大丈夫です、明日の発表はきっと大成功します！あなたの発表は会場の誰よりも素晴らしいものになるでしょう。専門家も、準備をした人は100%うまくいくと言っています。自信を持ってください。" },
  { name: "事実だけの返答（引っかけが少ないはず）", mode: "ai", question: "富士山の高さは？",
    reply: "富士山の標高は3776メートルで、日本で一番高い山です。静岡県と山梨県にまたがっています。" },
  { name: "文章全般：投資の宣伝文", mode: "general", question: "",
    reply: "この投資法なら、誰でも確実に資産が倍になります。有名な経済学者も認めた方法で、リスクは一切ありません。今始めない人は必ず後悔します。" }
];

async function runOne(browser, provider, sample) {
  const page = await browser.newPage();
  const calls = [];
  await page.route("**/yomitoki/free/free-config.js", r => r.fulfill({ contentType: "application/javascript",
    body: 'window.YOMITOKI_FREE_MODE=true;window.YOMITOKI_TRIAL_ENDPOINT="https://compare.invalid";' }));
  await page.route("https://compare.invalid/**", async route => {
    const req = route.request();
    const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...h, "Access-Control-Allow-Headers": "Content-Type" } });
    const path = new URL(req.url()).pathname;
    if (path === "/start") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 3, sessionToken: "a".repeat(64) }) });
    if (path === "/finish") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 2 }) });
    const { payload } = JSON.parse(req.postData());
    payload.generationConfig.maxOutputTokens = 8192;
    const t0 = Date.now();
    const dropped = new Set();
    let res;
    for (let i = 0; i < 3; i++) {
      const { url, init } = buildRequest(provider.env, payload, dropped);
      res = await fetch(url, init);
      const drop = await droppableParam(provider.env, res, dropped);
      if (drop) { dropped.add(drop); continue; }
      break;
    }
    const raw = await res.text();
    let body = raw, usage = {};
    if (res.ok) {
      const data = JSON.parse(raw);
      if (isOpenAI(provider.env)) {
        usage = { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens };
        body = JSON.stringify(openAIToGemini(data));
      } else {
        usage = { in: data.usageMetadata?.promptTokenCount, out: (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0) };
      }
    }
    calls.push({ status: res.status, ms: Date.now() - t0, ...usage, dropped: [...dropped], error: res.ok ? "" : raw.slice(0, 300) });
    return route.fulfill({ status: res.ok ? 200 : res.status, headers: h, body });
  });
  await page.goto(PAGE);
  await page.check(sample.mode === "general" ? "#mode-general" : "#mode-ai");
  if (sample.question) await page.fill("#question", sample.question);
  await page.fill("#reply", sample.reply);
  const t0 = Date.now();
  await page.click("#run");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 }).catch(() => {});
  const grab = async (id) => (await page.textContent("#" + id).catch(() => "") || "").replace(/\s+/g, " ").trim();
  const out = { status: await grab("status"), summary: await grab("summary"), findings: await grab("findings"),
    remeasured: await grab("remeasured"), seconds: Math.round((Date.now() - t0) / 1000), calls };
  await page.close();
  return out;
}

const cost = (model, c) => { const p = PRICES[model]; if (!p || !c.in) return 0; return (c.in * p.in + (c.out || 0) * p.out) / 1e6; };
const browser = await chromium.launch();
let md = "# よみとき無料版：Gemini と GPT の比較\n\n";
const totals = {};
for (const sample of samples) {
  md += `## ${sample.name}（${sample.mode === "ai" ? "AIの返答" : "文章全般"}）\n\n`;
  if (sample.question) md += `**質問**：${sample.question}\n\n`;
  md += `**元の文**：${sample.reply}\n\n`;
  for (const provider of providers) {
    const model = providerModelOf(provider);
    const r = await runOne(browser, provider, sample);
    const c = r.calls.reduce((a, x) => a + cost(model, x), 0);
    totals[provider.label] = (totals[provider.label] || { usd: 0, n: 0, sec: 0 });
    totals[provider.label].usd += c; totals[provider.label].n++; totals[provider.label].sec += r.seconds;
    md += `### ${provider.label}\n\n`;
    md += `- 状態：${r.status}\n- かかった時間：${r.seconds}秒／呼び出し${r.calls.length}回／推定 $${c.toFixed(4)}\n`;
    for (const x of r.calls) md += `  - 呼び出し：HTTP ${x.status}、${x.ms}ms、入力${x.in ?? "?"}・出力${x.out ?? "?"}トークン${x.dropped.length ? "、外した設定：" + x.dropped.join(",") : ""}${x.error ? "、エラー：" + x.error : ""}\n`;
    md += `- 総評：${r.summary}\n- 指摘：${r.findings}\n- 測り直した文：${r.remeasured}\n\n`;
  }
}
md += "## まとめ\n\n";
for (const [label, t] of Object.entries(totals)) md += `- ${label}：${t.n}件で推定 $${t.usd.toFixed(4)}（1件あたり $${(t.usd / t.n).toFixed(4)}）、平均${Math.round(t.sec / t.n)}秒\n`;
await browser.close();
function providerModelOf(p) { return isOpenAI(p.env) ? p.env.OPENAI_MODEL : p.env.GEMINI_MODEL; }
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
fs.writeFileSync("compare-result.md", md);
