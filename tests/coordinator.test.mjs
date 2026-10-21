import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/store.mjs';
import {bindCoordinator,reportHostSettings} from '../src/coordinator.mjs';
import {executeTool} from '../src/tools.mjs';
const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
test('dedicated model requests survive restart and reject stale or wrong-task receipts',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dock-coordinator-')),store=new Store(directory);
 store.saveMember({id:'codex',inference:{model:'gpt-6-luna',effort:'high'}});const unbound=store.state.coordinatorRequests.at(-1);
 bindCoordinator(store,{threadId:first});assert.equal(unbound.status,'superseded');
 const request=store.state.coordinatorRequests.at(-1);assert.equal(request.threadId,first);assert.equal(request.status,'pending');assert.equal(store.member('codex').inferenceApplied,undefined);
 const restored=new Store(directory);assert.equal(restored.state.coordinatorBinding.threadId,first);assert.equal(restored.state.coordinator.connected,false);assert.equal(restored.state.coordinatorRequests.at(-1).status,'pending');
 assert.throws(()=>reportHostSettings(restored,{requestId:request.id,threadId:second,status:'submitted',detail:'accepted'}),{code:'host_thread_mismatch'});
 reportHostSettings(restored,{requestId:request.id,threadId:first,status:'submitted',detail:'Official task tool accepted next-turn parameters'});
 assert.equal(restored.member('codex').hostSettingReceipt.status,'submitted');assert.equal(restored.member('codex').inferenceApplied,undefined);
 restored.saveMember({id:'codex',inference:{model:'gpt-6-sol',effort:'medium'}});
 assert.throws(()=>reportHostSettings(restored,{requestId:request.id,threadId:first,status:'submitted',detail:'old'}),{code:'host_request_stale'});
 bindCoordinator(restored,{threadId:second});assert.equal(restored.state.coordinatorRequests.at(-1).threadId,second);assert.equal(restored.member('codex').hostSettingReceipt,undefined);
 restored.heartbeat('test');await assert.rejects(executeTool('dock_disconnect',{threadId:first},restored,{}),{code:'host_thread_mismatch'});
 await executeTool('dock_disconnect',{threadId:second,reason:'等待用户恢复'},restored,{});assert.equal(restored.state.coordinator.lastSeen,null);assert.equal(restored.state.coordinator.connected,false);assert.equal(restored.state.coordinatorBinding.threadId,second);
});
test('unsupported host model/effort never changes desired settings or queues work',()=>{
 const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),'dock-coordinator-')));
 for(const inference of [{model:'unknown',effort:'high'},{model:'gpt-6-luna',effort:'ultra'},{model:'',effort:'ultra'}])assert.throws(()=>store.saveMember({id:'codex',inference}));
 assert.equal(store.member('codex').inference,undefined);assert.equal(store.state.coordinatorRequests,undefined);
});
