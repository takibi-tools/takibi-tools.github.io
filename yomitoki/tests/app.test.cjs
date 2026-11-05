'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(source);
assert.doesNotMatch(html, /id="deepCheck"|精度を上げる|二周目の検品は行っていません/);
assert.match(html, /id="recheck-help"/);

const clone = data => JSON.parse(JSON.stringify(data));
const label = (i, flags = [], phrase = '') =>
  ({i, type:'意見', flags, primary:flags[0] || '', phrase, note:flags.length ? '根拠を確認する。' : ''});
const original = '必ず成功します。';
const revised = '結果はまだ分かりません。';
const finalText = '今ある情報だけでは、成功を保証できません。';
const first = { labels:[label(1, ['過剰な未来予測'], '必ず成功します')], summary:'確実性の根拠を見直す。', remeasured:revised };
const clean = {labels:[label(1)]};
const flaggedRecheck = { labels:[label(1, ['根拠なき断定'], 'まだ分かりません')] };
const repaired = {remeasured:finalText};
const makeFixtures = (...items) => items.map(clone);
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(fixtures = []) {
  const elements = new Map();
  const historyVersions = [];
  const timers = new Map();
  const intervals = new Map();
  const requests = [];
  const storage = new Map();
  let nextId = 0, now = 0;
  class TestDate extends Date { static now() { return now; } }

  function el(id) {
    if(!elements.has(id)) {
      const classes = new Set();
      const value = {
        value:'', checked:false, textContent:'', innerHTML:'', disabled:false, hidden:false,
        selectedIndex:0, handlers:{}, attributes:{}, lastElementChild:null,
        classList:{
          add:name => classes.add(name),
          remove:name => classes.delete(name),
          contains:name => classes.has(name),
          toggle:(name,on) => on ? classes.add(name) : classes.delete(name)
        },
        addEventListener(name, fn){ this.handlers[name] = fn; },
        setAttribute(name, val){ this.attributes[name] = val; },
        getAttribute(name){ return this.attributes[name] ?? null; },
        querySelector(){ return null; },
        querySelectorAll(){ return []; },
        insertAdjacentHTML(where, markup){ this.innerHTML += markup; },
        focus(){}, scrollIntoView(){}, contains(){ return true; }
      };
      if(id === 'mode-ai') value.checked = true;
      if(id === 'modelsel') value.value = 'auto';
      if(id === 'trial-method') value.value = 'gemini';
      if(id === 'history') {
        value.querySelectorAll = selector => selector === '.ver' ? historyVersions : [];
        value.insertAdjacentHTML = (where, markup) => {
          value.innerHTML += markup;
          if(markup.includes('class="remeasured-final ver"')){
            const title = {textContent:''};
            const node = {
              innerHTML:markup,
              querySelector:selector => selector === '.final-title' ? title : null,
              insertAdjacentHTML(placement, addition){ this.innerHTML += addition; }
            };
            historyVersions.push(node);
            value.lastElementChild = node;
          }
        };
      }
      elements.set(id, value);
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    window:{}, document:{getElementById:el}, navigator:{}, Date:TestDate, AbortController,
    localStorage:{getItem:key => storage.get(key) || '', setItem:(key, val) => storage.set(key,val)},
    setTimeout(fn, ms){ const id = ++nextId; timers.set(id, {fn, ms}); return id; },
    clearTimeout:id => timers.delete(id),
    setInterval(fn){ const id = ++nextId; intervals.set(id,fn); return id; },
    clearInterval:id => intervals.delete(id),
    async fetch(url, options){
      requests.push({url, options});
      assert.ok(fixtures.length, 'Unexpected Gemini API request');
      const fixture = fixtures.shift();
      const obj = typeof fixture === 'function' ? await fixture(options.signal) : fixture;
      if(obj instanceof Error) throw obj;
      if(obj && obj.http) return {ok:false, status:obj.http, json:async()=>({error:{message:'Test HTTP error'}})};
      if(obj && obj.response) return obj.response;
      return {ok:true, json:async()=>({
        candidates:[{content:{parts:[{text:JSON.stringify(obj)}]},finishReason:'STOP'}]
      })};
    }
  });
  vm.runInContext(source, context);
  el('apikey').value = 'test-key';
  el('question').value = '成功すると思いますか？';
  el('reply').value = original;

  return {el, requests, timers, intervals, historyVersions, storage,
    advance(seconds){ now += seconds * 1000; intervals.forEach(fn=>fn()); }
  };
}
function recovered(env){
  assert.equal(env.el('run').disabled, false, 'run button restored');
  assert.equal(env.el('sample').disabled, false, 'sample button restored');
  assert.equal(env.timers.size, 0, 'request timer leaked');
  assert.equal(env.intervals.size, 0, 'progress interval leaked');
}
function responsePayload(request){
  return JSON.parse(request.options.body);
}
const checks = [];
function checked(name){ checks.push(name); }

