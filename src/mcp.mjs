import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { definitions } from './tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.env.AGENT_DOCK_DATA || path.join(root, '.data');
const versions = ['2025-11-25', '2025-06-18', '2024-11-05'];
let initialized = false;
function send(message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
async function callBridge(name, args) {
  if (!fs.existsSync(path.join(directory, 'run.json'))) throw new Error('请先启动 AgentDock 本地工作台');
  const run = JSON.parse(fs.readFileSync(path.join(directory, 'run.json')));
  const token = fs.readFileSync(path.join(directory, 'bridge-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${run.port}/api/tools/call`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(55000) });
  const result = await response.json(); if (!response.ok) throw new Error(`${result.code}: ${result.error}`); return result;
}
function content(value) {
  const image = value?.screenshot?.available ? value.screenshot : value?.observation?.screenshot?.available ? value.observation.screenshot : null;
  const cleaned = structuredClone(value);
  if (cleaned?.screenshot?.data) delete cleaned.screenshot.data;
  if (cleaned?.observation?.screenshot?.data) delete cleaned.observation.screenshot.data;
  const output = [{ type: 'text', text: JSON.stringify(cleaned, null, 2) }];
  if (image) output.push({ type: 'image', mimeType: image.mimeType, data: image.data }); return output;
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
    // Modern clients may probe a legacy stdio server before initialize. An
    // explicit method-not-found allows their documented 2025-era fallback.
    if (request.method === 'server/discover' && 'id' in request) return send({ id: request.id, error: { code: -32601, message: 'Use legacy MCP initialize' } });
    if (request.method === 'notifications/initialized') { initialized = true; return; }
    if (!('id' in request)) return;
    if (request.method === 'initialize') {
      initialized = true;
      return send({ id: request.id, result: { protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'agent-dock', version: '0.1.0' }, instructions: '使用 coordinate-project Skill 协调本地项目。执行者只通过官方界面工作。先 dock_state 发现项目，再 dock_connect。' } });
    }
    if (!initialized) return send({ id: request.id, error: { code: -32002, message: '尚未初始化' } });
    if (request.method === 'ping') return send({ id: request.id, result: {} });
    if (request.method === 'tools/list') return send({ id: request.id, result: { tools: definitions() } });
    if (request.method === 'tools/call') {
      const result = await callBridge(request.params.name, request.params.arguments || {});
      return send({ id: request.id, result: { content: content(result), isError: false } });
    }
    send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    if (request?.id != null) send({ id: request.id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
    else process.stderr.write(`MCP 请求未处理：${e.message}\n`);
  }
});
