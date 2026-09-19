'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const english=fs.existsSync(path.join(root,'yomitoki-en.html'));
const html=fs.readFileSync(path.join(root,english?'yomitoki-en.html':'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const notice=english?'Inspected without context: The original question and conversation were not provided.':'文脈なしでの検品：元の質問や会話は参照していません。';
const input=english?'This is a synthetic reply for testing.':'これは動作確認用の架空の返答です。';
const revision=english?'This is a synthetic revision.':'これは動作確認用の架空の書き換えです。';
const seg=text=>({text,type:'事実',flags:[],primary:'',phrase:'',note:''});
const first=()=>({segments:[seg(input)],summary:'',remeasured:revision});
const second=()=>({segments:[seg(revision)]});
const tick=()=>new Promise(r=>setImmediate(r));
const contextHeading='【元の質問・文脈】\n';
const policy='元の質問・会話が提供されていない場合、その不在だけを理由に「根拠が存在しない」「AIが勝手に付け足した」と確定しない。「提供された情報だけでは根拠を確認できない」と、根拠がないことや虚偽が確認された場合を区別する。文脈なしでも本文から判断できる問題は、既存の基準で検品する。';
function setup(){
 const els=new Map(),requests=[],queue=[],timers=new Map(),intervals=new Map();let id=0;
 function el(name){if(!els.has(name)){const classes=new Set();els.set(name,{value:'',textContent:'',innerHTML:'',hidden:name==='context-note',disabled:false,handlers:{},attributes:{},
  classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},
  addEventListener(k,f){this.handlers[k]=f;},setAttribute(k,v){this.attributes[k]=v;},querySelector(){return null;},focus(){},scrollIntoView(){}});}return els.get(name);}
 const sandbox={document:{getElementById:el},navigator:{},AbortController,Date,
  localStorage:{getItem:()=>'',setItem:()=>{}},
  setTimeout(f,ms){const k=++id;timers.set(k,{f,ms});return k;},clearTimeout:k=>timers.delete(k),
  setInterval(f){const k=++id;intervals.set(k,f);return k;},clearInterval:k=>intervals.delete(k),
  async fetch(url,options){requests.push({url,options});assert.ok(queue.length,'Unexpected request');let data=queue.shift();if(typeof data==='function')data=await data(options.signal);if(data instanceof Error)throw data;
    if(data?.http)return {ok:false,status:data.http,json:async()=>({error:{message:'Synthetic API failure'}})};
    return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(data)}]}}]})};}
 };
 vm.runInNewContext(script,sandbox);el('apikey').value='synthetic-key-not-a-real-credential';el('reply').value=input;
 return {el,queue,requests,run:()=>el('run').handlers.click(),sample:()=>el('sample').handlers.click(),timers,intervals};
}
function checkNote(e,shown){assert.equal(e.el('context-note').hidden,!shown);assert.equal(e.el('context-note').textContent,shown?notice:'');}
function recovered(e){assert.equal(e.el('run').disabled,false);assert.equal(e.el('sample').disabled,false);assert.equal(e.intervals.size,0);assert.equal(e.timers.size,0);}
function prompts(e){return e.requests.map(r=>JSON.parse(r.options.body).contents[0].parts[0].text);}
async function success(e,question){e.el('question').value=question;e.queue.push(first(),second());await e.run();recovered(e);}
(async()=>{
 const checks=[];
 assert.equal((html.match(/id="context-note"/g)||[]).length,1);
 assert.ok(html.indexOf('id="context-note"')<html.indexOf('id="summary"'));
 const help=html.match(/<p class="context-help" id="question-help">([^]*?)<\/p>/);assert.ok(help);
 assert.ok(html.includes('aria-describedby="question-help"'));
 assert.doesNotMatch(html.match(/<textarea id="question"[^>]*>/)[0],/required/);
 assert.ok(html.includes(english?'[Recommended]':'［入力推奨］'));
 checks.push('Recommended label and persistent described help; optional input and one separate result note');

 for(const q of ['Synthetic context provided.','',' \t\r\n ','\u3000\n\t']){
   const e=setup();await success(e,q);checkNote(e,!q.trim());assert.equal(e.requests.length,2);
   for(const p of prompts(e)){assert.equal(p.includes(contextHeading),!!q.trim());if(q.trim())assert.ok(p.includes(contextHeading+q.trim()));assert.equal(p.split(policy).length-1,1);}
   assert.equal(e.el('findings').innerHTML.includes(notice),false);assert.equal(e.el('recheck').innerHTML.includes(notice),false);
 }
 checks.push('Context, empty input, ASCII whitespace and full-width whitespace all run; shared clarification appears once in each prompt');

 for(const q of ['','Original synthetic context']){
   const e=setup();e.el('question').value=q;let done1,done2;
   e.queue.push(()=>new Promise(r=>done1=r),()=>new Promise(r=>done2=r));
   const run=e.run();e.el('question').value=q?'':'Edited while waiting';
   const result=first();result.hasContext=!q;done1(result);
   for(let n=0;n<10&&e.requests.length<2;n++)await tick();
   assert.equal(e.requests.length,2);checkNote(e,!q);
   done2(second());await run;recovered(e);e.el('question').value='Another edit after completion';checkNote(e,!q);
   for(const p of prompts(e))assert.equal(p.includes(contextHeading),!!q);
 }
 checks.push('Result and both request prompts use the submitted snapshot, unaffected by later edits or model-supplied context fields');

 const e=setup();await success(e,'');checkNote(e,true);
 e.el('question').value='Context for the next run';let release;
 e.queue.push(()=>new Promise(r=>release=r),second());const pending=e.run();checkNote(e,false);assert.equal(e.el('result').classList.contains('show'),false);
 release(first());await pending;recovered(e);checkNote(e,false);
 await success(e,' \n ');checkNote(e,true);
 e.sample();checkNote(e,false);assert.equal(e.el('result').classList.contains('show'),true);
 e.sample();checkNote(e,false);assert.equal(e.el('result').classList.contains('show'),false);assert.equal(e.el('question').value,' \n ');assert.equal(e.el('reply').value,input);
 await success(e,'');checkNote(e,true);e.sample();checkNote(e,false);e.sample();checkNote(e,false);
 checks.push('Repeated runs and sample/back transitions clear obsolete notes, restore both fields, and do not duplicate the note');

 for(const q of ['Synthetic context','',' \n ']){
   const x=setup();x.el('question').value=q;x.queue.push(first(),{http:429});await x.run();recovered(x);checkNote(x,!q.trim());
   assert.equal(x.el('result').classList.contains('show'),true);assert.equal(x.el('remeasured').textContent,revision);
   assert.match(x.el('recheck').innerHTML,english?/Second inspection incomplete/:/二周目の結果は取れませんでした/);
   assert.doesNotMatch(x.el('recheck').innerHTML,english?/No issues were found/:/指摘は見つかりません/);
 }
 const failed=setup();await success(failed,'');failed.queue.push(new Error('Synthetic connection failure'));await failed.run();recovered(failed);checkNote(failed,false);assert.equal(failed.el('result').classList.contains('show'),false);
 checks.push('Second-pass failure preserves the first result and its context note; first-pass failure does not expose a stale result');
 console.log(JSON.stringify({language:english?'en':'ja',passed:checks.length,checks,liveApiCalled:false,limitation:'Synthetic responses only; no verification of model judgment quality.'},null,2));
})().catch(err=>{console.error(err);process.exitCode=1;});
