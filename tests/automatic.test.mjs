import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { AutomaticExecution, composerControls, freshReply } from '../src/automatic.mjs';
import { Activity } from '../src/activity.mjs';
import { projectProgress } from '../web/activity.js';

const create = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(),'dock-auto-')));
function setup({draft='',delay=false,uncertain=false}={}) {
  const store=create();
  store.saveMember({id:'doubao_work',window:{id:123,pid:456},connection:{autoBind:true,autoLaunch:false,desktop:'AgentDock_Test',executable:'C:\\Official\\Client.exe'}});
  const p=store.createProject({title:'自动派发验证',goal:'生成真实文件',team:[{memberId:'codex'},{memberId:'doubao_work'}]});
  let sequence=0,reply='',last; const calls=[];
  const snapshot=()=>last={observationId:'o'+sequence++,createdAt:new Date().toISOString(),window:{id:123,title:'Official task'},text:reply||'实际客户端',elements:[{index:0,type:'Text',name:store.project(p.id).tasks[0]?.dispatch?.prompt||''},{index:1,type:'Text',name:reply},{index:2,type:'Group',className:'tiptap ProseMirror',canSetValue:true,value:draft},{index:3,type:'Button',className:'g-send-msg-btn-bg',canInvoke:true,enabled:true}]};
  const native={async observe(member,desktop,options){calls.push({action:'observe',options});return snapshot();},checked(){return last;},async act(member,args){calls.push(args);if(args.action==='set_value'){draft=args.value;if(delay){delay=false;throw new Error('delayed readback');}}else {if(uncertain)throw new Error('unknown send');draft='';}return {result:{},observation:snapshot()};}};
  const automatic=new AutomaticExecution(store,native,{timer:false});store.off('change',automatic.schedule);
  return {store,p,native,automatic,calls,setReply:text=>{reply=text;automatic.lastObservation.clear();}};
}

function plan({store,p}) {
 const ids=store.inbox(p.id).map(item=>item.id);store.inbox(p.id,ids);
 return store.createTask(p.id,{title:'Codex 编写的具体任务',description:'读取输入文件，生成约定内容并报告实际路径。保留原文件。',acceptance:'本地文件存在且内容符合要求，由 Codex 复核。',output:'deliveries/planned/result.txt',stage:'execution',assignee:'doubao_work',dispatchMode:'automatic'});
}
test('a message atomically starts draft, paused and completed projects and deduplicates retries',()=>{
  const store=create(),p=store.createProject({title:'A',goal:'B'});
  for(const status of ['draft','paused','completed']) {
    store.project(p.id).status=status;
    const message=store.postUser(p.id,'继续 '+status,'request_'+status),count=store.project(p.id).inbox.length;
    assert.equal(store.project(p.id).status,'running');assert.equal(store.state.activeProjectId,p.id);
    assert.equal(store.postUser(p.id,'继续 '+status,'request_'+status).id,message.id);assert.equal(store.project(p.id).inbox.length,count);
    assert.throws(()=>store.postUser(p.id,'不同内容','request_'+status),{code:'message_conflict'});
  }
  assert.equal(store.inbox(p.id).filter(e=>e.type==='project.start').length,0);
});

test('another running project and human takeover reject auto-start before saving the message',()=>{
  const store=create(),a=store.createProject({title:'A',goal:'A'}),b=store.createProject({title:'B',goal:'B'});
  store.runProject(a.id);const before=store.project(b.id).messages.length;
  assert.throws(()=>store.postUser(b.id,'test'),{code:'project_busy'});assert.equal(store.project(b.id).messages.length,before);
  store.pauseProject(a.id);store.project(a.id).takeover={active:true};
  assert.throws(()=>store.postUser(b.id,'test'),{code:'human_takeover_active'});assert.equal(store.project(b.id).messages.length,before);
});

test('old finished tasks cannot close a newly submitted goal before its inbox message is handled',()=>{
  const store=create(),p=store.createProject({title:'A',goal:'B'});
  const task=store.createTask(p.id,{title:'旧任务',description:'旧要求',acceptance:'旧验收',assignee:'codex'});
  store.updateTask(p.id,task.id,{status:'done',evidence:[{type:'manual',detail:'旧任务已实际检查'}]});
  store.postUser(p.id,'新增一个要求');assert.throws(()=>store.completeProject(p.id,'旧任务完成'),{code:'pending_messages'});
});

