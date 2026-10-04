'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(source);

function setup(fixtures = []) {
  const elements = new Map(), timers = new Map(), intervals = new Map(), requests = [], storage = new Map();
  const bodyChildren = [];
  let nextId = 0, now = 0, copyResult = true;
  class TestDate extends Date { static now() { return now; } }
  function el(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, handlers: {}, attributes: {},
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
        addEventListener(event, fn) { this.handlers[event] = fn; },
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelector() { return null; }, focus() {}, scrollIntoView() {} });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    document: {
      getElementById: el,
      createElement: () => ({ value: '', select() {} }),
      body: { appendChild: node => bodyChildren.push(node), removeChild: node => bodyChildren.splice(bodyChildren.indexOf(node), 1) },
      execCommand: () => copyResult
    }, navigator: {}, Date: TestDate, AbortController,
    localStorage: { getItem: key => storage.get(key) || '', setItem: (key, value) => storage.set(key, value) },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval(fn) { const id = ++nextId; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    async fetch(url, options) {
      requests.push({ url, options });
      assert.ok(fixtures.length, 'Unexpected API request');
      const fixture = fixtures.shift();
      const result = typeof fixture === 'function' ? await fixture(options.signal) : fixture;
      if (result instanceof Error) throw result;
      if (result && result.response) return result.response;
      if (result && result.http) return { ok: false, status: result.http, json: async () => ({ error: { message: 'Test error' } }) };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }) };
    }
  });
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.testApi = { DEMO, callGemini };})();'), context);
  el('apikey').value = 'test-placeholder';
  el('question').value = '改善の手がかりを教えてください。';
  el('reply').value = '必ず成功します。';
  return { el, timers, intervals, requests, storage, bodyChildren, api: context.testApi,
    setCopyResult(value) { copyResult = value; },
    advance(seconds) { now += seconds * 1000; intervals.forEach(fn => fn()); },
    expire() {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 90000);
      assert.ok(entry, 'Missing request timeout');
      timers.delete(entry[0]); entry[1].fn();
    }
  };
}
const segment = (text, flags = []) => ({ text, type: '意見', flags, phrase: '', note: '根拠を確認する。' });
const first = { segments: [segment('必ず成功します。', ['過剰な未来予測'])], summary: '確実性の根拠を見直す。', remeasured: '結果はまだ分かりません。' };
const clean = { segments: [segment(first.remeasured)] };
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const abortError = () => Object.assign(new Error('Test abort'), { name: 'AbortError' });
const hang = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(abortError())));
const hangingBody = signal => ({ response: { ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(abortError()))) } });
function recovered(env) {
  assert.equal(env.el('run').disabled, false);
  assert.equal(env.el('sample').disabled, false);
  assert.equal(env.timers.size, 0, 'Request timer leaked');
  assert.equal(env.intervals.size, 0, 'Elapsed timer leaked');
}

