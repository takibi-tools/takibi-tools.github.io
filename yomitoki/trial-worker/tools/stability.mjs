// 同じ文を何度か測って、判定（事・推・意…）と指摘がどれだけ揃うかをモデルごとに数える。
// 本物のページ（yomitoki/free/）を使い、/generate だけをこの場で各社のAPIへつなぐ。
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRequest, droppableParam, isOpenAI, openAIToGemini } from "../src/providers.js";

const PAGE = process.argv[2];
const RUNS = Number(process.env.RUNS || 3);
const QUESTION = "生成AIを使うと、人間の考える力は落ちますか？";
const REPLY = fs.readFileSync(new URL("./stability-sample.txt", import.meta.url), "utf8").trim();
const PRICES = { "gemini-2.5-flash": { in: 0.30, out: 2.50 }, "gpt-6-luna": { in: 0.10, out: 0.50 }, "gpt-6.1-terra": { in: 1.00, out: 5.00 }, "gpt-6.1-sol": { in: 2.00, out: 10.00 }, "chat-latest": { in: 5.00, out: 30.00 } };
const ALL = [
  { model: "gemini-2.5-flash", env: { PROVIDER: "gemini", GEMINI_MODEL: "gemini-2.5-flash", GEMINI_API_KEY: process.env.GEMINI_API_KEY } },
  { model: "gpt-6-luna", env: { PROVIDER: "openai", OPENAI_MODEL: "gpt-6-luna", OPENAI_API_KEY: process.env.OPENAI_API_KEY } },
  { model: "gpt-6.1-terra", env: { PROVIDER: "openai", OPENAI_MODEL: "gpt-6.1-terra", OPENAI_API_KEY: process.env.OPENAI_API_KEY } },
  { model: "gpt-6.1-sol", env: { PROVIDER: "openai", OPENAI_MODEL: "gpt-6.1-sol", OPENAI_API_KEY: process.env.OPENAI_API_KEY } },
  ...["gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.5-chat-latest", "chat-latest"].map(m =>
    ({ model: m, env: { PROVIDER: "openai", OPENAI_MODEL: m, OPENAI_API_KEY: process.env.OPENAI_API_KEY } }))
];
const providers = process.env.MODELS ? ALL.filter(p => process.env.MODELS.split(",").includes(p.model)) : ALL;

async function runOnce(browser, provider) {
  const page = await browser.newPage();
  let inspect = null, usd = 0, calls = 0, errors = []; const tokens = { in: 0, out: 0 };
  await page.route("**/yomitoki/free/free-config.js", r => r.fulfill({ contentType: "application/javascript",
    body: 'window.YOMITOKI_FREE_MODE=true;window.YOMITOKI_TRIAL_ENDPOINT="https://compare.invalid";' }));
  await page.route("https://compare.invalid/**", async route => {
    const req = route.request();
    const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const path = new URL(req.url()).pathname;
    if (path === "/start") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 3, sessionToken: "a".repeat(64) }) });
    if (path === "/finish") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 2 }) });
    const { payload } = JSON.parse(req.postData());
    payload.generationConfig.maxOutputTokens = 8192;
    const dropped = new Set();
    let res;
    for (let i = 0; i < 3; i++) {
      const { url, init } = buildRequest(provider.env, payload, dropped);
      res = await fetch(url, init);
      const drop = await droppableParam(provider.env, res, dropped);
      if (drop) { dropped.add(drop); continue; }
      break;
    }
    calls++;
    const raw = await res.text();
    if (!res.ok) { errors.push(res.status + " " + raw.slice(0, 200)); return route.fulfill({ status: res.status, headers: h, body: raw }); }
    let data = JSON.parse(raw), tin = 0, tout = 0;
    if (isOpenAI(provider.env)) { tin = data.usage?.prompt_tokens || 0; tout = data.usage?.completion_tokens || 0; data = openAIToGemini(data); }
    else { tin = data.usageMetadata?.promptTokenCount || 0; tout = (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0); }
    const p = PRICES[provider.model]; if (p) usd += (tin * p.in + tout * p.out) / 1e6; else usd = NaN;
    tokens.in += tin; tokens.out += tout;
    const schema = payload.generationConfig.responseSchema || {};
    if (!inspect && schema.properties && schema.properties.summary) {
      try { inspect = JSON.parse(data.candidates[0].content.parts.map(x => x.text || "").join("")); } catch (_) {}
    }
    return route.fulfill({ status: 200, headers: h, body: JSON.stringify(data) });
  });
  await page.goto(PAGE);
  await page.check("#mode-ai");
  await page.fill("#question", QUESTION);
  await page.fill("#reply", REPLY);
  const t0 = Date.now();
  await page.click("#run");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 300000 }).catch(() => {});
  const status = ((await page.textContent("#status")) || "").trim();
  const remeasured = ((await page.textContent("#remeasured")) || "").trim();
  await page.close();
  return { inspect, usd, tokens, calls, errors, status, remeasured, seconds: Math.round((Date.now() - t0) / 1000) };
}