test('only a Codex-authored task is transported, and real files return for review',async()=>{
  const {store,p,automatic,calls,setReply}=setup();store.postUser(p.id,'写一个实际文件','message1');
  await automatic.tick();assert.equal(store.project(p.id).tasks.length,0);assert.equal(calls.length,0);plan({store,p});await automatic.tick();const task=store.project(p.id).tasks[0];
  assert.equal(task.dispatch.status,'sent');assert.equal(task.attempts,1);assert.equal(store.state.coordinator.connected,false);
  assert.deepEqual(calls.filter(c=>c.action!=='observe').map(c=>c.action),['set_value','invoke']);
  assert.ok(calls.filter(c=>c.action==='observe').every(c=>c.options.screenshot===false));
  const file=path.join(p.workspace,task.fast.outputDirectory,'result.txt');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'真实产物');
  setReply(`已保存 result.txt\n【AgentDock 完成 ${task.id}】`);await automatic.tick();
  assert.equal(task.status,'review');assert.equal(store.project(p.id).artifacts.length,1);
  assert.equal(store.project(p.id).messages.at(-2).provenance.type,'official-ui');
  assert.equal(store.project(p.id).status,'running');assert.equal(store.project(p.id).execution.phase,'delivered');
  assert.equal(projectProgress(store.project(p.id),store.snapshot()),null);
  assert.equal(store.inbox(p.id).length,0);automatic.stop();
});

test('delayed readback observes and sends the exact draft, never writes it twice',async()=>{
  const {store,p,automatic,calls}=setup({delay:true});store.postUser(p.id,'实际工作');plan({store,p});await automatic.tick();
  assert.equal(store.project(p.id).tasks[0].dispatch.phase,'filling');assert.equal(store.project(p.id).execution.phase,'reading');
  await automatic.tick();assert.equal(store.project(p.id).tasks[0].dispatch.status,'sent');
  assert.deepEqual(calls.filter(c=>c.action!=='observe').map(c=>c.action),['set_value','invoke']);automatic.stop();
});

test('explicit resume clears an old blocked display before asynchronous readback starts',()=>{
  const {store,p,automatic}=setup();store.postUser(p.id,'实际工作');
  store.project(p.id).execution={phase:'blocked',detail:'上次的停止原因'};
  automatic.wake(p.id);assert.equal(store.project(p.id).execution.phase,'coordinator');automatic.stop();
});

test('uncertain send, existing draft and foreground desktop never fall back to unsafe input',async()=>{
  const uncertain=setup({uncertain:true});uncertain.store.postUser(uncertain.p.id,'工作');plan(uncertain);await uncertain.automatic.tick();await uncertain.automatic.tick();
  assert.equal(uncertain.store.project(uncertain.p.id).execution.phase,'blocked');assert.equal(uncertain.calls.filter(c=>c.action==='invoke').length,1);uncertain.automatic.stop();
  const draft=setup({draft:'用户的草稿'});draft.store.postUser(draft.p.id,'工作');plan(draft);await draft.automatic.tick();await draft.automatic.tick();
  assert.equal(draft.calls.filter(c=>c.action==='set_value').length,0);assert.equal(draft.calls.length,1);draft.automatic.stop();
  const foreground=setup();foreground.store.updateProject(foreground.p.id,{desktop:'default'});foreground.store.postUser(foreground.p.id,'工作');plan(foreground);await foreground.automatic.tick();
  assert.equal(foreground.calls.length,0);assert.equal(foreground.store.project(foreground.p.id).execution.phase,'blocked');foreground.automatic.stop();
});

test('multi-member and ask-first projects wait for real coordination without dispatching',async()=>{
  for(const type of ['team','ask']) {
    const {store,p,automatic,calls}=setup();
    store.updateProject(p.id,type==='ask'?{freedom:'ask'}:{team:[{memberId:'codex'},{memberId:'doubao_work'},{memberId:'trae'}]});
    store.postUser(p.id,'工作');await automatic.tick();assert.equal(calls.length,0);assert.equal(store.project(p.id).execution.phase,'coordinator');
    assert.equal(projectProgress(store.project(p.id),store.snapshot()).spinning,false);automatic.stop();
  }
});

