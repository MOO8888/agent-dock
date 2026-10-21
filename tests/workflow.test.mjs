import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {AutomaticExecution} from '../src/automatic.mjs';
import {quotaState,groupTasks,workflowStage} from '../web/workflow.js';
const create=()=>new Store(fs.mkdtempSync(path.join(os.tmpdir(),'dock-workflow-')));
test('even autonomous single-member projects never turn user text into a worker task',async()=>{
 const store=create(),p=store.createProject({title:'目标',goal:'编写游戏',team:[{memberId:'codex'},{memberId:'doubao_work'}]});
 let actions=0;const auto=new AutomaticExecution(store,{observe(){actions++;throw Error('must not touch worker');}},{timer:false});store.off('change',auto.schedule);
 store.postUser(p.id,'写个马里奥');await auto.tick();assert.equal(store.project(p.id).tasks.length,0);assert.equal(actions,0);assert.equal(store.inbox(p.id).length,1);assert.equal(store.project(p.id).execution.phase,'coordinator');auto.stop();
});
test('quota validates before mutation, remains labelled manual, and expires after reset',()=>{
 const store=create();assert.throws(()=>store.saveMember({id:'codex',name:'should not save',quota:{remaining:12,total:10}}));assert.equal(store.member('codex').name,'Codex');
 const reset=Date.now()+60000;store.saveMember({id:'codex',quota:{remaining:25,total:100,unit:'次',resetAt:new Date(reset).toISOString()}});
 const member=store.member('codex');assert.equal(member.quota.source,'manual');assert.equal(quotaState(member).percent,25);assert.equal(quotaState(member,reset+1).known,false);
 store.saveMember({id:'codex',quota:null});assert.equal(quotaState(store.member('codex')).percent,null);
});
test('workflow keeps completed work in history and groups explicit stages with legacy compatibility',()=>{
 const p={status:'completed',tasks:[{status:'done',title:'旧任务'},{stage:'review',status:'done'},{stage:'planning',status:'cancelled'}],inbox:[]};
 assert.equal(workflowStage(p),'delivery');const groups=groupTasks(p);assert.equal(groups.find(g=>g.id==='execution').tasks.length,1);assert.equal(groups.find(g=>g.id==='review').tasks.length,1);assert.equal(groups.find(g=>g.id==='planning').tasks.length,0);
 p.status='running';p.inbox=[{type:'user.message',acknowledged:false}];assert.equal(workflowStage(p),'planning');
});
test('automatic transport requires concrete output and retains coordinator-written requirements',()=>{
 const store=create(),p=store.createProject({title:'A',goal:'B'});
 const args={title:'实现',description:'按规划实现，不转发用户原话',assignee:'doubao_work',acceptance:'可观察的验收条件',dispatchMode:'automatic'};
 assert.throws(()=>store.createTask(p.id,args));assert.equal(store.project(p.id).tasks.length,0);
 const t=store.createTask(p.id,{...args,output:'deliveries/unique/result.txt',stage:'execution'});assert.equal(t.coordination.source,'codex');assert.equal(t.description,args.description);
});
