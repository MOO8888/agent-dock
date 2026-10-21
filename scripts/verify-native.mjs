import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeBridge } from '../src/native.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'native-verification'); fs.mkdirSync(output, { recursive: true });
const native = new NativeBridge(); let launched;
try {
  const before = await native.call('metrics');
  const desktop = await native.call('create_desktop');
  const receipt = path.join(output, 'local-receipt.txt');
  launched = await native.call('launch', { desktop: desktop.name, executable: path.join(root, 'native/bin/AgentDock.Probe.exe'), arguments: `"${receipt}"`, cwd: root });
  let windows;
  for (let i = 0; i < 15; i++) { windows = await native.call('windows', { desktop: desktop.name }); if (windows.windows.some(w => w.pid === launched.pid)) break; await new Promise(r => setTimeout(r, 200)); }
  const window = windows.windows.find(w => w.pid === launched.pid); assert.ok(window, 'verification window exists on isolated desktop');
  const member = { id: 'probe', window }; let o = await native.observe(member, desktop.name);
  fs.writeFileSync(path.join(output, 'observed-controls.json'), JSON.stringify({ ...o, screenshot: { ...o.screenshot, data: undefined } }, null, 2));
  const input = o.elements.find(e => ['Edit', 'Document'].includes(e.type) && e.canSetValue); assert.ok(input, 'editable background input exists');
  const written = await native.act(member, { observationId: o.observationId, action: 'set_value', elementIndex: input.index, value: 'AgentDock local desktop verified' }); o = written.observation;
  const button = o.elements.find(e => e.canInvoke && e.name === '执行任务'); assert.ok(button, 'invokable UIA button exists');
  const clicked = await native.act(member, { observationId: o.observationId, action: 'invoke', elementIndex: button.index }, { screenshot:true });
  assert.ok(fs.existsSync(receipt), 'actual local file exists'); assert.match(fs.readFileSync(receipt, 'utf8'), /AgentDock local desktop verified/);
  const after = await native.call('metrics');
  // The human may move their cursor or switch apps while the probe works. Record
  // deltas without treating human input as evidence that this component injected it.
  const stableForeground = before.available && after.available && before.foreground === after.foreground;
  const stableCursor = before.available && after.available && before.cursorX === after.cursorX && before.cursorY === after.cursorY;
  assert.equal(clicked.observation.screenshot.available, true, 'real screenshot captured on non-input desktop');
  fs.writeFileSync(path.join(output, 'isolated-desktop.png'), Buffer.from(clicked.observation.screenshot.data, 'base64'));
  const result = { passed: true, at: new Date().toISOString(), desktop: desktop.name, checks: ['isolated local desktop', 'real window launch', 'background control text entry', 'background UIA button invocation', 'actual local artifact', 'real background screenshot', ...(stableForeground ? ['foreground unchanged during this probe'] : []), ...(stableCursor ? ['cursor unchanged during this probe'] : [])], limitations: ['Third-party AI clients are not yet verified by this test.', 'No physical input injection fallback; unsupported controls require manual takeover.', ...(!before.available || !after.available ? ['Main input desktop telemetry was unavailable in this process; no claim of measured foreground/cursor isolation.'] : []), ...(!stableCursor && before.available ? ['Cursor position changed during the probe; concurrent human input cannot be distinguished by snapshots.'] : [])], before, after };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (e) {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, at: new Date().toISOString(), error: e.message }, null, 2)); throw e;
} finally { if (launched) await native.call('close_owned', { pid: launched.pid }).catch(() => {}); native.stop(); }
