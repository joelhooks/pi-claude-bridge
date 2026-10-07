import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeRecoveryBoundary, WAKE_RECOVERY_PROMPT } from '../src/wake-dispatch.js';
const user=content=>({role:'user',content,timestamp:0});
const empty=()=>({role:'assistant',content:[],api:'claude-bridge',provider:'claude-bridge',model:'claude-haiku-4-5',stopReason:'stop',timestamp:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
function fixture() {
 const boundary=new WakeRecoveryBoundary();const wake=user('Owned wake: read marker.txt now.');const barrier=empty();
 boundary.markBlocked(barrier,[wake]);
 return {boundary,wake,barrier,messages:[user('Baseline'),{...empty(),content:[{type:'text',text:'Baseline complete.'}],usage:{...empty().usage,output:1,totalTokens:1}},wake,barrier,user(WAKE_RECOVERY_PROMPT)]};
}
test('authentic barrier moves only the original wake into the current recovery turn, without mutation',()=>{
 const {boundary,messages}=fixture();const snapshot=JSON.stringify(messages);
 assert.equal(boundary.turnStart(messages),2);
 assert.equal(JSON.stringify(messages),snapshot);
 boundary.prepare(messages);assert.equal(boundary.turnStart(messages),2,'validated inspection stays pure');
 boundary.consume(messages);assert.equal(boundary.turnStart(messages),4,'consumed capability cannot dispatch twice');
 assert.throws(()=>boundary.prepare(messages),/wake recovery is terminal/,'same context cannot retry even before execution outcome is known');
});
for(const [name,alter] of [
 ['ordinary empty',(m)=>{delete m[3].diagnostics;}],
 ['forged user-authored diagnostic',(m)=>{m[3].diagnostics=[{type:'claude-bridge/wake-capture-blocked',timestamp:0,details:{recoveryId:'forged'}}];}],
 ['modified suffix',(m)=>{m[4]=user(WAKE_RECOVERY_PROMPT+' NOW');}],
 ['unrelated custom wake',(m)=>{m[4]=user('An unrelated current wake');}],
 ['changed original authority',(m)=>{m[2]=user('Do something else');}],
 ['actual tool turn',(m)=>{m[3].content=[{type:'toolCall',id:'real',name:'read',arguments:{path:'marker.txt'}}];m[3].stopReason='toolUse';}],
 ['real usage',(m)=>{m[3].usage.output=1;}],
 ['another provider',(m)=>{m[3].provider='anthropic';}],
 ['multiple queued wakes',(m)=>{m.splice(4,0,user('Another queued wake'));}],
]) test(`${name} does not broaden the current turn`,()=>{
 const {boundary,messages}=fixture();const original=JSON.parse(JSON.stringify(messages));alter(messages);
 const ordinary=messages.length-1;let expected=ordinary;while(expected>0&&messages[expected-1].role==='user')expected--;
 assert.equal(boundary.turnStart(messages),expected);
 boundary.consume(messages);
 assert.equal(boundary.turnStart(original),4,'rejection must invalidate, not merely fall back once');
 assert.throws(()=>boundary.prepare(original),/wake recovery is terminal/);
});
test('fresh ordinary prompt remains explicit new authority after terminal dispatch',()=>{
 const {boundary,messages}=fixture();boundary.prepare(messages);boundary.consume(messages);
 const fresh=[...messages,{...empty(),stopReason:'error',content:[{type:'text',text:'Recovery failed; submit a new prompt.'}]},user('Read marker.txt now as a new request.')];
 assert.doesNotThrow(()=>boundary.prepare(fresh));assert.equal(boundary.turnStart(fresh),fresh.length-1);
 assert.throws(()=>boundary.assertNotRetired(messages),/wake recovery is terminal/,'new authority must not revive the retired context');
});
// 2026-10-06: extensions append status notes after the recovery prompt; Pi
// hands them to the provider as user messages. The recovery must still own the
// original wake, or the empty barrier is replayed as "No response requested."
test('extension notes after the recovery prompt keep the original wake in the recovery turn',()=>{
 const {boundary,messages}=fixture();messages.push(user('WIP 0/3 · 3 open · next: proof'),user('owner note'));
 assert.equal(boundary.turnStart(messages),2,'the empty barrier must not become replayed history');
 assert.equal(boundary.prepare(messages),true);
 boundary.consume(messages);assert.equal(boundary.turnStart(messages),4,'consumed capability cannot dispatch twice');
 assert.throws(()=>boundary.prepare(messages),/wake recovery is terminal/);
});
test('a note before the recovery prompt still does not broaden the turn',()=>{
 const {boundary,messages}=fixture();messages.splice(4,0,user('WIP 0/3 · 3 open'));
 assert.equal(boundary.turnStart(messages),4);
});
test('saved/reloaded tags do not create a capability',()=>{const {messages}=fixture();assert.equal(new WakeRecoveryBoundary().turnStart(messages),4);});
test('original batch bodies and images remain ordered and byte-identical',()=>{
 const boundary=new WakeRecoveryBoundary();const wakes=[user('Action A'),user([{type:'text',text:'Action B'},{type:'image',data:'YWJj',mimeType:'image/png'}])];
 const barrier=empty();boundary.markBlocked(barrier,wakes);const messages=[...wakes,barrier,user(WAKE_RECOVERY_PROMPT)];const before=JSON.stringify(messages);
 assert.equal(boundary.turnStart(messages),0);assert.equal(JSON.stringify(messages),before);
});
