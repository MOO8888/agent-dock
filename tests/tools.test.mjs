import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { executeTool } from '../src/tools.mjs';

const setup = () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-tools-')));
  const p = store.createProject({ title: '交接验证', goal: '写一个小游戏' });
  store.runProject(p.id); store.saveMember({ id: 'trae', window: { id: 123, pid: 456 } });
  const t = store.createTask(p.id, { title: '游戏', assignee: 'trae', description: '平台跳跃', acceptance: '可以重开' });
  return { store, p, t };
};
const send = index => ({ index, type: 'Button', name: '发送', automationId: 'send', className: 'Button', canInvoke: true });
const input = { index: 1, type: 'Edit', name: '输入', canSetValue: true };
test('two-stage preparation fills once without sending, survives restart, and sends the verified draft once', async () => {
  const {store,p,t}=setup(),calls=[];let draft='';
  const native={
    checked:()=>({observationId:'fresh',text:'new empty conversation',elements:[{}, {...input,type:'Group',value:draft},...(draft?[send(2)]:[])]}),
    async act(member,args){calls.push(args);if(args.action==='set_value')draft=args.value;return {result:{},observation:{observationId:'typed',elements:[{}, {...input,type:'Group',value:draft},send(2)]}};}
  };
  await executeTool('dock_prepare_dispatch',{projectId:p.id,taskId:t.id,observationId:'fresh',inputIndex:1},store,native);
  assert.deepEqual(calls.map(c=>c.action),['set_value']);assert.equal(store.task(p.id,t.id)[1].dispatch.status,'prepared');
  const restored=new Store(store.directory);
  restored.runProject(p.id);
  await assert.rejects(executeTool('dock_prepare_dispatch',{projectId:p.id,taskId:t.id,observationId:'fresh',inputIndex:1},restored,native),{code:'input_not_empty'});
  assert.throws(()=>restored.prepareDispatch(p.id,t.id),{code:'duplicate_dispatch'});
  await executeTool('dock_dispatch',{projectId:p.id,taskId:t.id,observationId:'fresh',inputIndex:1,sendIndex:2},restored,native);
  assert.deepEqual(calls.map(c=>c.action),['set_value','invoke']);assert.equal(restored.task(p.id,t.id)[1].attempts,1);
  await assert.rejects(executeTool('dock_dispatch',{projectId:p.id,taskId:t.id,observationId:'fresh',inputIndex:1,sendIndex:2},restored,native),{code:'duplicate_dispatch'});
});

test('prepared dispatch refuses changed drafts, partial observations and a paused project',async()=>{
  const {store,p,t}=setup();store.prepareDispatch(p.id,t.id);const current=store.task(p.id,t.id)[1];current.dispatch.status='prepared';current.dispatch.phase='prepared';store.save();
  let partial=false,draft='changed';const native={checked:()=>({partial,elements:[{}, {...input,value:draft},send(2)]}),async act(){throw new Error('must not send');}};
  const args={projectId:p.id,taskId:t.id,observationId:'fresh',inputIndex:1,sendIndex:2};
  await assert.rejects(executeTool('dock_dispatch',args,store,native),{code:'dispatch_draft_mismatch'});
  draft=current.dispatch.prompt;partial=true;await assert.rejects(executeTool('dock_dispatch',args,store,native),{code:'dispatch_draft_mismatch'});
  partial=false;store.pauseProject(p.id);await assert.rejects(executeTool('dock_dispatch',args,store,native),{code:'project_paused'});
});
test('dispatch reidentifies a moved send control rather than using its stale index', async () => {
  const { store, p, t } = setup(), calls = [];
  const native = {
    checked: () => ({ elements: [{}, input, send(2)] }),
    async act(member, args) { calls.push(args); return args.action === 'set_value' ? { result: {}, observation: { observationId: 'new', elements: [{}, input, {}, {}, send(4)] } } : { result: { foregroundChanged: false }, observation: {} }; }
  };
  await executeTool('dock_dispatch', { projectId: p.id, taskId: t.id, observationId: 'old', inputIndex: 1, sendIndex: 2 }, store, native);
  assert.equal(calls[1].elementIndex, 4); assert.match(calls[0].value, /平台跳跃/); assert.equal(store.task(p.id, t.id)[1].dispatch.status, 'sent');
});

