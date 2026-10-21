import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, '.data'); const run = JSON.parse(fs.readFileSync(path.join(data, 'run.json')));
const token = fs.readFileSync(path.join(data, 'bridge-token'), 'utf8').trim();
const base = `http://127.0.0.1:${run.port}`;
async function api(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }
const call = (name, args) => api('/api/tools/call', 'POST', { name, arguments: args });
async function main() {
const files = fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`);
const checks = spawnSync(process.execPath, ['--test', '--test-reporter=junit', ...files], { cwd: root, windowsHide: true, encoding: 'utf8' });
if (checks.status !== 0) throw new Error(checks.stderr || checks.stdout);
const native = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/native-verification/result.json')));
const pipeline = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/pipeline-verification/result.json')));
if (!native.passed || !pipeline.passed) throw new Error('原生或派发链路验证尚未通过');
const state = await api('/api/state');
const existing = state.projects.find(p => p.title === 'Windows 工作台验证');
if (existing) {
  await call('dock_write_file', { projectId: existing.id, relative: 'verification/automated-checks.xml', content: checks.stdout });
  const count = (checks.stdout.match(/<testcase /g) || []).length;
  await call('dock_message', { projectId: existing.id, text: `自动检查复查通过，共 ${count} 项。新增检查覆盖不覆盖成员草稿、拒绝把旧会话文字当成本次回复，以及返工后需要新的验收证据。` });
  console.log(JSON.stringify({ refreshed: true, projectId: existing.id, tests: count }));
  return;
}
for (const p of state.projects.filter(p => p.status === 'running')) await api(`/api/projects/${p.id}/pause`, 'POST', {});
const p = await api('/api/projects', 'POST', { title: 'Windows 工作台验证', goal: '验证本地工作台、统筹工具、独立操作桌面及文件交接。真实 TRAE / 豆包协作是后续联调项，验证程序的结果不冒充 AI 成员回复。' });
await api(`/api/projects/${p.id}/run`, 'POST', {});
await call('dock_message', { projectId: p.id, text: '本次开发已做出可以运行的 Windows 本地工作台，并打包、安装了 Codex 统筹 Skill。以下记录是实际检查结果，尚未向 TRAE 或豆包的现有会话派发工作。' });
const junit = await call('dock_write_file', { projectId: p.id, relative: 'verification/automated-checks.xml', content: checks.stdout });
const nativeArtifact = await call('dock_write_file', { projectId: p.id, relative: 'verification/native-desktop.json', content: JSON.stringify(native, null, 2) });
const pipelineArtifact = await call('dock_write_file', { projectId: p.id, relative: 'verification/dispatch-pipeline.json', content: JSON.stringify(pipeline, null, 2) });
for (const image of ['native-verification/isolated-desktop.png', 'pipeline-verification/pipeline-window.png']) {
  const source = path.join(root, 'artifacts', image), relative = `verification/${path.basename(image)}`;
  if (fs.existsSync(source)) { fs.copyFileSync(source, path.join(p.workspace, relative)); await call('dock_register_file', { projectId: p.id, relative, author: 'codex', description: '真实验证窗口截图，非 AI 会话截图' }); }
}
const a = await call('dock_create_task', { projectId: p.id, title: '工作台与统筹工具检查', description: '检查存储恢复、文件边界、任务依赖、返工、备用交接、MCP 协议和暂停时的派发防护。', acceptance: '实际自动检查全部通过，并保留检查报告', output: 'verification/automated-checks.xml', assignee: 'codex' });
await call('dock_update_task', { projectId: p.id, taskId: a.id, status: 'done', evidence: [{ type: 'test', artifactId: junit.id, detail: 'Node 测试进程正常退出，JUnit 报告已落到本地' }] });
const b = await call('dock_create_task', { projectId: p.id, title: '独立桌面与真实文件交接', description: '在本机独立桌面运行验证窗口，实际填写、点击、读取新回执、写出本地文件和获取后台截图。', acceptance: '本地原生验证和完整派发链路验证通过，保留真实截图与结果', output: 'verification/dispatch-pipeline.json', assignee: 'codex' });
await call('dock_update_task', { projectId: p.id, taskId: b.id, status: 'done', evidence: [{ type: 'test', artifactId: nativeArtifact.id, detail: '本次原生验证通过，前台与光标快照保持不变' }, { type: 'test', artifactId: pipelineArtifact.id, detail: '真实窗口派发、读取回执和本地文件登记通过；窗口为非 AI 验证程序' }] });
const c = await call('dock_create_task', { projectId: p.id, title: 'TRAE 与豆包真实会话联调', description: '在为本项目准备的官方会话中验证后台输入、发送、回复边界、实际产物和返工。当前窗口检查曾返回归属错误，未继续操作。', acceptance: '至少一次真实官方客户端派发、成果交接与检验完成，原文可追溯到实际会话', assignee: 'codex', dependsOn: [b.id] });
await call('dock_update_task', { projectId: p.id, taskId: c.id, status: 'waiting', note: '需要重新加载 Codex 本地工具，并明确选择用于此项目的官方会话。第三方客户端的后台兼容性尚未验收。' });
await call('dock_message', { projectId: p.id, text: '已验证：项目与任务管理、本地 MCP 调用、独立桌面、后台填写和点击、真实截图、本地文件交接。\n待联调：TRAE / 豆包的实际后台控件和回复读取。实验桌面内的完整人工键鼠接管尚未实现。\n当前记录不会把测试窗口回执写成真实 AI 的工作成果。' });
await api(`/api/projects/${p.id}/pause`, 'POST', {});
fs.writeFileSync(path.join(root, 'artifacts/workbench-project.json'), JSON.stringify({ projectId: p.id, title: p.title, workspace: p.workspace }, null, 2));
console.log(JSON.stringify({ projectId: p.id, title: p.title, artifacts: 5, status: 'paused-with-one-pending-integration' }));
}
await main();