(async function(){
  // 保存例は通信しない。検品モードもAI用として表示される。
  const demo = setup();
  demo.el('apikey').value = '';
  demo.el('sample').handlers.click();
  assert.equal(demo.requests.length, 0);
  assert.match(demo.el('result-mode-title').textContent, /AIの返答/);
  assert.match(demo.el('recheck').innerHTML, /保存例の二周目/);
  checked('保存サンプルは通信ゼロ');

  // AIモード：任意設定なしで初回＋二周目を必ず呼び、0/topK1/seed固定を渡す。
  const ai = setup(makeFixtures(first, clean));
  assert.equal(ai.el('mode-check-name').textContent, 'AIの返答');
  await ai.el('run').handlers.click();
  recovered(ai);
  assert.equal(ai.requests.length, 2, 'second inspection is required');
  for(const req of ai.requests){
    const payload = responsePayload(req);
    assert.equal(payload.generationConfig.temperature, 0);
    assert.equal(payload.generationConfig.topK, 1);
    assert.equal(payload.generationConfig.seed, 20261102);
    assert.equal(payload.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.equal(new URL(req.url).origin, 'https://generativelanguage.googleapis.com');
    assert.equal(req.options.headers['x-goog-api-key'], 'test-key');
  }
  assert.match(responsePayload(ai.requests[0]).contents[0].parts[0].text, /物差し：AI用/);
  assert.match(ai.el('chk-1').innerHTML, /指摘は見つかりませんでした/);
  assert.equal(ai.historyVersions.length, 0, 'no revision if second pass clean');
  checked('AIモード：必ず二周目・設定0・問題なしなら修正なし');

  // 文章全般も二周目を行い、意図保持を別扱いする。
  const general = setup(makeFixtures(first, {...clean, intentCheck:{status:'保持',note:'意図は残っています。'}}));
  general.el('mode-general').checked = true;
  general.el('mode-general').handlers.change();
  assert.equal(general.el('mode-check-name').textContent, '文章全般');
  await general.el('run').handlers.click(); recovered(general);
  assert.equal(general.requests.length, 2);
  assert.match(responsePayload(general.requests[0]).contents[0].parts[0].text, /物差し：汎用/);
  assert.match(general.el('chk-1').innerHTML, /書き手の言いたいことは残っています/);
  checked('文章全般：必ず二周目・意図保持を独立報告');

  // 二周目で残存指摘→直し直し→最終版検品。元文を上書きしない。
  const repair = setup(makeFixtures(first, flaggedRecheck, repaired, clean));
  await repair.el('run').handlers.click(); recovered(repair);
  assert.equal(repair.requests.length, 4);
  assert.equal(repair.el('remeasured').textContent, revised, 'first rewrite remains visible');
  assert.equal(repair.historyVersions.length, 1, 'only repaired version added');
  assert.match(repair.historyVersions[0].innerHTML, /最終版の確認/);
  assert.match(repair.el('chk-1').innerHTML, /まだ線が残っていました/);
  assert.match(repair.el('chk-2').innerHTML, /最終版をもう一度検品しました/);
  checked('残存指摘→再修正→最終版確認：履歴の上書きなし');

  // モデルが同じ書き直しを返すときだけ、最大一回再依頼する。
  const retry = setup(makeFixtures(first, flaggedRecheck, {remeasured:revised}, repaired, clean));
  await retry.el('run').handlers.click(); recovered(retry);
  assert.equal(retry.requests.length, 5);
  assert.equal(retry.historyVersions.length, 1);
  checked('無変更の修正文は一度だけ再依頼、最大5 API呼び出し');

  // 二周目のAPIエラー：一周目は残し、失敗を隠さない。
  const failedSecond = setup(makeFixtures(first, {http:400}));
  await failedSecond.el('run').handlers.click(); recovered(failedSecond);
  assert.equal(failedSecond.requests.length, 2);
  assert.equal(failedSecond.el('remeasured').textContent, revised);
  assert.match(failedSecond.el('chk-1').innerHTML, /二周目の結果は取れませんでした/);
  assert.match(failedSecond.el('status').textContent, /二周目は取れませんでした/);
  checked('二周目失敗でも一周目を残し失敗を表示');

  // 実行中の操作制限・終了時の復帰。
  let resolveFirst, resolveSecond;
  const pending = setup([
    () => new Promise(resolve => {resolveFirst=resolve;}),
    () => new Promise(resolve => {resolveSecond=resolve;})
  ]);
  const running = pending.el('run').handlers.click();
  for(let i=0;i<20 && typeof resolveFirst !== 'function';i++) await tick();
  assert.equal(typeof resolveFirst, 'function', 'first mock request started');
  assert.equal(pending.el('run').disabled, true);
  assert.equal(pending.el('sample').disabled, true);
  assert.equal(pending.el('mode-change').disabled, true);
  pending.advance(5);
  assert.match(pending.el('status').textContent, /5秒/);
  resolveFirst(clone(first));
  for(let i=0;i<20&&pending.requests.length<2;i++) await tick();
  assert.equal(pending.requests.length, 2);
  resolveSecond(clone(clean));
  await running; recovered(pending);
  assert.equal(pending.el('mode-change').disabled, false);
  checked('検品中の操作防止と終了時の状態復帰');

  // キーなしでは送信しない。モード切替も結果を誤表示させない。
  const empty = setup();
  empty.el('apikey').value = '';
  await empty.el('run').handlers.click(); recovered(empty);
  assert.equal(empty.requests.length, 0);
  const mode = setup(makeFixtures(first, clean));
  await mode.el('run').handlers.click(); recovered(mode);
  mode.el('mode-general').checked = true; mode.el('mode-general').handlers.change();
  assert.equal(mode.el('result').classList.contains('show'), false);
  assert.equal(mode.el('reply').value, original);
  checked('キー不足では送信しない・モード切替で旧結果を隠す');

  console.log(JSON.stringify({
    passed:checks.length, checks,
    limitation:'Mock Gemini API/minimal DOM; no live Gemini or browser layout validation.'
  },null,2));
})().catch(err=>{console.error(err);process.exitCode=1;});
