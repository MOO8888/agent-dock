import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { NativeBridge } from '../src/native.mjs';

function helper() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.stdin = new Writable({ write(data, encoding, done) { child.request = JSON.parse(data.toString()); done(); } });
  child.kill = () => { child.killed = true; return true; };
  child.reply = result => child.stdout.write(JSON.stringify({ id: child.request.id, result }) + '\n');
  return child;
}
const nextTick = () => new Promise(resolve => setImmediate(resolve));

test('malformed native response fails immediately and retires only the owned helper', async () => {
  const children = [], native = new NativeBridge({ spawnProcess: () => { const child = helper(); children.push(child); return child; } });
  const first = native.call('observe'); await nextTick();
  native.observations.set('old', {});
  children[0].stdout.write('{"id":"broken","result":{"x":Infinity}}\n');
  await assert.rejects(first, { code: 'native_protocol_error' });
  assert.equal(children[0].killed, true); assert.equal(native.observations.size, 0);
  const second = native.call('windows'); await nextTick();
  // An old process exiting late must not destroy the new connection.
  children[0].emit('exit', 2); children[1].reply({ windows: [] });
  assert.deepEqual(await second, { windows: [] }); assert.equal(native.child, children[1]); native.stop();
});

test('native timeout clears stale observations and recovers on the next request', async () => {
  const children = [], native = new NativeBridge({ requestTimeout: 40, spawnProcess: () => { const child = helper(); children.push(child); return child; } });
  const expired = native.call('invoke'); await nextTick(); native.observations.set('old', {});
  await assert.rejects(expired, { code: 'native_timeout' });
  assert.equal(children[0].killed, true); assert.equal(native.observations.size, 0);
  const fresh = native.call('capabilities'); await nextTick(); children[1].reply({ physicalInput: false });
  assert.deepEqual(await fresh, { physicalInput: false }); native.stop();
});

test('fast input bounds the stale readback wait and refreshes controls without an unnecessary screenshot',async()=>{
  const child=helper(),native=new NativeBridge({spawnProcess:()=>child});
  const member={id:'worker',window:{id:123,pid:456}};
  native.observations.set('fresh',{memberId:member.id,window:member.window,desktop:'AgentDock_Test',token:'native-token',createdAt:new Date().toISOString()});
  const action=native.act(member,{observationId:'fresh',action:'set_value',elementIndex:2,value:'actual draft'},{readbackTimeoutMs:400});await nextTick();
  assert.equal(child.request.args.readbackTimeoutMs,400);assert.equal(child.request.args.expectedPid,456);child.reply({ok:true});await nextTick();
  assert.equal(child.request.action,'observe');assert.equal(child.request.args.includeScreenshot,false);
  child.reply({window:member.window,elements:[],text:'actual draft'});await action;native.stop();
});