const unbalanced = (t) => {
  const pairs = [["「", "」"], ["『", "』"], ["（", "）"]];
  return pairs.some(([a, b]) => t.split(a).length !== t.split(b).length);
};
const browser = await chromium.launch();
let md = `# よみとき：同じ文を${RUNS}回ずつ測ったときの揃い方\n\n文の長さ：${REPLY.length}文字\n\n| モデル | 判定が全回同じ | 指摘が全回同じ | 測り直しの括弧崩れ | 1回の費用 | 1回の時間 |\n|---|---|---|---|---|---|\n`;
const detail = [];
for (const provider of providers) {
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await runOnce(browser, provider));
  const ok = runs.filter(x => x.inspect && Array.isArray(x.inspect.labels));
  const byI = new Map();
  for (const run of ok) for (const l of run.inspect.labels) {
    if (!byI.has(l.i)) byI.set(l.i, []);
    byI.get(l.i).push({ type: l.type, flags: (l.flags || []).slice().sort().join("+") || "なし" });
  }
  const ids = [...byI.keys()].sort((a, b) => a - b);
  const full = ids.filter(i => byI.get(i).length === ok.length);
  const typeSame = full.filter(i => new Set(byI.get(i).map(x => x.type)).size === 1).length;
  const flagSame = full.filter(i => new Set(byI.get(i).map(x => x.flags)).size === 1).length;
  const broken = runs.filter(x => unbalanced(x.remeasured)).length;
  const usd = runs.reduce((a, x) => a + x.usd, 0) / runs.length;
  const sec = Math.round(runs.reduce((a, x) => a + x.seconds, 0) / runs.length);
  const tk = runs.reduce((a, x) => ({ in: a.in + x.tokens.in, out: a.out + x.tokens.out }), { in: 0, out: 0 });
  const cost = Number.isFinite(usd) ? "$" + usd.toFixed(4) : `入力${Math.round(tk.in / runs.length)}・出力${Math.round(tk.out / runs.length)}トークン`;
  md += ok.length ? `| ${provider.model} | ${typeSame}/${full.length}文 | ${flagSame}/${full.length}文 | ${broken}/${runs.length}回 | ${cost} | ${sec}秒 |\n`
                  : `| ${provider.model} | 使えず | | | | |\n`;
  let d = `\n## ${provider.model}\n\n`;
  runs.forEach((x, k) => { d += `- ${k + 1}回目：${x.status}（呼び出し${x.calls}回）${x.errors.length ? " エラー：" + x.errors.join(" / ") : ""}\n`; });
  d += `\n揃わなかった文（文番号：各回の 判定/指摘）\n\n`;
  for (const i of full) {
    const v = byI.get(i);
    if (new Set(v.map(x => x.type + "|" + x.flags)).size > 1) d += `- ${i}：${v.map(x => x.type + "/" + x.flags).join("　")}\n`;
  }
  d += `\n測り直した文（1回目）：${(runs[0].remeasured || "").replace(/\s+/g, " ").slice(0, 600)}\n`;
  detail.push(d);
}
md += detail.join("");
await browser.close();
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
