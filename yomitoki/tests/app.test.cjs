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
  let nextId = 0, now = 0;
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
    document: { getElementById: el }, navigator: {}, Date: TestDate, AbortController,
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
  return { el, timers, intervals, requests, storage, api: context.testApi,
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
  assert.equal(sample.el('result-mode-title').textContent, '今回の検品：AIの返答');
  assert.match(sample.el('result-mode-description').textContent, /AIが書いた文章として検品しました/);
  checks.push('保存済みのサンプルはキー不要・通信ゼロ、AIの物差しとして表示');

  const promptOf = request => JSON.parse(request.options.body).contents[0].parts[0].text;
  const general = setup([clone(first), clone(clean)]);
  assert.equal(general.el('mode-check-name').textContent, 'AIの返答');
  general.el('mode-general').checked = true;
  general.el('mode-general').handlers.change();
  assert.equal(general.el('mode-check-name').textContent, '文章全般');
  await general.el('run').handlers.click(); recovered(general);
  assert.equal(general.el('result-mode-title').textContent, '今回の検品：文章全般');
  assert.match(general.el('result-mode-description').textContent, /書き手が人かAIかを決めつけずに検品しました/);
  assert.match(general.el('result-mode-description').textContent, /「AIの返答」で測り直してください/);
  for (const request of general.requests) {
    assert.match(promptOf(request), /物差し：汎用/);
    assert.doesNotMatch(promptOf(request), /\|体験\|/);
    assert.match(promptOf(request), /区分は事実とする/);
    assert.doesNotMatch(promptOf(request), /物差し：AI用/);
  }
  assert.match(promptOf(general.requests[0]), /【文章】/);
  assert.match(promptOf(general.requests[0]), /書き手の意見・主張を質問へ置き換えない/);
  assert.match(promptOf(general.requests[0]), /原文より長くなってよい/);
  assert.match(promptOf(general.requests[1]), /原文の意図の保持/);
  assert.match(promptOf(general.requests[0]), /限界は必ず一文で書き添える/);
  assert.match(promptOf(general.requests[0]), /検出フラグを付けなかったセグメントは一字も変えない/);
  assert.match(promptOf(general.requests[0]), /聞いた話だろうと補って体験に含めない/);
  assert.match(promptOf(general.requests[0]), /本人が聞いたことにする書き方をしない/);
  assert.match(promptOf(general.requests[0]), /理由をはっきり聞いたわけではありませんが/);
  assert.match(promptOf(general.requests[0]), /「不確実性を含んだ推測だから問題なし」として通さない/);
  assert.doesNotMatch(promptOf(general.requests[0]), /転職に苦労している友人が何人も/);
  assert.doesNotMatch(promptOf(general.requests[0]), /「〜が理由だと考えています」のように/);
  assert.match(promptOf(general.requests[0]), /世の中の傾向を否定も肯定もしない/);
  assert.doesNotMatch(promptOf(general.requests[0]), /身近な例からの推測であり、一般的な傾向だとまでは言えません』/);
  assert.match(promptOf(general.requests[0]), /書き手自身の気持ち・感情・不安・願望は体験に含めず意見とする/);
  assert.match(promptOf(general.requests[0]), /それだけで検出フラグを付けない/);
  assert.match(promptOf(general.requests[0]), /根拠と範囲が示されているかで説明する/);
  assert.match(promptOf(general.requests[1]), /根拠の十分さや範囲の限定には触れない/);
  assert.match(promptOf(general.requests[1]), /"intentCheck"/);
  assert.match(general.el('recheck').innerHTML, /原文の意図が保たれたか確認できませんでした/);
  assert.equal(general.el('remeasured-title').textContent, '測り直した文章');
  const aiMode = setup([clone(first), clone(clean)]);
  assert.equal(aiMode.el('mode-check-name').textContent, 'AIの返答');
  await aiMode.el('run').handlers.click(); recovered(aiMode);
  assert.equal(aiMode.el('result-mode-title').textContent, '今回の検品：AIの返答');
  assert.match(aiMode.el('result-mode-description').textContent, /人が書いた文章や、書き手が分からない文章なら/);
  for (const request of aiMode.requests) {
    assert.match(promptOf(request), /物差し：AI用/);
    assert.doesNotMatch(promptOf(request), /\|体験\|/);
    assert.doesNotMatch(promptOf(request), /物差し：汎用/);
  }
  assert.match(promptOf(aiMode.requests[0]), /【AIの返答】/);
  assert.match(promptOf(aiMode.requests[0]), /確認する質問に置き換える/);
  assert.doesNotMatch(promptOf(aiMode.requests[1]), /"intentCheck"/);
  assert.doesNotMatch(aiMode.el('recheck').innerHTML, /原文の意図/);
  assert.doesNotMatch(promptOf(aiMode.requests[0]), /根拠と範囲が示されているかで説明する/);
  assert.match(promptOf(aiMode.requests[0]), /書き手自身の気持ち・感情・不安・願望の表明/);
  assert.doesNotMatch(promptOf(aiMode.requests[0]), /それだけで検出フラグを付けない/);
  assert.equal(aiMode.el('remeasured-title').textContent, '測り直した返答');
  const keep = setup([clone(first), clone(clean)]);
  await keep.el('run').handlers.click(); recovered(keep);
  assert.equal(keep.el('result').classList.contains('show'), true);
  keep.el('mode-general').checked = true; keep.el('mode-general').handlers.change();
  assert.equal(keep.el('reply').value, '必ず成功します。');
  assert.equal(keep.el('question').value, '改善の手がかりを教えてください。');
  assert.equal(keep.el('result').classList.contains('show'), false);
  assert.equal(keep.el('reply-label').textContent, '測る文章');
  assert.equal(keep.el('mode-check-name').textContent, '文章全般');
  assert.equal(keep.el('result-mode-title').textContent, '今回の検品：AIの返答');
  checks.push('実行直後の結果は当時の物差しを保持し、切り替えると古い結果だけ隠す');
  const tempOf = request => JSON.parse(request.options.body).generationConfig.temperature;
  assert.equal(tempOf(keep.requests[0]), 0.2);
  assert.equal(tempOf(keep.requests[1]), 0.2);
  checks.push('temperatureは0.2で固定し、初回・二周目とも0.2で送る');
  checks.push('最初はAIの返答。物差しを切り替えても入力は残し、前の結果だけ消す');
  checks.push('物差しの切り替え：汎用は体験を事実として咎めず、AI用は体験を作り話として扱う指示を、初回・二周目とも送る');
  checks.push('実行前と結果表示の双方で、AIの返答／文章全般の各物差しを明示する');
  checks.push('汎用では主張を質問化しない指示を渡し、二周目に意図保持の追加報告を要求。AI用の指示は維持');

  const checked = setup([clone(first), { ...clone(clean), intentCheck: { status:'保持', note:'書き手の主張が残っている。' } }]);
  checked.el('mode-general').checked = true;
  await checked.el('run').handlers.click(); recovered(checked);
  assert.match(checked.el('recheck').innerHTML, /書き手の言いたいことは残っています（根拠の検品とは別の確認です）/);

  const altered = setup([clone(first), { ...clone(clean), intentCheck: { status:'変更の疑い', note:'意見が質問に変わった。' } }]);
  altered.el('mode-general').checked = true;
  await altered.el('run').handlers.click(); recovered(altered);
  assert.match(altered.el('recheck').innerHTML, /指摘は見つかりませんでした/);
  assert.match(altered.el('recheck').innerHTML, /原文の意図が変わった可能性/);
  assert.match(altered.el('recheck').innerHTML, /意見が質問に変わった/);

  const unconfirmed = setup([clone(first), { ...clone(clean), intentCheck: { status:'判断できない', note:'検証材料が不足' } }]);
  unconfirmed.el('mode-general').checked = true;
  await unconfirmed.el('run').handlers.click(); recovered(unconfirmed);
  assert.match(unconfirmed.el('recheck').innerHTML, /確認できませんでした/);
  checks.push('二周目で意図保持・変更の疑い・未報告・判断不能を検出フラグとは独立して表示');

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

  const legacy = setup([{ segments: [{ text: '必ず成功します。', type: '体験', flags: [], phrase: '', note: '' }], summary: '', remeasured: '必ず成功します。' }, { segments: [segment('必ず成功します。')] }]);
  legacy.el('mode-general').checked = true;
  await legacy.el('run').handlers.click(); recovered(legacy);
  assert.equal(legacy.el('status').classList.contains('error'), false);
  assert.match(legacy.el('marked').innerHTML, /data-type="事実"/);
  assert.doesNotMatch(legacy.el('marked').innerHTML, />体</);
  checks.push('以前の区分「体験」が返っても事実として表示する');

  const emojiReply = '🇺🇸の友達が２人います。';
  const emoji = setup([{ segments: [{ text: 'の友達が2人います。', type: '事実', flags: [], phrase: '', note: '' }], summary: '', remeasured: 'の友達が2人います。' }, { segments: [segment('の友達が2人います。')] }]);
  emoji.el('reply').value = emojiReply;
  await emoji.el('run').handlers.click(); recovered(emoji);
  assert.equal(emoji.el('status').classList.contains('error'), false);
  assert.equal(emoji.el('result').classList.contains('show'), true);
  const missing = setup([{ segments: [{ text: 'の友達がいます。', type: '事実', flags: [], phrase: '', note: '' }], summary: '', remeasured: 'x' }]);
  missing.el('reply').value = emojiReply;
  await missing.el('run').handlers.click(); recovered(missing);
  assert.match(missing.el('status').textContent, /文字の欠落/);
  checks.push('絵文字や全角数字の書き換えだけでは欠落扱いしない。文字そのものの欠落は検出する');

  const hostile = '<img src=x onerror=alert(1)>';
  const escaping = setup([{ segments: [{ text: hostile, type: '意見', flags: ['根拠なき断定'], phrase: hostile, note: hostile }], summary: hostile, remeasured: '確認が必要です。' }, { segments: [segment('確認が必要です。')] }]);
  escaping.el('reply').value = hostile;
  await escaping.el('run').handlers.click(); recovered(escaping);
  assert.doesNotMatch(escaping.el('marked').innerHTML, /<img/);
  assert.doesNotMatch(escaping.el('findings').innerHTML, /<img/);
  assert.match(escaping.el('marked').innerHTML, /&lt;img/);
  assert.equal(escaping.el('summary').textContent, hostile);
  const intentEscaping = setup([clone(first), { ...clone(clean), intentCheck: { status:'変更の疑い', note:hostile } }]);
  intentEscaping.el('mode-general').checked = true;
  await intentEscaping.el('run').handlers.click(); recovered(intentEscaping);
  assert.doesNotMatch(intentEscaping.el('recheck').innerHTML, /<img/);
  assert.match(intentEscaping.el('recheck').innerHTML, /&lt;img/);
  checks.push('入力・API結果と原文意図の報告をHTMLエスケープ');

  const raw = (text, finishReason = 'STOP') => ({ response: { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] }) } });

  const symReply = '「1年後」には…必ず成功します！①まず〜続けること。ｶﾞｲﾄﾞは10％です。';
  const sym = setup([
    { segments: [
      { text: '"1年後"には...必ず成功します!', type: '意見', flags: ['過剰な未来予測'], phrase: '必ず成功します', note: '確実性の根拠がない。' },
      { text: '1まず~続けること。', type: '意見', flags: [], phrase: '', note: '' },
      { text: 'ガイドは10%です。', type: '事実', flags: [], phrase: '', note: '' }
    ], summary: '', remeasured: '結果はまだ分かりません。' }, clone(clean)]);
  sym.el('reply').value = symReply;
  await sym.el('run').handlers.click(); recovered(sym);
  assert.equal(sym.el('status').classList.contains('error'), false, sym.el('status').textContent);
  assert.match(sym.el('marked').innerHTML, /「1年後」には…必ず成功します！/);
  assert.match(sym.el('marked').innerHTML, /①まず〜続けること。/);
  assert.match(sym.el('marked').innerHTML, /ｶﾞｲﾄﾞは10％です。/);
  checks.push('記号・数字・半角カナの形の違いでは止めず、画面には元の文字をそのまま出す');

  const letterSwap = setup([{ segments: [{ text: '必ず失敗します。', type: '意見', flags: [], phrase: '', note: '' }], summary: '', remeasured: 'x' }]);
  await letterSwap.el('run').handlers.click(); recovered(letterSwap);
  assert.match(letterSwap.el('status').textContent, /文字の欠落/);
  checks.push('文字が入れ替わった場合は、これまで通り欠落として止める');

  const messy = setup([raw('はい、結果です。\n```json\n{"segments":[{"text":"必ず成功します。","type":"意見","flags":["過剰な未来予測"],"phrase":"","note":"一行目\n二行目 \\\'引用\\\'",}],"summary":"x","remeasured":"結果はまだ分かりません。",}\n```\n以上です。'), clone(clean)]);
  await messy.el('run').handlers.click(); recovered(messy);
  assert.equal(messy.el('status').classList.contains('error'), false, messy.el('status').textContent);
  assert.match(messy.el('findings').innerHTML, /一行目/);
  checks.push('前後の説明文・コードフェンス・文字列中の生の改行・不正なエスケープ・末尾のカンマがあっても読む');

  const cut = setup([raw('{"segments":[{"text":"必ず', 'MAX_TOKENS')]);
  await cut.el('run').handlers.click(); recovered(cut);
  assert.match(cut.el('status').textContent, /途中で切れました/);
  const blocked = setup([raw('', 'SAFETY')]);
  await blocked.el('run').handlers.click(); recovered(blocked);
  assert.match(blocked.el('status').textContent, /安全上の理由/);
  checks.push('結果が長さの上限で切れた場合と、安全上の理由で止まった場合は、その理由を出す');

  const labels = setup([{ segments: [
    { text: '必ず成功します。', type: '推測', flags: '根拠のない断定、過剰な予測', primary: '「根拠のない断定」', phrase: '', note: '根拠がない。' },
    { text: 'がんばって。', type: 'その他', flags: null, phrase: '', note: '' }
  ], summary: '', remeasured: '結果はまだ分かりません。' }, clone(clean)]);
  labels.el('reply').value = '必ず成功します。がんばって。';
  await labels.el('run').handlers.click(); recovered(labels);
  assert.equal(labels.el('status').classList.contains('error'), false, labels.el('status').textContent);
  assert.match(labels.el('findings').innerHTML, /根拠なき断定/);
  assert.match(labels.el('findings').innerHTML, /過剰な未来予測/);
  assert.match(labels.el('marked').innerHTML, /data-type="推論"/);
  checks.push('区分・指摘の名前のゆれ（推測、根拠のない断定、文字列のフラグなど）を正しい名前に直し、知らない区分では止めない');

  const target = setup([clone(first), clone(clean)]);
  assert.equal(target.el('mode-check-name').textContent, 'AIの返答');
  target.el('mode-general').checked = true; target.el('mode-general').handlers.change();
  assert.equal(target.el('mode-check-name').textContent, '文章全般');
  let focused = false, scrolled = false;
  target.el('mode-general').focus = () => { focused = true; };
  target.el('mode-selector').scrollIntoView = () => { scrolled = true; };
  target.el('mode-change').handlers.click();
  assert.ok(focused && scrolled);
  const targetRun = target.el('run').handlers.click();
  assert.equal(target.el('mode-change').disabled, true);
  await targetRun; recovered(target);
  assert.equal(target.el('mode-change').disabled, false);
  target.el('mode-ai').checked = true; target.el('mode-general').checked = false; target.el('mode-ai').handlers.change();
  assert.equal(target.el('mode-check-name').textContent, 'AIの返答');
  checks.push('押す直前に「測定対象」を表示し、物差しの切り替えに合わせて変える。「変更する」で切り替えへ戻り、測っている間は押せない');

  const empty = setup(); empty.el('apikey').value = '';
  await empty.el('run').handlers.click(); assert.equal(empty.requests.length, 0); recovered(empty);
  empty.storage.set('yomitoki_key', 'test-placeholder');
  empty.el('apikey').handlers.input.call(empty.el('apikey'));
  assert.equal(empty.storage.get('yomitoki_key'), '');
  checks.push('キー不足では通信しない。キー欄を空にすると保存値を削除');
  console.log(JSON.stringify({ passed: checks.length, checks, limitation: 'Mock API and minimal DOM. No live requests or model-quality evaluation.' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
