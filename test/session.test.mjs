import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('function shell(')[0];
test('expired session clears private state and signature before another account logs in',async()=>{
 const context=vm.createContext({clearTimeout,setTimeout,fetch:async()=>({ok:false,status:401,json:async()=>({error:'expired'})}),go:()=>{}});
 vm.runInContext(source,context);
 await vm.runInContext(`(async()=>{state.user={id:'old',role:'parent'};state.profile={baby:'private'};state.draft={baby:'private'};signData='signature';hasSignature=true;agreed=true;records=[{text:'private'}];await api('/bootstrap').catch(()=>{});})()`,context);
 assert.equal(vm.runInContext('state.user',context),null);
 assert.equal(vm.runInContext('signData',context),'');
 assert.equal(vm.runInContext('hasSignature || agreed || records.length || Object.keys(state.profile).length || Object.keys(state.draft).length',context),0);
});
test('queued draft cannot be written into a different account',async()=>{
 let calls=0;const context=vm.createContext({clearTimeout,setTimeout,fetch:async()=>{calls++;return {ok:true,json:async()=>({})}},go:()=>{}});
 vm.runInContext(source,context);
 await vm.runInContext(`(async()=>{state.user={id:'old',role:'parent'};state.draft={baby:'old'};draftDirty=true;const pending=flushDraft();clearSession();state.user={id:'new',role:'parent'};await pending;})()`,context);
 assert.equal(calls,0);
});
