import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DockError } from './store.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class NativeBridge {
  constructor({ spawnProcess = spawn, requestTimeout = 18000 } = {}) { this.child = null; this.pending = new Map(); this.observations = new Map(); this.tail = Promise.resolve(); this.spawnProcess = spawnProcess; this.requestTimeout = requestTimeout; }
  retire(child, reason) {
    if (this.child === child) { this.child = null; this.observations.clear(); }
    for (const [id, pending] of this.pending) if (pending.child === child) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(reason); }
    // Only our bridge process is stopped. Official clients are never terminated.
    try { child.kill(); } catch { }
  }
  start() {
    if (this.child) return;
    const executable = path.join(root, 'native', 'bin', 'AgentDock.Native.exe');
    if (this.spawnProcess === spawn && (process.platform !== 'win32' || !fs.existsSync(executable))) throw new DockError('Windows 操作组件尚未编译，请运行构建脚本', 'native_unavailable', 503);
    const child = this.spawnProcess(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: root });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 20000000) return this.retire(child, new DockError('操作组件返回过大的数据，已停止并等待重新观察', 'native_protocol_error', 503));
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n'), line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let result;
        try { result = JSON.parse(line); if (!result || typeof result.id !== 'string' || (!('result' in result) && !result.error)) throw new Error('invalid response'); }
        catch { return this.retire(child, new DockError('操作组件返回的数据格式无效，已停止；请重新观察核实操作结果', 'native_protocol_error', 503)); }
        const pending = this.pending.get(result.id);
        if (pending?.child === child) { clearTimeout(pending.timer); this.pending.delete(result.id); result.error ? pending.reject(new DockError(result.error.message, result.error.code || 'native_error', 409)) : pending.resolve(result.result); }
      }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', () => this.retire(child, new DockError('操作组件无法启动，请重新构建', 'native_unavailable', 503)));
    child.on('exit', () => {
      if (this.child === child) { this.child = null; this.observations.clear(); }
      for (const [id, pending] of this.pending) if (pending.child === child) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new DockError('操作组件已退出，结果需要重新核实', 'native_exited', 503)); }
    });
  }
  call(action, args = {}) {
    const execute = () => new Promise((resolve, reject) => {
      try {
        this.start(); const requestId = randomUUID(), child = this.child;
        const timer = setTimeout(() => this.retire(child, new DockError('操作超时，结果不确定；操作组件已停止，请重新观察窗口', 'native_timeout', 504)), this.requestTimeout);
        this.pending.set(requestId, { resolve, reject, timer, child });
        try { child.stdin.write(`${JSON.stringify({ id: requestId, action, args })}\n`, error => { if (error) this.retire(child, new DockError('操作组件连接已中断，结果需要重新核实', 'native_send_failed', 503)); }); }
        catch { this.retire(child, new DockError('操作组件连接已中断，结果需要重新核实', 'native_send_failed', 503)); }
      } catch (e) { reject(e); }
    });
    // All mutating desktop commands share one lane; no competing input streams.
    const result = this.tail.then(execute, execute); this.tail = result.catch(() => {}); return result;
  }
  async observe(member, desktop = 'default', { screenshot = true } = {}) {
    if (!member.window) throw new DockError('成员尚未绑定窗口', 'window_unbound', 409);
    const result = await this.call('observe', { window: member.window.id, expectedPid: member.window.pid, desktop, includeScreenshot: screenshot });
    const observation = { ...result, memberId: member.id, observationId: randomUUID(), createdAt: new Date().toISOString(), desktop };
    this.observations.set(observation.observationId, observation);
    while (this.observations.size > 30) this.observations.delete(this.observations.keys().next().value);
    return observation;
  }
  checked(member, observationId) {
    const o = this.observations.get(observationId);
    if (!o || o.memberId !== member.id || Date.now() - Date.parse(o.createdAt) > 90000 || o.window.id !== member.window?.id) throw new DockError('观察已过期或窗口不匹配，请重新观察', 'stale_observation', 409);
    return o;
  }
  async act(member, input, { screenshot = false, readbackTimeoutMs = 6000 } = {}) {
    const o = this.checked(member, input.observationId);
    const result = await this.call(input.action, { ...input, readbackTimeoutMs, window: o.window.id, expectedPid: o.window.pid, desktop: o.desktop, token: o.token });
    this.observations.delete(input.observationId);
    return { result, observation: await this.observe(member, o.desktop, { screenshot }) };
  }
  stop() { if (this.child) this.retire(this.child, new DockError('操作组件已停止', 'native_stopped', 503)); this.observations.clear(); }
}
