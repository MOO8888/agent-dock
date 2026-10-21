import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDock } from '../src/server.mjs';

test('real stdio MCP process negotiates, lists and calls local tools', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-mcp-'));
  const dock = createDock({ directory, native: { stop() {} } });
  await new Promise(resolve => dock.server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ port: dock.server.address().port }));
  const p = dock.store.createProject({ title: '协议检查', goal: '验证本地工具连接' }); dock.store.runProject(p.id);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, [path.join(root, 'src/mcp.mjs')], { cwd: root, env: { ...process.env, AGENT_DOCK_DATA: directory }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.stdin.end(); child.kill(); await dock.close(); });
  const pending = new Map(); let sequence = 0, buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) { const i = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); const item = pending.get(message.id); if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message); } }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 8000); pending.set(id, { resolve, timer }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const probe = await rpc('server/discover', {}); assert.equal(probe.error.code, -32601);
  const initialization = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'independent-test-client', version: '1.0' } });
  assert.equal(initialization.result.protocolVersion, '2025-11-25');
  const listed = await rpc('tools/list', {}); assert.ok(listed.result.tools.some(tool => tool.name === 'dock_dispatch'));
  const connection = await rpc('tools/call', { name: 'dock_connect', arguments: { host: 'MCP test client' } });
  assert.equal(connection.result.isError, false);
  const state = await rpc('tools/call', { name: 'dock_state', arguments: {} }); const snapshot = JSON.parse(state.result.content[0].text);
  assert.equal(snapshot.projects[0].goal, '验证本地工具连接');
  const result = await rpc('tools/call', { name: 'dock_message', arguments: { projectId: p.id, text: '本地连接实际调用成功' } });
  assert.equal(result.result.isError, false); assert.ok(dock.store.project(p.id).messages.some(m => m.text === '本地连接实际调用成功'));
});
