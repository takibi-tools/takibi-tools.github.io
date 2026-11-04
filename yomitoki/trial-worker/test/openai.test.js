import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { InviteQuota } from "../src/index.js";
import { toOpenAISchema, openAIToGemini } from "../src/providers.js";

const ORIGIN = "https://takibi-tools.github.io";
// よみとき本体と同じ形のスキーマ
const LABEL_ITEM = { type: "OBJECT",
  properties: { i: { type: "INTEGER" }, type: { type: "STRING", enum: ["事実", "推測"] },
    flags: { type: "ARRAY", items: { type: "STRING", enum: ["根拠なき断定"] } },
    primary: { type: "STRING" }, phrase: { type: "STRING" }, note: { type: "STRING" } },
  required: ["i", "type", "flags"], propertyOrdering: ["i", "type", "flags", "primary", "phrase", "note"] };
const SCHEMA = { type: "OBJECT",
  properties: { labels: { type: "ARRAY", items: LABEL_ITEM }, summary: { type: "STRING" }, remeasured: { type: "STRING" } },
  required: ["labels", "summary", "remeasured"] };
const payload = {
  contents: [{ role: "user", parts: [{ text: "検品してJSONで返す" }] }],
  generationConfig: { responseMimeType: "application/json", temperature: 0, topK: 1, seed: 20261102,
    thinkingConfig: { thinkingBudget: 0 }, responseSchema: SCHEMA }
};
const okBody = (content, extra = {}) => JSON.stringify({ model: "gpt-6-luna",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content }, ...extra }],
  usage: { prompt_tokens: 10, completion_tokens: 5 } });

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query, ...params) {
    if (query.startsWith("CREATE TABLE") || query.startsWith("ALTER TABLE")) { db.exec(query); return []; }
    const stmt = db.prepare(query);
    if (query.startsWith("SELECT")) return stmt.all(...params);
    stmt.run(...params); return [];
  }};
  const env = { TRIAL_ENABLED: "true", OPEN_ACCESS: "true", ALLOWED_ORIGIN: ORIGIN,
    PROVIDER: "openai", OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-6-luna",
    GEMINI_API_KEY: "g-test", GEMINI_MODEL: "gemini-test", QUOTA: null };
  const object = new InviteQuota({ storage: { sql } }, env);
  env.QUOTA = { idFromName: () => "one", get: () => ({ fetch: (_u, o) => object.fetch(new Request("https://quota.internal", o)) }) };
  return env;
}
async function call(env, path, data) {
  const res = await worker.fetch(new Request("https://w.dev" + path, { method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
    body: JSON.stringify(data) }), env);
  return { status: res.status, data: await res.json() };
}
async function withFetch(fake, fn) {
  const real = globalThis.fetch; globalThis.fetch = fake;
  try { await fn(); } finally { globalThis.fetch = real; }
}

test("スキーマ変換：strictの形（全項目required・任意項目はnull可・追加項目なし）", () => {
  const s = toOpenAISchema(SCHEMA);
  assert.equal(s.type, "object");
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ["labels", "summary", "remeasured"]);
  const item = s.properties.labels.items;
  assert.deepEqual(item.required, ["i", "type", "flags", "primary", "phrase", "note"]);
  assert.equal(item.properties.i.type, "integer");
  assert.deepEqual(item.properties.type.enum, ["事実", "推測"]);
  assert.deepEqual(item.properties.note.type, ["string", "null"]);
  assert.equal(item.properties.flags.items.type, "string");
  assert.ok(!JSON.stringify(s).includes("propertyOrdering"));
});

test("OpenAIへの送り方と、Gemini形式への戻し方", async () => {
  const env = makeEnv();
  let sent;
  await withFetch(async (url, opts) => {
    sent = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(okBody(JSON.stringify({ labels: [{ i: 0, type: "事実", flags: [], primary: null, phrase: null, note: null }], summary: "要約", remeasured: "文" })), { status: 200 });
  }, async () => {
    const start = await call(env, "/start", {});
    const res = await call(env, "/generate", { sessionToken: start.data.sessionToken, payload });
    assert.equal(res.status, 200);
    assert.equal(sent.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(sent.headers.Authorization, "Bearer sk-test");
    assert.equal(sent.body.model, "gpt-6-luna");
    assert.equal(sent.body.messages[0].content, "検品してJSONで返す");
    assert.equal(sent.body.response_format.type, "json_schema");
    assert.equal(sent.body.response_format.json_schema.strict, true);
    assert.equal(sent.body.temperature, 0);
    assert.equal(sent.body.seed, 20261102);
    assert.equal(sent.body.reasoning_effort, "none");
    const parsed = JSON.parse(res.data.candidates[0].content.parts[0].text);
    assert.deepEqual(parsed.labels[0], { i: 0, type: "事実", flags: [] }); // nullは消える
    assert.equal(res.data.candidates[0].finishReason, "STOP");
  });
});

test("受け付けない設定項目は外して送り直す", async () => {
  const env = makeEnv();
  const bodies = [];
  await withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body); bodies.push(body);
    if ("temperature" in body) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'", param: "temperature", code: "unsupported_parameter" } }), { status: 400 });
    return new Response(okBody("{\"remeasured\":\"x\",\"labels\":[],\"summary\":\"s\"}"), { status: 200 });
  }, async () => {
    const start = await call(env, "/start", {});
    const res = await call(env, "/generate", { sessionToken: start.data.sessionToken, payload });
    assert.equal(res.status, 200);
    assert.equal(bodies.length, 2);
    assert.ok(!("temperature" in bodies[1]));
    assert.equal(bodies[1].seed, 20261102);
  });
});

test("予算切れ（insufficient_quota）は分かる言葉で返す", async () => {
  const env = makeEnv();
  await withFetch(async () => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "quota" } }), { status: 429 }), async () => {
    const start = await call(env, "/start", {});
    const res = await call(env, "/generate", { sessionToken: start.data.sessionToken, payload });
    assert.equal(res.status, 429);
    assert.match(res.data.error.message, /予算が尽きました/);
  });
});

test("拒否・途中切れの印をGemini形式へ", () => {
  const refused = openAIToGemini({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] });
  assert.equal(refused.candidates[0].finishReason, "SAFETY");
  assert.equal(refused.candidates[0].content.parts.length, 0);
  const cut = openAIToGemini({ choices: [{ finish_reason: "length", message: { content: "{\"a\":" } }] });
  assert.equal(cut.candidates[0].finishReason, "MAX_TOKENS");
  assert.equal(cut.candidates[0].content.parts[0].text, "{\"a\":");
});