test('preview equals the dispatched single-line payload and preserves multiline code requirements', async () => {
  const { store, p, t } = setup();
  const description = '保持这段代码的缩进：\nfunction demo() {\n  return "a\\nb";\n}\n中文与 emoji 🌱';
  store.updateTask(p.id,t.id,{description});
  const preview = await executeTool('dock_dispatch_prompt',{projectId:p.id,taskId:t.id},store,{});
  const dispatch = store.prepareDispatch(p.id,t.id);
  assert.equal(preview.prompt,dispatch.prompt); assert.ok(!/[\r\n\t]/.test(dispatch.prompt));
  const start=dispatch.prompt.indexOf('{'), end=dispatch.prompt.lastIndexOf('}');
  const payload=JSON.parse(dispatch.prompt.slice(start,end+1));
  assert.equal(payload.要求,description); assert.equal(payload.本地工作目录,p.workspace);
});

test('rework dispatch includes the latest correction instead of repeating only the original task', async () => {
  const {store,p,t}=setup();
  store.prepareDispatch(p.id,t.id); store.dispatchOutcome(p.id,t.id,'sent');
  store.rework(p.id,t.id,'第二个平台高于最大跳高，请降低平台并验证收集物可达');
  const preview=await executeTool('dock_dispatch_prompt',{projectId:p.id,taskId:t.id},store,{});
  const dispatch=store.prepareDispatch(p.id,t.id);
  assert.equal(preview.prompt,dispatch.prompt); assert.match(dispatch.prompt,/第二个平台高于最大跳高/);
  assert.match(dispatch.prompt,/平台跳跃/); assert.equal(dispatch.task.attempts,2);
});
test('ambiguous send control stops before transmission and preserves uncertain state', async () => {
  const { store, p, t } = setup(), calls = [];
  const native = { checked: () => ({ elements: [{}, input, send(2)] }), async act(member, args) { calls.push(args); return { result: {}, observation: { observationId: 'new', elements: [{}, input, send(2), send(3)] } }; } };
  await assert.rejects(executeTool('dock_dispatch', { projectId: p.id, taskId: t.id, observationId: 'old', inputIndex: 1, sendIndex: 2 }, store, native), { code: 'send_control_changed' });
  assert.equal(calls.length, 1); assert.equal(store.task(p.id, t.id)[1].dispatch.status, 'unknown');
});

test('delayed filling resumes only an exact draft and never retries an uncertain send', async () => {
  for(const phase of ['filling','invoking']) {
    const {store,p,t}=setup(),calls=[];
    const native={
      checked:()=>({observationId:'observed',elements:[{}, {...input,value:store.task(p.id,t.id)[1].dispatch?.prompt||''},send(2)]}),
      async act(member,args) {
        calls.push(args);
        if((args.action==='set_value'&&phase==='filling')||(args.action==='invoke'&&phase==='invoking'))throw new Error('simulated response delay');
        return {result:{},observation:{observationId:'typed',elements:[{},input,send(2)]}};
      }
    };
    await assert.rejects(executeTool('dock_dispatch',{projectId:p.id,taskId:t.id,observationId:'observed',inputIndex:1,sendIndex:2},store,native));
    const current=store.task(p.id,t.id)[1];
    assert.equal(current.dispatch.phase,phase);
    const retry=executeTool('dock_dispatch',{projectId:p.id,taskId:t.id,observationId:'observed',inputIndex:1,sendIndex:2},store,native);
    if(phase==='filling'){await retry;assert.equal(calls.length,2);assert.equal(calls[1].action,'invoke');assert.equal(current.attempts,1);assert.equal(current.dispatch.status,'sent');}
    else {await assert.rejects(retry,{code:'duplicate_dispatch'});assert.equal(calls.length,2);}
  }
  const {store,p,t}=setup();store.prepareDispatch(p.id,t.id);store.dispatchOutcome(p.id,t.id,'unknown');
  const native={checked:()=>({elements:[{}, {...input,value:'different draft'},send(2)]}),async act(){throw new Error('must not act');}};
  await assert.rejects(executeTool('dock_dispatch',{projectId:p.id,taskId:t.id,observationId:'fresh',inputIndex:1,sendIndex:2},store,native),{code:'dispatch_draft_mismatch'});
});

