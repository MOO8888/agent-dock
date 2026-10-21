import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createDock } from '../src/server.mjs';

const fixture = () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agentdock-management-'));
  const store=new Store(directory), p=store.createProject({title:'项目管理验证',goal:'保留真实交付资料'});
  const task=store.createTask(p.id,{title:'保留文件',description:'测试成果保留',acceptance:'恢复后文件和凭证一致',assignee:'codex',output:'proof.txt'});
  const artifact=store.writeArtifact(p.id,{relative:'proof.txt',content:'这是测试文件，不是用户资料'});
  store.postUser(p.id,'保留这条消息');
  return {directory,store,p,task,artifact};
};

test('rename persists without changing goal, folder, messages, tasks or artifacts',()=>{
  const {directory,store,p}=fixture(), before=store.project(p.id);
  const unchanged=structuredClone(before);
  assert.throws(()=>store.updateProject(p.id,{title:'   '}));
  assert.deepEqual(store.project(p.id),unchanged);
  const renamed=store.updateProject(p.id,{title:'  更新后的名称  '});
  assert.equal(renamed.title,'更新后的名称');
  for(const key of ['id','workspace','goal','messages','tasks','artifacts','inbox','team'])assert.deepEqual(renamed[key],unchanged[key]);
  const restarted=new Store(directory);
  assert.equal(restarted.project(p.id).title,renamed.title);
  assert.equal(fs.readFileSync(path.join(p.workspace,'proof.txt'),'utf8'),'这是测试文件，不是用户资料');
});

test('delete and restore survive restart, preserve files and uncertain dispatch, and never resume work',()=>{
  const {directory,store,p,task,artifact}=fixture();
  store.runProject(p.id);store.pauseProject(p.id);
  const original=store.project(p.id);
  original.tasks[0].dispatch={status:'unknown',phase:'sending',prompt:'历史任务'};original.tasks[0].status='waiting';store.save();
  const before=structuredClone(original), removed=store.deleteProject(p.id);
  assert.ok(removed.deletedAt);assert.equal(removed.statusBeforeDelete,'paused');
  assert.equal(store.state.activeProjectId,null);assert.equal(store.state.projects.length,0);
  assert.throws(()=>store.project(p.id),{code:'not_found'});
  assert.throws(()=>store.deleteProject(p.id),{code:'not_found'});
  assert.equal(fs.readFileSync(path.join(p.workspace,'proof.txt'),'utf8'),'这是测试文件，不是用户资料');
  const restarted=new Store(directory);assert.equal(restarted.state.deletedProjects.length,1);
  const restored=restarted.restoreProject(p.id);
  assert.equal(restored.status,'paused');assert.equal(restored.deletedAt,undefined);assert.equal(restored.statusBeforeDelete,undefined);
  assert.equal(restarted.state.activeProjectId,null);assert.equal(restarted.state.deletedProjects.length,0);
  for(const key of ['id','workspace','goal','tasks','artifacts','inbox','team'])assert.deepEqual(restored[key],before[key]);
  assert.deepEqual(restored.messages.slice(0,-1),before.messages);
  assert.equal(restored.tasks[0].id,task.id);assert.equal(restored.artifacts[0].sha256,artifact.sha256);
  assert.throws(()=>restarted.restoreProject(p.id),{code:'not_found'});
  assert.equal(new Store(directory).state.projects[0].status,'paused');
});

test('running, human-controlled and currently dispatching projects cannot be deleted',()=>{
  const {store,p}=fixture();store.runProject(p.id);
  assert.throws(()=>store.deleteProject(p.id),{code:'project_running'});
  store.pauseProject(p.id);store.project(p.id).tasks[0].dispatch={status:'sending'};
  assert.throws(()=>store.deleteProject(p.id),{code:'project_dispatching'});
  store.project(p.id).tasks[0].dispatch=null;
  const other=store.createProject({title:'人工操作',goal:'测试接管保护'});store.project(other.id).takeover={active:true};
  assert.throws(()=>store.deleteProject(p.id),{code:'human_takeover_active'});
  store.project(other.id).takeover.active=false;store.deleteProject(p.id);
  store.project(other.id).takeover.active=true;
  assert.throws(()=>store.restoreProject(p.id),{code:'human_takeover_active'});
  assert.equal(store.state.deletedProjects.length,1);
});

test('restoring a completed delivery preserves its completed state and evidence',()=>{
  const {store,p,task}=fixture();
  store.updateTask(p.id,task.id,{status:'done',evidence:[{type:'file',detail:'核对测试文件内容'}]});
  store.inbox(p.id,store.inbox(p.id).map(item=>item.id));
  store.completeProject(p.id,'测试交付完成');store.deleteProject(p.id);
  const restored=store.restoreProject(p.id);
  assert.equal(restored.status,'completed');assert.equal(restored.tasks[0].status,'done');assert.equal(restored.tasks[0].evidence.length,1);
});

test('project management HTTP routes require local authentication, block foreign origins and restore file access',async t=>{
  const {directory,p,artifact}=fixture();
  const dock=createDock({directory,native:{stop(){}}});
  await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));t.after(()=>dock.close());
  const base=`http://127.0.0.1:${dock.server.address().port}`, route=`/api/projects/${p.id}`;
  const home=await fetch(base), cookie=home.headers.get('set-cookie').split(';')[0];
  const send=(method,url,body,extra={})=>fetch(base+url,{method,headers:{cookie,'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await fetch(base+route,{method:'DELETE'})).status,401);
  assert.equal((await fetch(base+route+'/restore',{method:'POST'})).status,401);
  assert.equal((await send('DELETE',route,undefined,{origin:'https://untrusted.example'})).status,403);
  assert.equal((await send('PATCH',route,{title:'接口重命名'})).status,200);
  await send('POST',route+'/run',{});assert.equal((await send('DELETE',route)).status,409);
  await send('POST',route+'/pause',{});assert.equal((await send('DELETE',route)).status,200);
  const snapshot=await (await fetch(base+'/api/state',{headers:{cookie}})).json();
  assert.equal(snapshot.projects.length,0);assert.equal(snapshot.deletedProjects[0].title,'接口重命名');
  const fileRoute=`/api/artifact/${p.id}/${artifact.id}`;
  assert.equal((await fetch(base+fileRoute,{headers:{cookie}})).status,404);
  const response=await send('POST',route+'/restore',{});assert.equal(response.status,200);assert.equal((await response.json()).status,'paused');
  const file=await fetch(base+fileRoute,{headers:{cookie}});assert.equal(file.status,200);assert.equal(await file.text(),'这是测试文件，不是用户资料');
});
