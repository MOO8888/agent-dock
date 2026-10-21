import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/store.mjs';import {ClientPreferences,checkInference} from '../src/preferences.mjs';
function fixture(){
 const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),'dock-models-')));store.saveMember({id:'doubao_work',window:{id:1,pid:2},connection:{autoBind:true,desktop:'AgentDock_Model',executable:'C:\\Official\\Client.exe'}});const p=store.createProject({title:'A',goal:'B'});
 let phase='closed',model='自动',effort='高',seq=0;const calls=[];
 const snapshot=()=>({observationId:String(++seq),partial:false,elements:phase==='closed'?[{index:0,type:'Button',name:`${model} ${effort}`,canInvoke:true}]:[{index:0,type:'Menu',name:`${model} ${effort}`},{index:1,type:'MenuItem',name:'自动',canInvoke:true},{index:2,type:'MenuItem',name:'豆包 2.1 Pro',canInvoke:true},{index:3,type:'MenuItem',name:`推理强度 ${effort}`,canExpand:true},...(phase==='expanded'?[{index:4,type:'MenuItem',name:'低',canInvoke:true},{index:5,type:'MenuItem',name:'高',canInvoke:true}]:[])]});
 const native={async observe(){return snapshot();},async act(m,input){calls.push(input);if(input.action==='expand')phase='expanded';else if(input.action==='collapse')phase='menu';else if(phase==='closed')phase='menu';else{if(input.elementIndex===1)model='自动';if(input.elementIndex===2)model='豆包 2.1 Pro';if(input.elementIndex===4)effort='低';if(input.elementIndex===5)effort='高';phase='closed';}return {observation:snapshot()};}};
 return {store,p,calls,native,prefs:new ClientPreferences(store,native)};
}
test('models and effort are discovered from GUI and confirmed after selection, not merely saved in preferences',async()=>{
 const f=fixture();const catalog=await f.prefs.run(f.p.id,'doubao_work');assert.deepEqual(catalog.models,['自动','豆包 2.1 Pro']);assert.deepEqual(catalog.efforts,['低','高']);
 f.store.saveMember({id:'doubao_work',inference:{model:'豆包 2.1 Pro',effort:'低'}});assert.equal(f.store.member('doubao_work').inferenceApplied,undefined);
 const applied=await f.prefs.run(f.p.id,'doubao_work',{model:'豆包 2.1 Pro',effort:'低'});assert.equal(applied.actual,'豆包 2.1 Pro 低');assert.equal(f.store.member('doubao_work').configurationBusy,undefined);
 assert.throws(()=>checkInference(f.store.member('doubao_work'),{inference:{model:'豆包 2.1 Pro',effort:'低'}},{elements:[{type:'Button',name:'自动 高'}]}),{code:'inference_unconfirmed'});
});
test('running tasks, takeover, unknown options and host settings cannot silently claim successful application',async()=>{
 const f=fixture();await assert.rejects(f.prefs.run(f.p.id,'codex',{model:'unknown'}),{code:'host_model_control_required'});assert.equal(f.calls.length,0);
 await assert.rejects(f.prefs.run(f.p.id,'doubao_work',{model:'不存在的模型'}),{code:'model_not_available'});assert.equal(f.store.member('doubao_work').inferenceApplied,undefined);
 const task=f.store.createTask(f.p.id,{title:'任务',description:'要求',acceptance:'验收',assignee:'doubao_work'});f.store.project(f.p.id).status='running';f.store.updateTask(f.p.id,task.id,{status:'running'});
 const before=f.calls.length;await assert.rejects(f.prefs.run(f.p.id,'doubao_work'),{code:'member_busy'});assert.equal(f.calls.length,before);
 f.store.project(f.p.id).takeover={active:true};await assert.rejects(f.prefs.run(f.p.id,'doubao_work'),{code:'human_takeover_active'});
});
