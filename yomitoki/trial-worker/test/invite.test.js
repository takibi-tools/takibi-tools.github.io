import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { InviteQuota } from "../src/index.js";

const ORIGIN = "https://takibi-tools.github.io";
const payload = {
  contents: [{ role: "user", parts: [{ text: "短い検品用の文章" }] }],
  generationConfig: { responseMimeType: "application/json" }
};

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query, ...params) {
    if (query.startsWith("CREATE TABLE")) { db.exec(query); return []; }
    const stmt = db.prepare(query);
    if (query.startsWith("SELECT")) return stmt.all(...params);
    stmt.run(...params);
    return [];
  }};
  const env = {
    TRIAL_ENABLED: "true",
    ALLOWED_ORIGIN: ORIGIN,
    GEMINI_API_KEY: "test-secret-key",
    GEMINI_MODEL: "gemini-test",
    INVITE_CODE: "a-long-unpredictable-invite-secret",
    QUOTA: null
  };
  const object = new InviteQuota({ storage: { sql } }, env);
  env.QUOTA = {
    idFromName(name) { assert.equal(name, "invite-beta-v1"); return "one"; },
    get(_) { return { fetch: (_url, opts) => object.fetch(new Request("https://quota.internal", opts)) }; }
  };
  return { env, db };
}

async function request(env, path, data, origin = ORIGIN) {
  const res = await worker.fetch(new Request("https://example.workers.dev" + path, {
    method: "POST",
    headers: { "Origin": origin, "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }), env);
  return { status: res.status, data: await res.json() };
}

test("招待コード・Originの拒否と、停止中のガード", async () => {
  const { env } = makeEnv();
  let v = await request(env, "/start", { inviteCode: "wrong" });
  assert.equal(v.status, 401);
  v = await request(env, "/start", { inviteCode: env.INVITE_CODE }, "https://evil.example");
  assert.equal(v.status, 403);
  env.TRIAL_ENABLED = "false";
  v = await request(env, "/start", { inviteCode: env.INVITE_CODE });
  assert.equal(v.status, 503);
});

test("招待→測定→完了、二重完了の防止と3回制限", async () => {
  const { env } = makeEnv();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.headers["x-goog-api-key"], "test-secret-key");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.match(options.body, /短い検品用の文章/);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  try {
    for (let n = 0; n < 3; n++) {
      const start = await request(env, "/start", { inviteCode: env.INVITE_CODE });
      assert.equal(start.status, 200);
      const token = start.data.sessionToken;
      assert.match(token, /^[a-f0-9]{64}$/);
      const run = await request(env, "/generate", { sessionToken: token, payload });
      assert.equal(run.status, 200);
      assert.equal(run.data.candidates[0].content.parts[0].text, "{\"ok\":true}");
      const finish = await request(env, "/finish", { sessionToken: token });
      assert.equal(finish.status, 200);
      assert.equal(finish.data.remaining, 2 - n);
      const again = await request(env, "/finish", { sessionToken: token });
      assert.equal(again.data.remaining, 2 - n);
      const reuse = await request(env, "/generate", { sessionToken: token, payload });
      assert.equal(reuse.status, 409);
    }
    const denied = await request(env, "/start", { inviteCode: env.INVITE_CODE });
    assert.equal(denied.status, 429);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = realFetch; }
});

test("503を最大2回再試行し失敗しても成功枠は減らない", async () => {
  const { env } = makeEnv();
  const realFetch = globalThis.fetch;
  let tries = 0;
  globalThis.fetch = async () => { tries++; return new Response("{}", { status: 503 }); };
  try {
    const start = await request(env, "/start", { inviteCode: env.INVITE_CODE });
    const res = await request(env, "/generate", { sessionToken: start.data.sessionToken, payload });
    assert.equal(res.status, 502);
    assert.equal(tries, 3);
    const next = await request(env, "/start", { inviteCode: env.INVITE_CODE });
    assert.equal(next.status, 200);
    assert.equal(next.data.remaining, 3);
  } finally { globalThis.fetch = realFetch; }
});

test("入力サイズとセッション認証の検証", async () => {
  const { env } = makeEnv();
  const start = await request(env, "/start", { inviteCode: env.INVITE_CODE });
  const wrong = await request(env, "/generate", { sessionToken: "a".repeat(64), payload });
  assert.equal(wrong.status, 401);
  const malformed = await request(env, "/generate", {
    sessionToken: start.data.sessionToken,
    payload: { contents: [], generationConfig: { responseMimeType: "application/json" } }
  });
  assert.equal(malformed.status, 400);
});

test("再試行はブラウザの待ち時間内に収まる分だけ行う", async () => {
  const { env } = makeEnv();
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let tries = 0;
  let clock = realNow();
  Date.now = () => clock;
  // 1回目の503が返るまでに70秒かかった想定。残り時間では再試行しない。
  globalThis.fetch = async () => { tries++; clock += 70000; return new Response("{}", { status: 503 }); };
  try {
    const start = await request(env, "/start", { inviteCode: env.INVITE_CODE });
    const res = await request(env, "/generate", { sessionToken: start.data.sessionToken, payload });
    assert.equal(res.status, 502);
    assert.equal(tries, 1);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});
