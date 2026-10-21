import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Readable} from 'node:stream';
import {createDock} from '../src/server.mjs';import {Store,taskPrompt} from '../src/store.mjs';import {receiveUpload,safeUploadName} from '../src/uploads.mjs';
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dock-attachments-'));
test('binary attachments over the JSON limit retain exact bytes and enter a planned task through explicit IDs',async t=>{
 const dock=createDock({directory:dir(),native:{stop(){}}});await new Promise(r=>dock.server.listen(0,'127.0.0.1',r));t.after(()=>dock.close());
 const base=`http://127.0.0.1:${dock.server.address().port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
 const a=dock.store.createProject({title:'A',goal:'处理附件'}),b=dock.store.createProject({title:'B',goal:'独立项目'}),bytes=Buffer.alloc(3*1024*1024,0x81);bytes[0]=0;
 const url=base+`/api/projects/${a.id}/attachments`,headers={cookie,'x-file-name':encodeURIComponent('资料.zip'),'content-type':'application/octet-stream'};
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/octet-stream'},body:'x'})).status,401);
 const response=await fetch(url,{method:'POST',headers,body:bytes});assert.equal(response.status,201);const file=await response.json();
 const download=await fetch(url+'/'+file.id,{headers:{cookie}});assert.match(download.headers.get('content-disposition'),/^attachment/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 assert.throws(()=>dock.store.postUser(b.id,'访问别的项目','cross',[file.id]),{code:'input_not_found'});
 const message=dock.store.postUser(a.id,'','with_file',[file.id]);assert.equal(message.attachments[0].sha256,file.sha256);assert.equal(dock.store.inbox(a.id)[0].attachments[0].id,file.id);
 assert.equal(dock.store.postUser(a.id,'','with_file',[file.id]).id,message.id);assert.throws(()=>dock.store.postUser(a.id,message.text,'with_file',[]),{code:'message_conflict'});
 const task=dock.store.createTask(a.id,{title:'读取资料',description:'读取附件后提取内容',acceptance:'核对实际内容',assignee:'doubao_work',attachmentIds:[file.id]});
 assert.match(taskPrompt(dock.store.project(a.id),task),/参考附件/);assert.ok(taskPrompt(dock.store.project(a.id),task).includes(JSON.stringify(path.join(a.workspace,file.relative))));
 fs.writeFileSync(dock.store.safePath(dock.store.project(a.id),file.relative),'changed');assert.throws(()=>dock.store.inputs(a.id,[file.id]),{code:'input_changed'});
});
test('oversized streamed upload is removed and unsafe file names cannot choose filesystem paths',async()=>{
 const store=new Store(dir()),p=store.createProject({title:'A',goal:'B'}),request=Readable.from([Buffer.from('12345'),Buffer.from('67890')]);request.headers={'x-file-name':encodeURIComponent('../../CON.txt')};
 await assert.rejects(receiveUpload(request,store,p.id,{limit:8}),{code:'file_too_large'});assert.equal(store.project(p.id).attachments?.length||0,0);
 assert.equal(safeUploadName('CON.txt'),'file_CON.txt');assert.ok(!/[\\/]/.test(safeUploadName('../../file.pdf')));
 const inputRoot=path.join(p.workspace,'inputs');for(const folder of fs.readdirSync(inputRoot))assert.equal(fs.readdirSync(path.join(inputRoot,folder)).length,0);
});
