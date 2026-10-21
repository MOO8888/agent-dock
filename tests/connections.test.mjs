import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {ClientConnections} from '../src/connections.mjs';

const setup=()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agentdock-connections-'));const store=new Store(directory);const p=store.createProject({title:'自动连接验证',goal:'准备官方客户端'});return {store,p,directory};};
const c={autoBind:true,autoLaunch:true,executable:'C:\\Official\\TRAE.exe',arguments:'--user-data-dir="{profile}" "{workspace}"',desktop:'AgentDock_test',className:'Chrome_WidgetWin_1'};
const window=(id=22,extra={})=>({id,pid:id+100,title:'workspace - TRAE',executable:c.executable,className:c.className,width:1200,height:800,minimized:false,...extra});
const options={sleep:async()=>{},delays:[0,0],fileExists:()=>true};

test('explicit project connection launches once, binds only the configured desktop and never dispatches work',async()=>{
  const {store,p}=setup();store.saveMember({id:'trae',connection:c});const calls=[];let windows=[];
  const native={observations:new Map(),async call(action,args){calls.push({action,args});if(action==='ensure_desktop')return {created:true};if(action==='windows'){assert.equal(args.desktop,c.desktop);return {windows};}if(action==='launch'){windows=[window()];return {pid:122};}throw new Error('no UI actions or model requests allowed');}};
  const clients=new ClientConnections(store,native,options);clients.start(p.id);clients.start(p.id);await clients.pending;
  assert.equal(calls.filter(x=>x.action==='launch').length,1);assert.equal(store.member('trae').window.id,22);
  assert.match(calls.find(x=>x.action==='launch').args.arguments,/profiles/);assert.ok(calls.find(x=>x.action==='launch').args.arguments.includes(p.workspace));
  assert.equal(store.project(p.id).status,'draft');assert.equal(store.project(p.id).desktop,c.desktop);assert.equal(store.project(p.id).tasks.length,0);
  clients.start(p.id);await clients.pending;assert.equal(calls.filter(x=>x.action==='launch').length,1);
});

test('background reconnect stays idle without a running project and stops before launching when paused',async()=>{
  const {store,p}=setup();store.saveMember({id:'trae',connection:c});const calls=[];
  const native={async call(action){calls.push(action);if(action==='ensure_desktop')return {};if(action==='windows'){store.pauseProject(p.id);return {windows:[]};}throw new Error('must not launch after pause');}};
  const clients=new ClientConnections(store,native,options);
  for(const status of ['draft','paused','completed']){store.project(p.id).status=status;clients.reconnect();assert.equal(clients.pending,null);}
  assert.equal(calls.length,0);store.project(p.id).status='draft';store.runProject(p.id);clients.reconnect();await clients.pending;
  assert.deepEqual(calls,['ensure_desktop','windows']);assert.equal(store.member('trae').status,'unbound');
  assert.equal(clients.status.running,false);assert.equal(store.project(p.id).status,'paused');
});

test('restart discards obsolete handles and rebinds a new actual window',async()=>{
  const {store,p,directory}=setup();store.saveMember({id:'trae',connection:c,window:window(1)});
  const restored=new Store(directory);assert.equal(restored.member('trae').window,null);assert.equal(restored.member('trae').connection.windowHint.id,1);
  const native={observations:new Map([['obsolete',{}]]),async call(action){if(action==='ensure_desktop')return {created:true};if(action==='windows')return {windows:[window(50)]};throw new Error('must not relaunch existing client');}};
  const clients=new ClientConnections(restored,native,options);clients.start(p.id);await clients.pending;
  assert.equal(restored.member('trae').window.id,50);assert.equal(restored.member('trae').window.pid,150);assert.equal(native.observations.size,0);
});

test('a successfully bound client can be restarted after its window exits',async()=>{
  const {store,p}=setup();store.saveMember({id:'trae',connection:c});let windows=[],launches=0;
  const native={async call(action){if(action==='ensure_desktop')return {};if(action==='windows')return {windows};if(action==='launch'){launches++;windows=[window(launches*10)];return {pid:100+launches*10};}throw new Error('must not dispatch');}};
  const clients=new ClientConnections(store,native,options);clients.start(p.id);await clients.pending;assert.equal(store.member('trae').window.id,10);
  windows=[];clients.start(p.id);await clients.pending;assert.equal(store.member('trae').window.id,20);assert.equal(launches,2);
});

test('ambiguous windows and unrelated default-desktop chats are not automatically selected',async()=>{
  const {store,p}=setup();store.saveMember({id:'trae',connection:c});let windows=[window(10),window(11)];let launches=0;
  const native={async call(action){if(action==='ensure_desktop')return {};if(action==='windows')return {windows};if(action==='launch')launches++;}};
  const clients=new ClientConnections(store,native,options);clients.start(p.id);await clients.pending;
  assert.equal(store.member('trae').window,null);assert.match(store.member('trae').detail,/多个/);assert.equal(launches,0);
  store.saveMember({id:'trae',connection:{...c,autoLaunch:false,desktop:'default',title:'专用工作会话'}});windows=[window(20,{title:'用户正在使用的其他会话'})];
  clients.start(p.id);await clients.pending;assert.equal(store.member('trae').window,null);assert.equal(launches,0);
});

