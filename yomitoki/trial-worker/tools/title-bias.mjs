// 同じ文で、発言した人の肩書きだけを入れ替えて測り、判定が肩書きで変わるかを数える。
// 本物のページ（yomitoki/free/）を使い、/generate だけをこの場で Gemini へつなぐ。
// 使い方：node tools/title-bias.mjs <ページのURL> [<比較用ページのURL>]
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRequest } from "../src/providers.js";

const PAGES = process.argv.slice(2);
const RUNS = Number(process.env.RUNS || 2);
const ENV = { PROVIDER: "gemini", GEMINI_MODEL: "gemini-2.5-flash", GEMINI_API_KEY: process.env.GEMINI_API_KEY };

// 検証用に作った文（実在の記事ではない）。人物も架空。
const TEMPLATE = [
  "これらと趣は異なるが、SNSで広がっているのが「ぬい活」である。旅先や飲食店でぬいぐるみと一緒に写真を撮り、SNSに投稿する。いい大人がぬいぐるみと出歩く光景は、奇妙と言ってもよいだろう。",
  "「心理学では、ぬいぐるみは〈安心毛布〉の一種と呼ばれます」",
  "そう解説するのは、{WHO}。",
  "「幼い子どもが手放さない毛布や人形のことで、親から離れる不安を和らげる役割があります。普通は成長とともに手放していくものです」（同）",
  "では「ぬい活」に当てはめるとどうか。",
  "「大人がぬいぐるみを持ち歩くのは、心が子どもに戻っている表れです。根っこにあるのは強い孤独感で、家族や恋人がいれば、ぬいぐるみを連れ歩く必要はありません」（同）",
  "また、ぬいぐるみの写真を投稿するのも特徴だが、",
  "「SNSで自分を見せたがる人の根底にあるのは、肥大した自己愛です」（同）"
].join("\n\n");
const TITLES = (process.env.TITLES || "なし,精神科医,社会学者,ジャーナリスト,大学教授,会社員,主婦").split(",");
const who = (t) => t === "なし" ? "山川美穂氏" : t + "の山川美穂氏";
const KEYS = ["心が子どもに戻", "自己愛"];

async function runOnce(browser, pageUrl, text) {
  const page = await browser.newPage();
  const inspects = [];
  const sent = [];
  await page.route("**/yomitoki/free/free-config.js", r => r.fulfill({ contentType: "application/javascript",
    body: 'window.YOMITOKI_FREE_MODE=true;window.YOMITOKI_TRIAL_ENDPOINT="https://bias.invalid";' }));
  await page.route("https://bias.invalid/**", async route => {
    const req = route.request();
    const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const path = new URL(req.url()).pathname;
    if (path === "/start") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 3, sessionToken: "a".repeat(64) }) });
    if (path === "/finish") return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ remaining: 2 }) });
    const { payload } = JSON.parse(req.postData());
    sent.push(JSON.stringify(payload).slice(0, 200000));
    const { url, init } = buildRequest(ENV, payload, new Set());
    let res, raw;
    for (let i = 0; i < 3; i++) { res = await fetch(url, init); raw = await res.text(); if (res.status !== 429 && res.status < 500) break; await new Promise(r => setTimeout(r, 4000)); }
    if (res.ok) {
      try {
        const data = JSON.parse(raw);
        const parsed = JSON.parse(data.candidates[0].content.parts.map(x => x.text || "").join(""));
        inspects.push(parsed);
      } catch (_) {}
    }
    return route.fulfill({ status: res.status, headers: h, body: raw });
  });
  await page.goto(pageUrl);
  await page.check("#mode-general");
  await page.fill("#reply", text);
  await page.click("#run");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 300000 }).catch(() => {});
  // 画面に出た一回目の検品：キーの文ごとの指摘
  const segs = await page.$$eval("#marked .seg", els => els.map(e => ({ text: e.textContent, flag: e.getAttribute("data-display-flag") || "" })));
  const shown = await page.textContent("#marked");
  const status = ((await page.textContent("#status")) || "").trim();
  const leak = sent.some(s => /精神科医|社会学者|ジャーナリスト|大学教授|会社員|主婦/.test(s));
  await page.close();
  const pick = KEYS.map(k => { const s = segs.find(x => x.text.includes(k)); return s ? (s.flag || "なし") : "?"; });
  return { pick, status, leak, shownHasTitle: shown };
}

const browser = await chromium.launch();
let md = "";
for (const pageUrl of PAGES) {
  md += `\n## ${pageUrl}\n\n| 肩書き | 「心が子どもに戻っている」の指摘 | 「自己愛」の指摘 | Geminiに肩書きが渡ったか |\n|---|---|---|---|\n`;
  for (const t of TITLES) {
    const text = TEMPLATE.replace("{WHO}", who(t));
    const runs = [];
    for (let r = 0; r < RUNS; r++) runs.push(await runOnce(browser, pageUrl, text));
    const col = (i) => runs.map(x => x.pick[i]).join(" / ");
    const leak = t === "なし" ? "—" : runs.map(x => x.leak ? "渡った" : "伏せた").join(" / ");
    md += `| ${t} | ${col(0)} | ${col(1)} | ${leak} |\n`;
    console.log(t, JSON.stringify(runs.map(x => [x.pick, x.status, x.leak])));
    if (t !== "なし" && !runs.every(x => x.shownHasTitle.includes(t))) md += `| （画面に「${t}」が戻っていない回がある） | | | |\n`;
  }
}
await browser.close();
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "# 肩書きの入れ替え測定\n" + md);
