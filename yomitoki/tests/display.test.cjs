'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const demo = fs.readFileSync(path.join(root, 'demo/index.html'), 'utf8');
const snap = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/photo-screen-snapshot.json'), 'utf8'));
const script = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
const defs = html => script(html).slice(script(html).indexOf('  var GENERAL_FLAG'), script(html).indexOf('  var TYPE_BADGE'));
const flagFunctions = html => script(html).slice(script(html).indexOf('  function cleanFlags'), script(html).indexOf('  function quoteHtml'));
const get = html => vm.runInNewContext(defs(html) + '\n' + flagFunctions(html) + '\n({cleanFlags,displayFlag})');
const api = get(main);
const clone = x => JSON.parse(JSON.stringify(x));
const A = '根拠なき断定', G = '過剰肯定', B = '出どころなき引用', O = '過剰な未来予測';
const checks = [];
const pass = (name, fn) => { fn(); checks.push(name); };

pass('本体と独立デモの表示ロジックは同一', () => {
  assert.equal(defs(main), defs(demo));
  assert.equal(flagFunctions(main), flagFunctions(demo));
});
pass('赤単独は赤、具体区分単独はその色、空なら線なし', () => {
  for(const flag of [A,G,B,O]) assert.equal(api.displayFlag({flags:[flag]}), flag);
  assert.equal(api.displayFlag({flags:[]}), '');
  assert.equal(api.displayFlag({}), '');
});
pass('赤と具体区分一つが重なる場合、primaryが赤・欠落・無効でも具体区分を表示', () => {
  for(const flag of [G,B,O]) {
    for(const primary of [undefined, '', A, flag, 'unknown', 42, {other:true}]) {
      for(const flags of [[A,flag],[flag,A]]) assert.equal(api.displayFlag({flags,primary}), flag);
    }
  }
});
pass('具体区分が複数なら有効なprimaryを尊重し、なければ返却順', () => {
  assert.equal(api.displayFlag({flags:[A,G,B,O],primary:B}), B);
  assert.equal(api.displayFlag({flags:[A,G,B,O],primary:' '+O+' '}), O);
  assert.equal(api.displayFlag({flags:[A,G,B,O],primary:A}), G);
  assert.equal(api.displayFlag({flags:[A,B,G,O]}), B);
  assert.equal(api.displayFlag({flags:[A,G,B,O],primaryFlag:O}), O);
});
pass('本文色の変更でもflags・note・phrase・type・本文を改変しない', () => {
  const input = clone(snap.result.segments);
  const before = JSON.stringify(input);
  for(const seg of input) { api.cleanFlags(seg); api.displayFlag(seg); }
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(input.map(s => api.displayFlag(s)), ['',G,B,O,'']);
  assert.equal(input.reduce((n,s) => n+s.flags.length,0),6);
  assert.equal(input.filter(s => s.flags.includes(A)).length,3);
});
pass('画面のAPI生primaryは不明なので、保存例には作り足さない', () => {
  assert.equal(snap.provenance.rawApiResponseAvailable,false);
  for(const seg of snap.result.segments) assert.equal(Object.hasOwn(seg,'primary'),false);
  assert.equal(snap.recheck,undefined);
  assert.ok(snap.recheckDisplay.message);
  assert.equal(snap.result.summary,'');
  assert.equal(snap.reply,snap.result.segments.map(s => s.text).join(''));
});
pass('未知値・重複を安全に除去し、存在しない色を新設しない', () => {
  const seg = {flags:[A,A,'toString','__proto__',null,G,G], primary:B};
  assert.deepEqual(Array.from(api.cleanFlags(seg)),[A,G]);
  assert.equal(api.displayFlag(seg),G);
  assert.equal(api.displayFlag({flags:[A],primary:B}),A);
  assert.equal(api.displayFlag({flags:['unknown'],primary:B}),'');
});
let combinations = 0;
pass('全ての指摘集合・返却順・primary候補で代表色は検出済みの指摘のみから選ぶ', () => {
  function perms(arr) { if(arr.length<2) return [arr]; return arr.flatMap((x,i)=>perms(arr.filter((_,j)=>j!==i)).map(xs=>[x,...xs])); }
  for(let mask=1;mask<16;mask++) {
    const subset=[A,G,B,O].filter((_,i)=>mask&(1<<i));
    for(const flags of perms(subset)) for(const primary of [undefined,'',A,G,B,O,'unknown']) {
      const seg = {flags,primary};
      const before = JSON.stringify(seg);
      const chosen=api.displayFlag(seg);
      assert.ok(flags.includes(chosen));
      if(flags.some(x=>x!==A)) assert.notEqual(chosen,A);
      assert.equal(JSON.stringify(seg),before);
      combinations++;
    }
  }
});
pass('独立デモにAPI呼び出し・APIキー入力・キー保存処理を含めない', () => {
  assert.doesNotMatch(script(demo), /\bfetch\s*\(|localStorage|callGemini/);
  assert.doesNotMatch(demo, /id="apikey"|id="model"/);
  assert.match(demo, /実行結果の画面から再構成/);
});
pass('本体のモデル入力は非表示ではなく不在、線の太さと四色を維持', () => {
  assert.doesNotMatch(main, /id="model"/);
  for(const css of ['--shu:#C2452F','--midori:#2F7A4F','--kohaku:#9C6412','--ai:#2E4E9A','text-decoration-thickness:2px']) assert.ok(main.includes(css));
  assert.ok(main.includes('text-decoration:line-through'));
  assert.match(main, /色は重大さの順位ではありません/);
  assert.doesNotMatch(main, /先にあるほど重い|FLAG_ORDER/);
});
console.log(JSON.stringify({passed:checks.length, propertyCombinations:combinations,checks, limitation:'Pure display tests. No live API or classifier-quality validation.'},null,2));