test('rechecking a live renamed window preserves current observations and quota state',async()=>{
  const {store,p}=setup();store.saveMember({id:'trae',connection:{...c,autoLaunch:false,desktop:'default',title:'old'},window:window(10,{title:'old'})});store.member('trae').status='quota';
  const native={observations:new Map([['in-flight',{}]]),async call(action){assert.equal(action,'windows');return {windows:[window(10,{title:'renamed'})]};}};
  const clients=new ClientConnections(store,native,options);clients.start(p.id);await clients.pending;
  assert.equal(store.member('trae').window.title,'renamed');assert.equal(store.member('trae').status,'quota');assert.equal(native.observations.size,1);
});

test('human takeover pauses startup and an uncertain launch is not automatically repeated',async()=>{
  const {store,p}=setup();store.saveMember({id:'trae',connection:c});let launches=0;const calls=[];
  const native={async call(action){calls.push(action);if(action==='ensure_desktop')return {};if(action==='windows')return {windows:[]};if(action==='launch'){launches++;throw new Error('launch response lost');}}};
  const clients=new ClientConnections(store,native,options);store.project(p.id).takeover={active:true};clients.start(p.id);await clients.pending;assert.equal(calls.length,0);
  store.project(p.id).takeover.active=false;clients.start(p.id);await clients.pending;clients.start(p.id);await clients.pending;assert.equal(launches,1);
});

test('invalid launch settings do not partially change member configuration',()=>{
  const {store}=setup();store.saveMember({id:'trae',connection:c});const before=store.snapshot();
  for(const connection of [{...c,desktop:'default'},{...c,executable:'C:\\Windows\\cmd.exe'},{...c,desktop:'unrelated'},{...c,autoBind:false},{...c,autoBind:'yes'}])assert.throws(()=>store.saveMember({id:'trae',name:'changed',connection}));
  assert.deepEqual(store.snapshot(),before);
});

test('two members using the same client never claim the same official window',async()=>{
  const {store,p}=setup();store.saveMember({id:'trae',connection:{...c,autoLaunch:false},window:window(22)});
  const extra=store.saveMember({name:'另一个执行者',provider:'TRAE',role:'检验',connection:{...c,autoLaunch:false}});
  const native={async call(action){if(action==='ensure_desktop')return {};if(action==='windows')return {windows:[window(22)]};throw new Error('must not act');}};
  const clients=new ClientConnections(store,native,options);clients.start(p.id);await clients.pending;
  assert.equal(store.member('trae').window.id,22);assert.equal(store.member(extra.id).window,null);
});

test('Doubao Work and normal Doubao bind independently by executable identity',async()=>{
  const {store,p}=setup();const normal='C:\\Official\\Doubao.exe',work='E:\\豆包工作\\DoubaoWork\\app\\DoubaoWork.exe';
  store.saveMember({id:'doubao',connection:{...c,autoLaunch:false,executable:normal}});store.saveMember({id:'doubao_work',connection:{...c,autoLaunch:false,executable:work}});
  const windows=[window(30,{executable:normal,title:'豆包'}),window(31,{executable:work,title:'豆包工作'})];
  const native={async call(action){if(action==='ensure_desktop')return {};if(action==='windows')return {windows};throw new Error('must not launch');}};
  const clients=new ClientConnections(store,native,options);clients.start(p.id);await clients.pending;
  assert.equal(store.member('doubao').window.id,30);assert.equal(store.member('doubao_work').window.id,31);
});

test('each project saves its own team, blocks excluded assignees and preserves division after restart',()=>{
  const {store,directory}=setup();const team=[{memberId:'codex',role:'方案与统筹'},{memberId:'doubao_work',role:'制作报告'}];
  const a=store.createProject({title:'报告',goal:'完成报告',team});const b=store.createProject({title:'代码',goal:'完成代码',team:[{memberId:'codex',role:'统筹'},{memberId:'trae',role:'代码检验'}]});
  store.updateProject(a.id,{team:[{memberId:'codex',role:'统筹'},{memberId:'doubao_work',role:'资料整理'}]});
  assert.equal(store.project(b.id).team[1].role,'代码检验');assert.equal(store.member('doubao_work').role,'本地执行');
  assert.throws(()=>store.createTask(a.id,{title:'wrong',assignee:'trae',description:'A',acceptance:'B'}),{code:'member_not_in_project'});
  store.createTask(a.id,{title:'报告',assignee:'doubao_work',description:'A',acceptance:'B'});
  assert.throws(()=>store.updateProject(a.id,{team:[{memberId:'codex',role:'统筹'}]}),{code:'member_has_tasks'});
  assert.throws(()=>store.updateProject(a.id,{team:[{memberId:'doubao_work',role:'执行'}]}));
  const restored=new Store(directory);assert.equal(restored.project(a.id).team[1].role,'资料整理');assert.equal(restored.project(b.id).team[1].role,'代码检验');
});