test('dispatch accepts a send button becoming enabled but never invokes a still disabled one', async () => {
  for (const enabled of [true, false]) {
    const { store, p, t } = setup(), calls = [];
    const button = { ...send(2), name: '', automationId: '', className: 'chat-input-v2-send-button disabled', enabled: false };
    const native = {
      checked: () => ({ elements: [{}, input, button] }),
      async act(member, args) {
        calls.push(args);
        return args.action === 'set_value'
          ? { result: {}, observation: { observationId: 'typed', elements: [{}, input, { ...button, index: 3, className: enabled ? 'chat-input-v2-send-button' : button.className, enabled }] } }
          : { result: {}, observation: {} };
      }
    };
    const operation = executeTool('dock_dispatch', { projectId: p.id, taskId: t.id, observationId: 'old', inputIndex: 1, sendIndex: 2 }, store, native);
    if (enabled) { await operation; assert.equal(calls[1].elementIndex, 3); assert.equal(store.task(p.id, t.id)[1].dispatch.status, 'sent'); }
    else { await assert.rejects(operation, { code: 'send_control_changed' }); assert.equal(calls.length, 1); }
  }
});
test('user pause during filling prevents the pending send', async () => {
  const { store, p, t } = setup(), calls = [];
  const native = { checked: () => ({ elements: [{}, input, send(2)] }), async act(member, args) { calls.push(args); store.pauseProject(p.id); return { result: {}, observation: { observationId: 'new', elements: [{}, input, send(2)] } }; } };
  await assert.rejects(executeTool('dock_dispatch', { projectId: p.id, taskId: t.id, observationId: 'old', inputIndex: 1, sendIndex: 2 }, store, native), { code: 'project_paused' });
  assert.equal(calls.length, 1);
});
test('reply import refuses text absent from the actual selected observation', async () => {
  const { store, p } = setup();
  const native = { checked: () => ({ text: '实际检查结果：跳跃可用', observationId: 'real', window: { title: '验证会话', executable: 'official.exe' }, createdAt: new Date().toISOString() }) };
  await assert.rejects(executeTool('dock_import_reply', { projectId: p.id, memberId: 'trae', observationId: 'real', text: '全部功能已完成' }, store, native), { code: 'reply_not_observed' });
  const m = await executeTool('dock_import_reply', { projectId: p.id, memberId: 'trae', observationId: 'real', text: '跳跃可用' }, store, native);
  assert.equal(m.provenance.rawText, '跳跃可用'); assert.equal(m.provenance.type, 'official-ui');
});
test('dispatch preserves a pre-existing draft in the official input', async () => {
  const { store, p, t } = setup(); let called = false;
  const native = { checked: () => ({ elements: [{}, { ...input, value: '用户未发送的草稿' }, send(2)] }), async act() { called = true; } };
  await assert.rejects(executeTool('dock_dispatch', { projectId: p.id, taskId: t.id, observationId: 'old', inputIndex: 1, sendIndex: 2 }, store, native), { code: 'input_not_empty' });
  assert.equal(called, false); assert.equal(store.task(p.id, t.id)[1].dispatch, null);
});
test('old thread text cannot be imported as a new task response', async () => {
  const { store, p, t } = setup();
  store.prepareDispatch(p.id, t.id, '上次任务的完成结果'); store.dispatchOutcome(p.id, t.id, 'sent');
  const native = { checked: () => ({ text: '上次任务的完成结果\n这次任务的实际结果', observationId: 'real', window: { title: '验证会话' } }) };
  await assert.rejects(executeTool('dock_import_reply', { projectId: p.id, taskId: t.id, memberId: 'trae', observationId: 'real', text: '上次任务的完成结果' }, store, native), { code: 'reply_not_new' });
});
