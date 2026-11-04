// AIの呼び出し先ごとの差を、ここだけに閉じ込める。
// ブラウザ側（よみとき本体）は常にGemini形式で送り、Gemini形式の答えを受け取る。
// PROVIDER=openai のときは、送る前にOpenAI形式へ直し、答えをGemini形式へ戻す。

export const isOpenAI = (env) => env.PROVIDER === "openai";
export const providerKey = (env) => isOpenAI(env) ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
export const providerModel = (env) => isOpenAI(env) ? env.OPENAI_MODEL : env.GEMINI_MODEL;
export const providerName = (env) => isOpenAI(env) ? "OpenAI" : "Gemini";

// 一時的な混雑として、同じ内容で送り直してよい状態コード。
export const retryStatuses = (env) => isOpenAI(env) ? [500, 502, 503] : [503];

// モデルが受け付けなかったときに外して送り直してよい項目。
const DROPPABLE = ["temperature", "seed", "reasoning_effort"];

// Gemini形式のresponseSchemaを、OpenAIのStructured Outputs（strict）の形に直す。
// strictでは全項目がrequiredで、追加の項目を許さない。元が任意の項目は null も許す形にし、
// 答えを戻すときに null を取り除く（ブラウザ側は「項目なし」として扱える）。
export function toOpenAISchema(schema, optional = false) {
  if (!schema || typeof schema !== "object") return {};
  const type = String(schema.type || "").toLowerCase();
  const out = {};
  if (type === "object") {
    const props = schema.properties || {};
    const order = Array.isArray(schema.propertyOrdering) ? schema.propertyOrdering : [];
    const keys = [...order.filter(k => k in props), ...Object.keys(props).filter(k => !order.includes(k))];
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    out.type = "object";
    out.properties = {};
    for (const key of keys) out.properties[key] = toOpenAISchema(props[key], !required.has(key));
    out.required = keys;
    out.additionalProperties = false;
  } else if (type === "array") {
    out.type = "array";
    out.items = toOpenAISchema(schema.items || { type: "STRING" });
  } else {
    out.type = type || "string";
    if (Array.isArray(schema.enum)) out.enum = [...schema.enum];
  }
  if (typeof schema.description === "string") out.description = schema.description;
  if (optional) {
    out.type = [out.type, "null"];
    if (out.enum) out.enum.push(null);
  }
  return out;
}

export function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return value;
}

export function buildRequest(env, payload, dropped = new Set()) {
  if (!isOpenAI(env)) {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(env.GEMINI_MODEL) + ":generateContent",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(payload)
      }
    };
  }
  const config = payload.generationConfig || {};
  const body = {
    model: env.OPENAI_MODEL,
    messages: [{ role: "user", content: payload.contents[0].parts[0].text }],
    max_completion_tokens: config.maxOutputTokens || 8192,
    reasoning_effort: "none"
  };
  if (Number.isFinite(config.temperature)) body.temperature = config.temperature;
  if (Number.isInteger(config.seed)) body.seed = config.seed;
  body.response_format = config.responseSchema
    ? { type: "json_schema", json_schema: { name: "yomitoki", strict: true, schema: toOpenAISchema(config.responseSchema) } }
    : { type: "json_object" };
  for (const key of dropped) delete body[key];
  return {
    url: "https://api.openai.com/v1/chat/completions",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.OPENAI_API_KEY },
      body: JSON.stringify(body)
    }
  };
}

// 400の中身を見て、外せば通る項目なら名前を返す。
export async function droppableParam(env, response, dropped) {
  if (!isOpenAI(env) || response.status !== 400) return null;
  let err = {};
  try { err = (await response.clone().json()).error || {}; } catch (_) { return null; }
  const text = String(err.param || "") + " " + String(err.message || "");
  for (const key of DROPPABLE) if (!dropped.has(key) && text.includes(key)) return key;
  return null;
}

export async function errorCode(env, response) {
  if (!isOpenAI(env)) return "";
  try { return String(((await response.clone().json()).error || {}).code || ""); } catch (_) { return ""; }
}

// OpenAIの答えを、よみとき本体が読むGemini形式に直す。
export function openAIToGemini(data) {
  const choice = (data && data.choices && data.choices[0]) || {};
  const message = choice.message || {};
  const finishMap = { stop: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };
  let finishReason = finishMap[choice.finish_reason] || "STOP";
  let text = typeof message.content === "string" ? message.content : "";
  if (message.refusal) { finishReason = "SAFETY"; text = ""; }
  if (text) {
    try { text = JSON.stringify(stripNulls(JSON.parse(text))); } catch (_) { /* 途中で切れた等はそのまま渡し、本体側の判定に任せる */ }
  }
  return {
    candidates: [{ content: { role: "model", parts: text ? [{ text }] : [] }, finishReason }],
    usageMetadata: data && data.usage ? {
      promptTokenCount: data.usage.prompt_tokens,
      candidatesTokenCount: data.usage.completion_tokens
    } : undefined,
    modelVersion: data && data.model
  };
}
