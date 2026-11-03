// よみとき招待制ベータ API。秘密のキーは Cloudflare Secret のみで管理する。
// 公開 HTML に Gemini API キー、招待コードを決して埋め込まないこと。
const LIMITS = Object.freeze({
  successesPerDay: 3,
  startsPerDay: 6,
  providerCallsPerDay: 30,
  callsPerSession: 6,
  sessionMinutes: 20,
  maxPromptChars: 40000,
  maxRequestBytes: 70000,
  // ブラウザ側は1呼び出し90秒で打ち切るため、再試行を含めた合計をその内側に収める。
  generateBudgetMs: 80000,
  minAttemptMs: 15000
});

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const fail = (message, status) => reply({ error: { message } }, status);
const tokyoDay = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const hash = async (value) => Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
)).map(x => x.toString(16).padStart(2, "0")).join("");

function equalHash(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function limitedPayload(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.contents) ||
      data.contents.length !== 1 || data.contents[0]?.role !== "user") return null;
  const parts = data.contents[0]?.parts;
  if (!Array.isArray(parts) || parts.length !== 1 ||
      typeof parts[0]?.text !== "string" || parts[0].text.length > LIMITS.maxPromptChars ||
      parts[0].text.length < 1) return null;
  const config = data.generationConfig || {};
  if (config.responseMimeType !== "application/json") return null;
  const configOut = { responseMimeType: "application/json", maxOutputTokens: 8192 };
  if (Number.isFinite(config.temperature)) configOut.temperature = Math.max(0, Math.min(2, config.temperature));
  if (Number.isInteger(config.topK) && config.topK >= 1 && config.topK <= 100) configOut.topK = config.topK;
  if (Number.isInteger(config.seed)) configOut.seed = config.seed;
  if (config.thinkingConfig && Number.isInteger(config.thinkingConfig.thinkingBudget) &&
      config.thinkingConfig.thinkingBudget >= 0 && config.thinkingConfig.thinkingBudget <= 8192) {
    configOut.thinkingConfig = { thinkingBudget: config.thinkingConfig.thinkingBudget };
  }
  if (config.responseSchema) {
    const schemaText = JSON.stringify(config.responseSchema);
    if (schemaText.length > 16000) return null;
    configOut.responseSchema = config.responseSchema;
  }
  return {
    contents: [{ role: "user", parts: [{ text: parts[0].text }] }],
    generationConfig: configOut
  };
}

async function parseSmallJson(request) {
  const raw = await request.text();
  if (raw.length > LIMITS.maxRequestBytes) throw new Error("too large");
  return JSON.parse(raw);
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Vary", "Origin");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGIN || "https://takibi-tools.github.io";
    if (origin !== allowed) return fail("許可されていないアクセスです。", 403);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin);
    if (request.method !== "POST") return withCors(fail("POSTのみ利用できます。", 405), origin);
    if (env.TRIAL_ENABLED !== "true") return withCors(fail("現在、招待制の無料体験は停止中です。", 503), origin);
    if (!env.GEMINI_API_KEY || !env.INVITE_CODE || !env.GEMINI_MODEL || !env.QUOTA) {
      return withCors(fail("無料体験の準備中です。", 503), origin);
    }
    const path = new URL(request.url).pathname;
    if (!["/start", "/generate", "/finish"].includes(path)) {
      return withCors(fail("見つかりません。", 404), origin);
    }
    let body;
    try { body = await parseSmallJson(request); }
    catch (_) { return withCors(fail("送信形式が正しくありません。", 400), origin); }
    const quota = env.QUOTA.get(env.QUOTA.idFromName("invite-beta-v1"));
    let payload;
    if (path === "/start") {
      if (typeof body.inviteCode !== "string" || body.inviteCode.length > 256) {
        return withCors(fail("招待コードを入力してください。", 401), origin);
      }
      const [got, expected] = await Promise.all([hash(body.inviteCode), hash(env.INVITE_CODE)]);
      if (!equalHash(got, expected)) return withCors(fail("招待コードが一致しません。", 401), origin);
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const sessionToken = Array.from(bytes).map(x => x.toString(16).padStart(2, "0")).join("");
      payload = { action: "start", sessionHash: await hash(sessionToken) };
      const response = await quota.fetch("https://quota.internal/", {
        method: "POST", body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (response.ok) result.sessionToken = sessionToken;
      return withCors(reply(result, response.status), origin);
    }
    if (typeof body.sessionToken !== "string" || !/^[a-f0-9]{64}$/.test(body.sessionToken)) {
      return withCors(fail("無料体験の認証が切れました。", 401), origin);
    }
    payload = { action: path === "/finish" ? "finish" : "generate", sessionHash: await hash(body.sessionToken) };
    if (path === "/generate") {
      payload.providerPayload = limitedPayload(body.payload);
      if (!payload.providerPayload) return withCors(fail("送信内容の形式が正しくありません。", 400), origin);
    }
    const response = await quota.fetch("https://quota.internal/", {
      method: "POST", body: JSON.stringify(payload)
    });
    return withCors(response, origin);
  }
};

