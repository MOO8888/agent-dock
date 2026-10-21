import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDock} from '../src/server.mjs';import {Store} from '../src/store.mjs';
const connection=name=>({autoBind:true,autoLaunch:false,desktop:'AgentDock_test',executable:`C:\\Official\\${name}.exe`});
test('service startup, passive reads, MCP connection and saving settings do not bind; a group goal connects only its team',async t=>{
 const calls=[],native={stop(){},async call(action,args){calls.push({action,args});if(action==='ensure_desktop')return {};if(action==='windows')return {windows:[{id:1,pid:10,title:'豆包工作',executable:connection('Work').executable,width:1200,height:800},{id:2,pid:20,title:'豆包',executable:connection('Doubao').executable,width:1200,height:800}]};throw Error('unexpected native action');}};
 const dock=createDock({directory:fs.mkdtempSync(path.join(os.tmpdir(),'dock-activation-')),native});
 const p=dock.store.createProject({title:'按需连接',goal:'待命',team:[{memberId:'codex'},{memberId:'doubao_work'}]});
 dock.store.saveMember({id:'doubao_work',connection:connection('Work')});dock.store.saveMember({id:'doubao',connection:connection('Doubao')});
 await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));t.after(()=>dock.close());
 const base=`http://127.0.0.1:${dock.server.address().port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
 const post=(route,body)=>fetch(base+route,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
 await fetch(base+'/api/state',{headers:{cookie}});await post('/api/tools/call',{name:'dock_connect',arguments:{host:'Codex startup probe'}});
 await post('/api/members',{id:'doubao_work',connection:connection('Work')});dock.clients.reconnect();await dock.clients.pending;
 assert.equal(calls.length,0);assert.equal(dock.store.member('doubao_work').window,null);
 assert.equal((await post(`/api/projects/${p.id}/messages`,{text:'开始规划'})).status,200);await dock.clients.pending;
 assert.equal(dock.store.member('doubao_work').window.id,1);assert.equal(dock.store.member('doubao').window,null);assert.equal(calls.filter(c=>c.action==='windows').length,1);assert.equal(dock.store.project(p.id).desktop,'AgentDock_test');
 await post(`/api/projects/${p.id}/pause`,{});const count=calls.length;dock.clients.reconnect();await dock.clients.pending;assert.equal(calls.length,count);
 assert.equal((await post(`/api/projects/${p.id}/run`,{})).status,200);await dock.clients.pending;assert.ok(calls.length>count);
});
test('a service restart never resumes binding for an old running project',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dock-activation-')),seed=new Store(directory),p=seed.createProject({title:'旧项目',goal:'保留记录'});
 seed.saveMember({id:'doubao',connection:connection('Doubao')});seed.runProject(p.id);
 const calls=[],dock=createDock({directory,native:{stop(){},async call(action){calls.push(action);throw Error('must remain idle');}}});
 await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));t.after(()=>dock.close());dock.clients.reconnect();await dock.clients.pending;
 assert.equal(dock.store.project(p.id).status,'paused');assert.equal(calls.length,0);
});
