import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createDock } from '../src/server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'artifacts', 'pipeline-verification');
const dock = createDock({ directory }); let launched;
try {
  await new Promise(resolve => dock.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${dock.server.address().port}`;
  const rpc = async (name, args = {}) => {
    const response = await fetch(`${base}/api/tools/call`, { method: 'POST', headers: { Authorization: `Bearer ${dock.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  };
  const p = dock.store.createProject({ title: '本地派发链路验证', goal: '验证界面填写、发送、读取新回执和本地成果登记；验证窗口不是 AI 客户端。' });
  const desktop = await dock.native.call('create_desktop'); dock.store.updateProject(p.id, { desktop: desktop.name });
  launched = await dock.native.call('launch', { desktop: desktop.name, executable: path.join(root, 'native/bin/AgentDock.Probe.exe'), arguments: `"${path.join(p.workspace, 'receipt.txt')}"`, cwd: p.workspace });
  let window;
  for (let i = 0; i < 15; i++) { const result = await dock.native.call('windows', { desktop: desktop.name }); window = result.windows.find(w => w.pid === launched.pid); if (window) break; await new Promise(r => setTimeout(r, 200)); }
  assert.ok(window);
  const member = dock.store.saveMember({ name: 'UI 验证窗口（非 AI）', provider: 'AgentDock.Probe', role: '后台操作回执', window }); dock.store.runProject(p.id);
  const t = await rpc('dock_create_task', { projectId: p.id, title: '执行后台输入并交付文件', description: '在隔离桌面接收完整任务提示词，写出一个真实回执文件', acceptance: '回执文件实际存在，内容包含任务 ID，群聊原文来自真实窗口观察', assignee: member.id, output: 'receipt.txt' });
  const o = await rpc('dock_observe', { projectId: p.id, memberId: member.id });
  const input = o.elements.find(e => e.canSetValue && e.automationId === 'taskPrompt'); const send = o.elements.find(e => e.canInvoke && e.automationId === 'executeTask'); assert.ok(input && send);
  const dispatched = await rpc('dock_dispatch', { projectId: p.id, taskId: t.id, observationId: o.observationId, inputIndex: input.index, sendIndex: send.index });
  assert.ok(fs.existsSync(path.join(p.workspace, 'receipt.txt')));
  const receipt = fs.readFileSync(path.join(p.workspace, 'receipt.txt'), 'utf8'); assert.match(receipt, new RegExp(t.id));
  const observed = dispatched.observation; assert.ok(observed.text.includes(receipt));
  const reply = await rpc('dock_import_reply', { projectId: p.id, memberId: member.id, taskId: t.id, observationId: observed.observationId, text: receipt });
  assert.equal(reply.provenance.type, 'official-ui');
  const artifact = await rpc('dock_register_file', { projectId: p.id, relative: 'receipt.txt', author: member.id, description: '由真实本地窗口写出的回执，验证界面与文件交接' });
  await rpc('dock_update_task', { projectId: p.id, taskId: t.id, status: 'done', evidence: [{ type: 'file', artifactId: artifact.id, detail: '已检查文件存在、任务 ID 和实际窗口原文' }] });
  await rpc('dock_complete', { projectId: p.id, summary: '本地界面派发与交接链路验证通过。这次使用的是自有验证窗口，不代表 TRAE 或豆包已通过真实协作验收。' });
  if (observed.screenshot.available) fs.writeFileSync(path.join(directory, 'pipeline-window.png'), Buffer.from(observed.screenshot.data, 'base64'));
  const result = { passed: true, at: new Date().toISOString(), projectId: p.id, checks: ['local HTTP tool calls', 'isolated desktop launch', 'task prompt filled into actual input', 'actual send control invoked', 'new observed reply imported', 'local artifact hashed and registered', 'evidence-gated completion'], limitations: ['ProbeWindow is a test application, not an AI. Real TRAE/Doubao orchestration is still unverified.'], artifact };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) { fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, at: new Date().toISOString(), error: error.message }, null, 2)); throw error; }
finally { if (launched) await dock.native.call('close_owned', { pid: launched.pid }).catch(() => {}); await dock.close(); }