export class InviteQuota {
  constructor(ctx, env) {
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, starts INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, day TEXT NOT NULL, expires INTEGER NOT NULL, calls INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0)");
  }
  currentDay(day) {
    this.sql.exec("INSERT OR IGNORE INTO days (day) VALUES (?)", day);
    return [...this.sql.exec("SELECT * FROM days WHERE day = ?", day)][0];
  }
  async fetch(request) {
    let data;
    try { data = await request.json(); }
    catch (_) { return fail("不正なリクエストです。", 400); }
    const now = Date.now();
    const day = tokyoDay();
    const counts = this.currentDay(day);
    if (data.action === "start") {
      if (counts.completed >= LIMITS.successesPerDay) return fail("今日の無料測定枠を使い切りました。", 429);
      if (counts.starts >= LIMITS.startsPerDay || counts.calls >= LIMITS.providerCallsPerDay) {
        return fail("本日の試行回数上限に達しました。明日以降に試してください。", 429);
      }
      this.sql.exec("DELETE FROM sessions WHERE expires < ?", now);
      this.sql.exec("UPDATE days SET starts = starts + 1 WHERE day = ?", day);
      this.sql.exec("INSERT INTO sessions (hash, day, expires) VALUES (?, ?, ?)",
        data.sessionHash, day, now + LIMITS.sessionMinutes * 60000);
      return reply({ remaining: Math.max(0, LIMITS.successesPerDay - counts.completed) });
    }
    const session = [...this.sql.exec("SELECT * FROM sessions WHERE hash = ?", data.sessionHash || "")][0];
    if (!session || session.expires < now) return fail("無料体験の有効時間が切れました。もう一度開始してください。", 401);
    if (data.action === "finish") {
      if (session.calls === 0) return fail("測定は実行されていません。", 400);
      if (!session.finished) {
        this.sql.exec("UPDATE sessions SET finished = 1 WHERE hash = ?", data.sessionHash);
        this.sql.exec("UPDATE days SET completed = completed + 1 WHERE day = ?", session.day);
      }
      const row = this.currentDay(session.day);
      return reply({ remaining: Math.max(0, LIMITS.successesPerDay - row.completed) });
    }
    if (data.action !== "generate") return fail("不正な操作です。", 400);
    if (session.finished) return fail("この測定は終了しています。", 409);
    const requestDay = this.currentDay(day);
    if (session.calls >= LIMITS.callsPerSession ||
        requestDay.calls >= LIMITS.providerCallsPerDay) {
      return fail("無料体験の処理上限に達しました。", 429);
    }
    // SQLは同期的にカウントを進め、ネットワーク処理の前に利用枠を確保する。
    this.sql.exec("UPDATE sessions SET calls = calls + 1 WHERE hash = ?", data.sessionHash);
    return this.generate(data.providerPayload);
  }
  async generate(payload) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(this.env.GEMINI_MODEL) + ":generateContent";
    let response;
    const deadline = Date.now() + LIMITS.generateBudgetMs;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // 再試行も実際のAPI送信として計上し、日次上限を厳守する。
        const day = tokyoDay();
        if (this.currentDay(day).calls >= LIMITS.providerCallsPerDay) {
          return fail("本日のAPI利用上限に達しました。", 429);
        }
        this.sql.exec("UPDATE days SET calls = calls + 1 WHERE day = ?", day);
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.env.GEMINI_API_KEY },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))
        });
        if (![503].includes(response.status) || attempt === 2) break;
        const wait = 800 * (2 ** attempt);
        // 待ってから再試行しても時間内に返せないなら、ブラウザが諦めた後に枠だけ消費しないよう打ち切る。
        if (deadline - Date.now() - wait < LIMITS.minAttemptMs) break;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    } catch (_) {
      return fail("Geminiへの通信が完了しませんでした。時間を置いて再試行してください。", 502);
    }
    if (!response.ok) {
      const status = response.status;
      // 利用者へは秘密情報を含み得るGoogle側の詳細エラーを返さない。
      const messages = {
        400: "AIモデルの設定に問題があります。運営者へ知らせてください。",
        401: "運営側のAPI認証に問題があります。",
        403: "運営側のAPI権限に問題があります。",
        404: "利用モデルが見つかりません。運営者へ知らせてください。",
        429: "現在、利用枠が混雑しています。時間を置いて試してください。",
        503: "AIモデルが混雑しています。時間を置いて試してください。"
      };
      return fail(messages[status] || "Gemini側でエラーが発生しました。", status >= 500 ? 502 : status);
    }
    return new Response(response.body, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
}
