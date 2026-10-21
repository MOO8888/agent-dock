import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';import {Council} from '../src/council.mjs';import {ClientSessions} from '../src/client-sessions.mjs';
const fixture=()=>{const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),'dock-council-'))),p=store.createProject({title:'会商',goal:'制作小游戏',team:[{memberId:'codex',role:'规划'},{memberId:'trae',role:'执行'},{memberId:'doubao',role:'检验'}]});return {store,p};};
const plan=extra=>({speech:'规划者：先明确范围并收集各方意见。',refinedGoal:'制作一个小型浏览器游戏。',questions:[],approvalConfirmed:false,consultations:[],tasks:[],verdicts:[],complete:false,...extra});
const opening=()=>plan({consultations:[{memberId:'trae',prompt:'从执行职责评估键盘操作、实现范围与缺失条件，暂不写代码。'},{memberId:'doubao',prompt:'从检验职责评估碰撞、失败重开、验收方法，暂不执行。'}]});
async function until(predicate){for(let i=0;i<50;i++){if(predicate())return;await new Promise(r=>setImmediate(r));}assert.fail('asynchronous council did not reach expected state');}

test('a new goal creates independent round state; continuation retains it; raw messages create no execution tasks',()=>{
 const {store,p}=fixture(),c=new Council(store,null),message=store.postUser(p.id,'给我一个小游戏','one');const r=c.enqueue(p.id,message);assert.equal(p.rounds,undefined);const actual=store.project(p.id);
 assert.equal(actual.tasks.length,0);assert.equal(r.participants.length,3);assert.equal(c.enqueue(p.id,message).id,r.id);
 assert.equal(c.enqueue(p.id,store.postUser(p.id,'使用方向键','two'),{mode:'continue'}).id,r.id);
 const next=c.enqueue(p.id,store.postUser(p.id,'另一个目标','three'));assert.notEqual(next.id,r.id);assert.equal(actual.rounds.length,2);c.stop();
});
test('every member must provide an actual consultation before concrete work and stage dependencies can advance',async()=>{
 const {store,p}=fixture(),runtime=new EventEmitter();let calls=0;runtime.close=()=>{};runtime.createThread=async()=> 'official-thread';runtime.run=async()=>{calls++;if(calls===1)return {data:opening(),turnId:'turn1'};const r=store.project(p.id).rounds[0];if(calls===2)return {data:plan({tasks:[{assignee:'trae',title:'实现游戏',description:'制作一个可移动跳跃的最小浏览器游戏，保存独立文件。',acceptance:'实际打开并检查移动和跳跃。',output:`deliveries/${r.id}/game/index.html`,stage:'execution'},{assignee:'doubao',title:'独立检验',description:'读取并运行实际游戏，记录移动、跳跃、重开结果。',acceptance:'报告引用真实文件与实际检查结果。',output:`deliveries/${r.id}/review/check.md`,stage:'review'}]}),turnId:'turn2'};const task=store.project(p.id).tasks.find(t=>t.kind!=='consultation'&&t.status==='review');return {data:plan({verdicts:[{taskId:task.id,decision:'accept',reason:'已核对实际文件与本地验证证据。'}],complete:calls===4}),turnId:'turn'+calls};};
 const c=new Council(store,runtime);const r=c.enqueue(p.id,store.postUser(p.id,'制作小游戏'));
 await until(()=>r.phase==='consulting');assert.equal(calls,1);assert.equal(store.project(p.id).tasks.filter(t=>t.kind==='work').length,0);
 const consult=store.project(p.id).tasks;for(const t of consult){store.postWorker(p.id,{memberId:t.assignee,taskId:t.id,text:t.assignee==='trae'?'建议先做方向键和跳跃。':'建议检验碰撞与重开。',evidence:{type:'official-ui',observationId:'fixture-observation',memberId:t.assignee}});store.updateTask(p.id,t.id,{status:'done',evidence:[{type:'official-ui',detail:'mock actual reply for test'}]});}
 await until(()=>r.phase==='executing');const work=store.project(p.id).tasks.filter(t=>t.kind==='work');assert.equal(work.length,2);assert.deepEqual(work[1].dependsOn,[work[0].id]);assert.equal(calls,2);
 for(const t of work){const file=store.safePath(store.project(p.id),t.output);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'verified fixture');store.updateTask(p.id,t.id,{status:'review'});await until(()=>store.task(p.id,t.id)[1].status==='done');}
 await until(()=>r.status==='completed');assert.equal(calls,4);assert.equal(store.project(p.id).status,'completed');assert.equal(store.project(p.id).messages.filter(m=>m.provenance?.type==='official-ui').length,2);c.stop();
});
test('initial planning cannot bypass members or fabricate consultation replies; unanswered questions do not spin',()=>{
 const {store,p}=fixture(),c=new Council(store,null),r=c.enqueue(p.id,store.postUser(p.id,'做一个游戏'));
 assert.throws(()=>c.apply(store.project(p.id),r,plan({consultations:[]}), 'opening'));assert.equal(store.project(p.id).messages.filter(m=>m.author!=='user'&&m.author!=='system').length,0);
 c.apply(store.project(p.id),r,opening(),'opening');assert.equal(store.project(p.id).tasks.length,2);assert.equal(c.ready(store.project(p.id),r),false);
 c.apply(store.project(p.id),r,plan({questions:['需要支持触屏吗？']}),'consolidating');assert.equal(r.status,'waiting_user');assert.equal(c.ready(store.project(p.id),r),false);assert.equal(store.project(p.id).tasks.filter(t=>t.kind==='work').length,0);c.stop();
});
test('client conversation creation is observed once, respects drafts, and never retries an uncertain click',async()=>{
 const {store,p}=fixture(),c=new Council(store,null),r=c.enqueue(p.id,store.postUser(p.id,'做一个游戏')),member=store.member('trae');member.window={id:1,pid:2};let clicks=0,reads=0;
 const snapshot={observationId:'o',elements:[{index:1,type:'Button',name:'新工作任务 Ctrl N',canInvoke:true},{index:2,canSetValue:true,value:''}]};
 const native={async observe(){reads++;return snapshot;},async act(){clicks++;return {observation:snapshot};}},sessions=new ClientSessions(store,native),task={roundId:r.id};
 await sessions.ensure(store.project(p.id),task,member);await sessions.ensure(store.project(p.id),task,member);assert.equal(clicks,1);assert.equal(reads,1);
 member.window.id=3;await assert.rejects(sessions.ensure(store.project(p.id),task,member),{code:'conversation_changed'});
 r.sessions.trae={status:'pending'};snapshot.elements[1].value='existing draft';await assert.rejects(sessions.ensure(store.project(p.id),task,member),{code:'input_not_empty'});assert.equal(clicks,1);
 snapshot.elements[1].value='';native.act=async()=>{clicks++;throw Error('unknown click');};await assert.rejects(sessions.ensure(store.project(p.id),task,member));await assert.rejects(sessions.ensure(store.project(p.id),task,member),{code:'conversation_uncertain'});assert.equal(clicks,2);c.stop();
});