(async () => {
  const checks = [];
  const sample = setup();
  sample.el('apikey').value = '';
  sample.el('sample').handlers.click();
  assert.equal(sample.requests.length, 0);
  assert.equal(sample.el('remeasured').textContent, sample.api.DEMO.result.remeasured);
  assert.equal(sample.api.DEMO.result.segments.map(s => s.text).join(''), sample.api.DEMO.reply);
  assert.equal(sample.api.DEMO.provenance.rawApiResponseAvailable, false);
  assert.equal(sample.api.DEMO.recheck, undefined);
  assert.match(sample.el('recheck').innerHTML, /保存例の二周目/);
  assert.match(sample.el('recheck').innerHTML, /指摘は見つかりません/);
  assert.equal(sample.el('sample-caveat').hidden, false);
  assert.equal(sample.el('result-note').hidden, true);
  checks.push('保存済みのサンプルはキー不要・通信ゼロ');

  sample.el('copy').handlers.click();
  assert.equal(sample.el('copied').textContent, 'コピーしました');
  assert.equal(sample.bodyChildren.length, 0);
  sample.setCopyResult(false);
  sample.el('copy').handlers.click();
  assert.match(sample.el('copied').textContent, /コピーできませんでした/);
  assert.equal(sample.bodyChildren.length, 0);
  checks.push('旧コピー方式の成功と失敗を区別し、一時入力欄を片付ける');

  let resolveFirst, resolveSecond;
  const busy = setup([() => new Promise(resolve => { resolveFirst = resolve; }), () => new Promise(resolve => { resolveSecond = resolve; })]);
  const pending = busy.el('run').handlers.click();
  assert.equal(busy.el('sample').disabled, true);
  busy.el('sample').handlers.click(); busy.el('run').handlers.click();
  assert.equal(busy.requests.length, 1);
  assert.equal(busy.el('reply').value, '必ず成功します。');
  busy.advance(5); assert.match(busy.el('status').textContent, /5秒/);
  resolveFirst(clone(first));
  for (let i = 0; busy.requests.length < 2 && i < 10; i++) await tick();
  assert.equal(busy.requests.length, 2);
  busy.el('sample').handlers.click();
  assert.equal(busy.el('remeasured').textContent, first.remeasured);
  resolveSecond(clone(clean)); await pending; recovered(busy);
  assert.match(busy.el('recheck').innerHTML, /指摘は見つかりません/);
  for (const request of busy.requests) {
    assert.equal(new URL(request.url).origin, 'https://generativelanguage.googleapis.com');
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.options.headers['x-goog-api-key'], 'test-placeholder');
    assert.ok(request.options.signal);
  }
  busy.el('sample').handlers.click(); assert.equal(busy.requests.length, 2);
  checks.push('検品2回、初回・二周目の割り込み防止、完了後の復帰と認証先');

  const unresolved = setup([clone(first), { segments: [segment(first.remeasured, ['根拠なき断定'])] }]);
  await unresolved.el('run').handlers.click(); recovered(unresolved);
  assert.equal(unresolved.requests.length, 2);
  assert.match(unresolved.el('recheck').innerHTML, /まだ線が残って/);
  checks.push('残存指摘は表示して2回で停止');

  for (const fixture of [hang, hangingBody]) {
    for (const second of [false, true]) {
      const env = setup(second ? [clone(first), fixture] : [fixture]);
      const run = env.el('run').handlers.click();
      for (let i = 0; i < 5; i++) await tick();
      assert.equal(env.requests.length, second ? 2 : 1);
      env.expire(); await run; recovered(env);
      assert.match(env.el('status').textContent, /応答が来ませんでした/);
      assert.equal(env.el('status').classList.contains('error'), true);
      if (second) assert.match(env.el('recheck').innerHTML, /二周目の結果は取れませんでした/);
    }
  }
  checks.push('初回・二周目の接続待ちと本文待ち、全4ケースの90秒タイムアウト');

  const invalidBody = { response: { ok: true, json: async () => { throw new SyntaxError('Invalid body'); } } };
  for (const fixture of [new Error('Network failure'), { http: 400 }, { http: 403 }, { http: 429 }, invalidBody, { segments: [] }]) {
    for (const second of [false, true]) {
      const env = setup(second ? [clone(first), fixture] : [fixture]);
      await env.el('run').handlers.click(); recovered(env);
      assert.equal(env.el('status').classList.contains('error'), true);
      if (second) assert.match(env.el('recheck').innerHTML, /二周目の結果は取れませんでした/);
    }
  }
  checks.push('通信・HTTPエラー・JSON不正・本文欠落、初回と二周目の全12ケースで終了処理');

  const hostile = '<img src=x onerror=alert(1)>';
  const escaping = setup([{ segments: [{ text: hostile, type: '意見', flags: ['根拠なき断定'], phrase: hostile, note: hostile }], summary: hostile, remeasured: '確認が必要です。' }, { segments: [segment('確認が必要です。')] }]);
  escaping.el('reply').value = hostile;
  await escaping.el('run').handlers.click(); recovered(escaping);
  assert.doesNotMatch(escaping.el('marked').innerHTML, /<img/);
  assert.doesNotMatch(escaping.el('findings').innerHTML, /<img/);
  assert.match(escaping.el('marked').innerHTML, /&lt;img/);
  assert.equal(escaping.el('summary').textContent, hostile);
  checks.push('入力・API結果のHTMLを表示時にエスケープ');

  const empty = setup(); empty.el('apikey').value = '';
  await empty.el('run').handlers.click(); assert.equal(empty.requests.length, 0); recovered(empty);
  empty.storage.set('yomitoki_key', 'test-placeholder');
  empty.el('apikey').handlers.input.call(empty.el('apikey'));
  assert.equal(empty.storage.get('yomitoki_key'), '');
  checks.push('キー不足では通信しない。キー欄を空にすると保存値を削除');
  console.log(JSON.stringify({ passed: checks.length, checks, limitation: 'Mock API and minimal DOM. No live requests or model-quality evaluation.' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
