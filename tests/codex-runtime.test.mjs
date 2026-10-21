import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough,Writable} from 'node:stream';
import {CodexRuntime} from '../src/codex-runtime.mjs';
function fixture({accountType='chatgpt',status='completed'}={}){
 const calls=[],child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const emit=value=>{const line=JSON.stringify(value)+'\n';child.stdout.write(line.slice(0,5));child.stdout.write(line.slice(5));};
 child.stdin=new Writable({write(chunk,encoding,done){const m=JSON.parse(chunk);calls.push(m);queueMicrotask(()=>{if(!('id'in m))return;if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='account/read')emit({id:m.id,result:{account:{type:accountType}}});else if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'official-thread'}}});else if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'turn1'}}});emit({method:'item/completed',params:{threadId:'official-thread',item:{id:'reply',type:'agentMessage',text:'{"ready":true}'}}});emit({method:'turn/completed',params:{threadId:'official-thread',turn:{id:'turn1',status,error:status==='failed'?{message:'quota exhausted'}:null}}});}});done();}});
 const runtime=new CodexRuntime({spawnProcess(command,args,options){assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.ok(args.includes('mcp_servers={}'));return child;}});return {runtime,calls,child,emit};
}
test('official local protocol initializes ChatGPT login and returns only completed structured turns',async()=>{
 const {runtime,calls}=fixture();const threadId=await runtime.createThread({cwd:'C:\\project',model:'gpt-6.1-sol',instructions:'plan only'});const reply=await runtime.run({threadId,text:'new goal',model:'gpt-6.1-sol',effort:'high',schema:{type:'object'}});assert.equal(reply.data.ready,true);assert.equal(reply.turnId,'turn1');assert.equal(calls.filter(c=>c.method==='turn/start').length,1);assert.equal(calls.find(c=>c.method==='thread/start').params.sandbox,'read-only');assert.equal(calls.find(c=>c.method==='turn/start').params.effort,'high');runtime.close();
});

test('a retired process cannot corrupt a recovered connection, and checking never starts inference',async()=>{
 const first=fixture(),second=fixture();let count=0,kills=0;first.child.kill=()=>kills++;
 const runtime=new CodexRuntime({spawnProcess:()=>count++===0?first.child:second.child});
 await runtime.check();assert.equal(runtime.snapshot().status,'ready');assert.equal(runtime.generation,1);
 first.child.stdin.emit('error',Error('EPIPE'));assert.equal(runtime.snapshot().status,'error');assert.equal(kills,1);
 await runtime.check();assert.equal(runtime.generation,2);assert.equal(runtime.snapshot().status,'ready');
 first.child.stdout.write('invalid stale data\n');first.child.emit('exit');assert.equal(runtime.snapshot().status,'ready');
 assert.equal([...first.calls,...second.calls].some(c=>['thread/start','turn/start'].includes(c.method)),false);runtime.close();
});

test('a lost in-flight turn is fenced as uncertain instead of silently replaying',async()=>{
 const f=fixture();await f.runtime.start();let sent=false;
 f.child.stdin=new Writable({write(chunk,encoding,done){if(JSON.parse(chunk).method==='turn/start')sent=true;done();}});
 const running=f.runtime.run({threadId:'official-thread',text:'goal',schema:{}});const rejected=assert.rejects(running,error=>error.outcomeUncertain===true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(sent,true);f.child.emit('exit');await rejected;assert.equal(f.runtime.snapshot().status,'error');assert.equal(f.runtime.turns.size,0);f.runtime.close();
});
test('API-key accounts and failed turns cannot silently fall back or retry inference',async()=>{
 const denied=fixture({accountType:'apiKey'});await assert.rejects(denied.runtime.start(),/ChatGPT 登录/);assert.equal(denied.calls.some(c=>c.method==='thread/start'),false);denied.runtime.close();
 const failed=fixture({status:'failed'});await failed.runtime.createThread({cwd:'C:\\project'});await assert.rejects(failed.runtime.run({threadId:'official-thread',text:'goal',schema:{}}),/quota exhausted/);assert.equal(failed.calls.filter(c=>c.method==='turn/start').length,1);failed.runtime.close();
});
