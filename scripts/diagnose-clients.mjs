import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeBridge } from '../src/native.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = new NativeBridge(), summary = [];
try {
  const { windows } = await native.call('windows', { desktop: 'default' });
  const candidates = windows.filter(w => /trae|doubao/i.test(w.executable || '') || / - 豆包$/.test(w.title));
  for (const window of candidates) {
    const provider = /trae/i.test(window.executable || '') ? 'TRAE' : '豆包';
    try {
      // This is a read-only compatibility check: no screenshot, no text storage,
      // no input, no click, and no task sent to an existing user conversation.
      const o = await native.observe({ id: 'diagnostic', window }, 'default', { screenshot: false });
      const values = o.elements.filter(e => e.canSetValue && !e.password);
      const sends = o.elements.filter(e => e.canInvoke && /^(发送|发送消息|Send|Send message|提交|提交任务)$/.test(e.name));
      summary.push({ provider, process: path.basename(window.executable || ''), windowId: window.id, controlCount: o.elements.length, writableControls: values.length, candidateSendControls: sends.length, status: values.length && sends.length ? 'needs-write-and-send-verification' : 'background-adapter-needed', note: '仅验证控件识别。未记录会话文字，未请求截图，未向客户端发送任务。窗口可能最小化或不在目标任务模式。' });
    } catch (error) { summary.push({ provider, status: 'observe-failed', error: error.message }); }
  }
  const result = { at: new Date().toISOString(), mode: 'read-only', clients: summary, limitations: ['No real write/send or model inference was tested.', 'A generic control count does not prove that a task composer is writable.'] };
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true }); fs.writeFileSync(path.join(root, 'artifacts/client-diagnostics.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { native.stop(); }
