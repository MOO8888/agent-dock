import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {diagnostics,coordinatorState,solutionFor} from '../src/diagnostics.mjs';import {createDock} from '../src/server.mjs';
test('automatic host readiness never expires with a manual heartbeat; dormant is not a failure',()=>{
 const state={coordinator:{lastSeen:'2000-01-01T00:00:00Z'},members:[],projects:[]};
 assert.equal(coordinatorState(state,{snapshot:()=>({status:'ready'})},false).coordinator.connected,true);
 assert.equal(coordinatorState(state,null,false).coordinator.connected,false);
 assert.deepEqual(diagnostics(state,{status:'dormant'}),[]);
 assert.equal(coordinatorState(state,{snapshot:()=>({status:'dormant'})},false).runtime.status,'dormant');
});
test('actual blocked work yields stable distinct remedies and disappears once resolved',()=>{
 const state={members:[{id:'trae',name:'TRAE'}],projects:[{id:'p',title:'游戏',status:'running',tasks:[{id:'t',assignee:'trae',status:'queued',fast:{suspended:true,error:'窗口已关闭，请重新绑定'}}]}]};
 const issues=diagnostics(state,{status:'ready'});assert.equal(issues.length,1);assert.equal(issues[0].action,'member');assert.equal(issues[0].id,diagnostics(state,{status:'ready'})[0].id);
 assert.equal(solutionFor('quota exhausted',{coordinator:true}).code,'quota');assert.equal(solutionFor('ChatGPT 登录失效',{coordinator:true}).code,'login');
 assert.equal(solutionFor('需要处理绑定、登录或额度').code,'client');assert.equal(solutionFor('连接已关闭',{uncertain:true}).action,'thread');
 state.projects[0].tasks[0].status='done';assert.deepEqual(diagnostics(state,{status:'ready'}),[]);
});
test('health check authenticates local protocol only; state reads never connect or operate clients',async t=>{
 const runtime=new EventEmitter();let checks=0,calls=0;runtime.snapshot=()=>({status:checks?'ready':'dormant'});runtime.check=async()=>{checks++;return runtime.snapshot();};runtime.close=()=>{};
 const dock=createDock({directory:fs.mkdtempSync(path.join(os.tmpdir(),'dock-diagnostics-')),native:{stop(){},call(){calls++;throw Error('must not operate clients');}},coordinatorRuntime:runtime});
 await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));t.after(()=>dock.close());const base=`http://127.0.0.1:${dock.server.address().port}`,headers={Authorization:`Bearer ${dock.token}`,'Content-Type':'application/json'};
 for(let i=0;i<2;i++){const state=await (await fetch(base+'/api/state',{headers})).json();assert.equal(state.coordinatorRuntime.status,'dormant');assert.deepEqual(state.issues,[]);}
 assert.equal(checks,0);assert.equal((await fetch(base+'/api/coordinator/check',{method:'POST',body:'{}'})).status,401);
 const result=await (await fetch(base+'/api/coordinator/check',{method:'POST',headers,body:'{}'})).json();assert.equal(result.status,'ready');assert.equal(checks,1);assert.equal(calls,0);assert.equal(dock.store.state.projects.length,0);
});
