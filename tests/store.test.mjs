import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-test-'));
const project = store => store.createProject({ title: '后台游戏', goal: '生成一个可玩的小游戏' });
const task = (store, p, extra = {}) => store.createTask(p.id, { title: '游戏代码', description: '编写本地游戏', acceptance: '能移动和跳跃', assignee: 'trae', output: 'game/index.html', ...extra });

test('only one project runs; restart keeps messages and pauses work', () => {
  const directory = temporary(), store = new Store(directory), a = project(store), b = project(store);
  store.runProject(a.id); store.postUser(a.id, '增加重开按钮');
  assert.throws(() => store.runProject(b.id), { code: 'project_busy' });
  const restored = new Store(directory);
  assert.equal(restored.project(a.id).status, 'paused');
  assert.ok(restored.project(a.id).messages.some(m => m.text === '增加重开按钮'));
  restored.runProject(b.id); assert.equal(restored.project(b.id).status, 'running');
});
test('dependencies, evidence and complete gate prevent premature delivery', () => {
  const store = new Store(temporary()), p = project(store), a = task(store, p), b = task(store, p, { title: '试玩', assignee: 'doubao', dependsOn: [a.id] });
  store.runProject(p.id);
  assert.throws(() => store.updateTask(p.id, b.id, { status: 'running' }), { code: 'dependency_pending' });
  assert.throws(() => store.updateTask(p.id, a.id, { status: 'done' }), { code: 'missing_evidence' });
  assert.throws(() => store.completeProject(p.id, '已交付'), { code: 'unfinished_tasks' });
  assert.throws(() => store.updateTask(p.id, a.id, { status: 'done', evidence: [{ type: 'manual', detail: '仅宣称完成' }] }), { code: 'artifact_missing' });
  store.writeArtifact(p.id, { relative: 'game/index.html', content: '<html>实际产物</html>' });
  store.updateTask(p.id, a.id, { status: 'done', evidence: [{ type: 'manual', detail: '验证窗口输出已读取' }] });
  store.updateTask(p.id, b.id, { status: 'running' });
  store.updateTask(p.id, b.id, { status: 'done', evidence: [{ type: 'manual', detail: '实际试玩完成' }] });
  assert.equal(store.completeProject(p.id, '交付完成').status, 'completed');
});
test('artifact paths reject traversal, absolute paths and symlink escapes', t => {
  const directory = temporary(), store = new Store(directory), p = project(store);
  for (const relative of ['../outside.txt', '..\\outside.txt', 'C:\\outside.txt', '/outside.txt', 'x/../../a']) assert.throws(() => store.writeArtifact(p.id, { relative, content: 'bad' }), { code: 'path_outside_workspace' });
  try { fs.symlinkSync(directory, path.join(p.workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { t.diagnostic(`symlink unavailable: ${e.code}`); return; }
  assert.throws(() => store.writeArtifact(p.id, { relative: 'outside/secret.txt', content: 'bad' }), { code: 'path_outside_workspace' });
});
test('real file registration and sha256 track local versions', () => {
  const store = new Store(temporary()), p = project(store);
  const a = store.writeArtifact(p.id, { relative: 'game/index.html', content: '<html>v1</html>' });
  const b = store.writeArtifact(p.id, { relative: 'game/index.html', content: '<html>v2</html>' });
  assert.notEqual(a.sha256, b.sha256); assert.equal(store.project(p.id).artifacts.length, 1);
  assert.throws(() => store.registerArtifact(p.id, { relative: 'missing.txt' }), { code: 'artifact_missing' });
});
test('uncertain dispatch cannot be sent twice and rework has a limit', () => {
  const store = new Store(temporary()), p = project(store), a = task(store, p);
  store.saveMember({ id: 'trae', window: { id: 123, pid: 1, title: '验证窗口' } }); store.runProject(p.id);
  store.prepareDispatch(p.id, a.id); store.dispatchOutcome(p.id, a.id, 'unknown');
  assert.throws(() => store.prepareDispatch(p.id, a.id), { code: 'duplicate_dispatch' });
  store.updateProject(p.id, { maxReworks: 1 }); assert.equal(store.rework(p.id, a.id, '碰撞不正确').reworks, 1);
  assert.equal(store.rework(p.id, a.id, '仍未修复').status, 'waiting');
});
test('quota fallback reassigns unsent work, preserves uncertain work for handoff', () => {
  const store = new Store(temporary()), p = project(store), a = task(store, p), b = task(store, p, { title: '另一任务' });
  store.saveMember({ id: 'trae', fallback: 'doubao', window: { id: 123 } }); store.runProject(p.id);
  store.prepareDispatch(p.id, b.id); store.dispatchOutcome(p.id, b.id, 'unknown');
  store.memberState('trae', 'quota', '官方客户端提示额度不足');
  assert.equal(store.task(p.id, a.id)[1].assignee, 'doubao');
  assert.equal(store.task(p.id, b.id)[1].status, 'waiting'); assert.equal(store.task(p.id, b.id)[1].assignee, 'trae');
});
test('worker replies require provenance and coordinator summaries stay labelled', () => {
  const store = new Store(temporary()), p = project(store);
  assert.throws(() => store.postWorker(p.id, { memberId: 'trae', text: '已完成' }), { code: 'missing_provenance' });
  const m = store.postCoordinator(p.id, { text: '整理成员意见', summaryOf: '检查任务' }); assert.equal(m.provenance.type, 'coordinator_summary');
});
test('fallback cycles are rejected', () => {
  const store = new Store(temporary()); store.saveMember({ id: 'trae', fallback: 'doubao' });
  assert.throws(() => store.saveMember({ id: 'doubao', fallback: 'trae' }), /循环/);
});
test('invalid changes do not partially mutate state, goal changes reach coordinator inbox', () => {
  const store = new Store(temporary()), p = project(store);
  assert.throws(() => store.updateProject(p.id, { title: '应保留旧名称', maxReworks: -1 }));
  assert.equal(store.project(p.id).title, p.title);
  store.updateProject(p.id, { goal: '改为双人游戏' });
  assert.ok(store.inbox(p.id).some(v => v.type === 'project.goal_changed' && v.text === '改为双人游戏'));
});
test('rework archives old evidence and requires fresh proof', () => {
  const store = new Store(temporary()), p = project(store), t = task(store, p, { output: '' });
  store.updateTask(p.id, t.id, { status: 'done', evidence: [{ type: 'manual', detail: '第一轮检查' }] });
  store.rework(p.id, t.id, '新增要求');
  assert.throws(() => store.updateTask(p.id, t.id, { status: 'done' }), { code: 'missing_evidence' });
  assert.equal(store.task(p.id, t.id)[1].history.length, 1);
});