test('worker questions go to group chat and answers wait for Codex replanning',async()=>{
  const {store,p,automatic,calls,setReply}=setup();store.postUser(p.id,'制作图片');plan({store,p});await automatic.tick();
  const original=store.project(p.id).tasks[0];setReply(`【AgentDock 提问 ${original.id}】需要什么颜色？`);await automatic.tick();
  assert.equal(original.status,'waiting');assert.equal(store.project(p.id).messages.at(-1).kind,'question');
  assert.equal(projectProgress(store.project(p.id),{...store.snapshot(),activities:[]}).spinning,false);
  store.postUser(p.id,'蓝色');await automatic.tick();
  assert.equal(store.project(p.id).tasks.length,1);assert.equal(store.project(p.id).execution.phase,'coordinator');
  assert.equal(original.attempts,1);assert.equal(original.status,'waiting');
  assert.equal(calls.filter(c=>c.action==='invoke').length,1);automatic.stop();
});

test('fresh replies exclude old history and composer drafts; ambiguous controls stop dispatch',()=>{
  const task={id:'task_1'}, observation={elements:[{index:0,type:'Text',name:'旧的完成回复'},{index:1,type:'Text',name:'【AgentDock 任务 task_1】新要求'},{index:2,type:'Text',name:'新的真实回复'},{index:3,type:'Group',canSetValue:true,className:'ProseMirror',value:'用户草稿'},{index:4,type:'Text',name:'其他区域'}]};
  assert.equal(freshReply(observation,task),'新的真实回复');
  observation.elements.push({index:5,type:'Group',canSetValue:true,className:'ProseMirror'});assert.throws(()=>composerControls(observation),/唯一/);
});

test('an old answered-or-superseded question cannot starve a newly planned Codex task',async()=>{
  const f=setup();f.store.postUser(f.p.id,'制作图片');plan(f);await f.automatic.tick();
  const old=f.store.project(f.p.id).tasks[0];f.setReply(`【AgentDock 提问 ${old.id}】需要补充什么？`);await f.automatic.tick();assert.equal(old.status,'waiting');
  f.store.postUser(f.p.id,'新目标已经明确');plan(f);await f.automatic.tick();
  const next=f.store.project(f.p.id).tasks[1];assert.equal(next.dispatch.status,'sent');assert.equal(old.attempts,1);assert.equal(f.calls.filter(c=>c.action==='invoke').length,2);f.automatic.stop();
});

test('client stop controls cannot be clicked as send, and reply extraction excludes composer controls',()=>{
  const observation={elements:[{index:0,type:'Text',name:'【AgentDock 任务 task_1】新要求'},{index:1,type:'Text',name:'当前真实回复'},{index:2,type:'Button',name:'本地电脑'},{index:3,type:'Text',name:'无关控件'},{index:4,type:'Group',canSetValue:true,className:'ProseMirror'},{index:5,type:'Button',canInvoke:true,name:'停止生成',className:'g-send-msg-btn-bg'}]};
  assert.throws(()=>composerControls(observation),/仍在执行/);assert.equal(freshReply(observation,{id:'task_1'}),'当前真实回复');
});

test('ephemeral activity expires and waiting, errors and completed projects do not keep spinning',()=>{
  let time=0;const activity=new Activity(()=>time),id=activity.begin({projectId:'p',title:'正在输入'});
  const state={members:[{id:'codex',name:'Codex'}],coordinator:{connected:false},activities:activity.snapshot()};
  const project={id:'p',status:'running',tasks:[],inbox:[]};assert.equal(projectProgress(project,state,time).spinning,true);
  activity.finish(id);state.activities=activity.snapshot();assert.equal(projectProgress(project,state,time).spinning,false);
  time=2001;state.activities=activity.snapshot();assert.equal(projectProgress(project,state,time),null);
  project.inbox=[{acknowledged:false}];assert.equal(projectProgress(project,state,time).spinning,false);
  project.status='completed';assert.equal(projectProgress(project,state,time),null);
});

test('coordinator progress reports refresh one actual stage, expire without heartbeats, and finish explicitly',()=>{
  let time=0;const activity=new Activity(()=>time);
  const id=activity.report('p',{title:'正在执行代码',detail:'运行实际检查'});time=1000;
  assert.equal(activity.report('p',{title:'正在检验成果'}),id);assert.equal(activity.snapshot().length,1);
  time=31001;assert.equal(activity.snapshot().length,0);
  const resumed=activity.report('p',{title:'正在读取内容'});activity.report('p',{finished:true});
  assert.equal(activity.snapshot()[0].id,resumed);assert.equal(activity.snapshot()[0].status,'done');
});