test('a completed planner reply paused before dispatch is reused once instead of repeating inference',async()=>{
 const {store,p}=fixture(),runtime=new EventEmitter();let finish,calls=0;runtime.close=()=>{};runtime.createThread=async()=> 'official-thread';runtime.run=()=>{calls++;return new Promise(resolve=>finish=resolve);};
 const c=new Council(store,runtime),r=c.enqueue(p.id,store.postUser(p.id,'做一个游戏'));await until(()=>!!finish);
 store.pauseProject(p.id);finish({data:opening(),turnId:'completed-before-pause'});await until(()=>r.status==='error');
 assert.equal(store.project(p.id).tasks.length,0);assert.equal(r.pendingPlan.turnId,'completed-before-pause');
 store.runProject(p.id);c.activate(p.id);await until(()=>r.phase==='consulting');assert.equal(calls,1);assert.equal(store.project(p.id).tasks.length,2);assert.equal(r.pendingPlan,undefined);assert.equal(r.applyingTurnId,undefined);c.stop();
});

test('runtime generation changes resume known threads before another planning turn',async()=>{
 const {store,p}=fixture(),runtime=new EventEmitter();let resumed=0;runtime.generation=1;runtime.start=async()=>{};runtime.close=()=>{};runtime.createThread=async()=> 'official-thread';runtime.resumeThread=async()=>{resumed++;};runtime.run=async()=>({data:opening(),turnId:'turn1'});
 const c=new Council(store,runtime),r=c.enqueue(p.id,store.postUser(p.id,'制作游戏'));await until(()=>!c.busy&&r.phase==='consulting');
 store.pauseProject(p.id);runtime.generation=2;r.status='queued';r.phase='consolidating';runtime.run=async()=>({data:plan({questions:['是否支持触屏？']}),turnId:'turn2'});store.runProject(p.id);await until(()=>r.status==='waiting_user');assert.equal(resumed,1);c.stop();
});

test('unknown planner outcomes cannot be restarted by run or a continuation message',()=>{
 const {store,p}=fixture(),c=new Council(store,null),r=c.enqueue(p.id,store.postUser(p.id,'做个游戏'));r.status='error';r.outcomeUncertain=true;r.error='连接中断，结果未确认';
 assert.throws(()=>c.activate(p.id),{code:'coordinator_outcome_uncertain'});c.enqueue(p.id,store.postUser(p.id,'继续'),{mode:'continue'});assert.equal(r.status,'error');assert.equal(c.ready(store.project(p.id),r),false);assert.equal(store.project(p.id).tasks.length,0);c.stop();
});
