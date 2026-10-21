import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDock } from '../src/server.mjs';

test('loopback API requires session, rejects cross-origin writes and delivers files', async t => {
  const dock = createDock({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-http-')), native: { stop() {} } });
  await new Promise(resolve => dock.server.listen(0, '127.0.0.1', resolve));
  t.after(() => dock.close()); const base = `http://127.0.0.1:${dock.server.address().port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const home = await fetch(base); assert.equal(home.status, 200);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const send = async (url, data, origin) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
  assert.equal((await send('/api/projects', { title: 'A', goal: 'B' }, 'https://untrusted.example')).status, 403);
  assert.equal((await send('/api/projects', { title: 'A', goal: 'B' }, 'null')).status, 403);
  const response = await send('/api/projects', { title: '本地游戏', goal: '做一个小游戏' }); const p = await response.json(); assert.equal(response.status, 201);
  const artifact = await (await send('/api/tools/call', { name: 'dock_write_file', arguments: { projectId: p.id, relative: 'game.html', content: '<html><script>document.body.textContent="game"</script></html>' } })).json();
  const file = await fetch(`${base}/api/artifact/${p.id}/${artifact.id}`, { headers: { cookie } });
  assert.equal(file.status, 200); assert.match(file.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(await file.text(), /game/);
});

test('image artifacts keep their binary bytes, correct image MIME and authenticated preview URL', async t => {
  const dock=createDock({directory:fs.mkdtempSync(path.join(os.tmpdir(),'agentdock-images-')),native:{stop(){}}});
  await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));t.after(()=>dock.close());
  const base=`http://127.0.0.1:${dock.server.address().port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
  const project=dock.store.createProject({title:'图片预览检查',goal:'测试本地图片交付'});
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJz8AAAAASUVORK5CYII=','base64');
  fs.writeFileSync(path.join(project.workspace,'test.PNG'),bytes);
  const artifact=dock.store.registerArtifact(project.id,{relative:'test.PNG'}),url=`${base}/api/artifact/${project.id}/${artifact.id}?v=${artifact.sha256}`;
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  const download=await fetch(url+'&download=1',{headers:{cookie}});
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment; filename\*=UTF-8''test.PNG$/);
  assert.match(download.headers.get('content-security-policy'),/sandbox allow-downloads/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  const module=await fetch(base+'/layout.js');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);
});
