import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DockError} from './store.mjs';
export const uploadLimit=100*1024*1024;
export function safeUploadName(name) {
  let clean=String(name||'file').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,160)||'file';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean))clean='file_'+clean;
  return clean;
}
export async function receiveUpload(req,store,projectId,{limit=uploadLimit}={}) {
  const p=store.project(projectId);
  let original;try{original=decodeURIComponent(req.headers['x-file-name']||'file');}catch{throw new DockError('文件名编码不正确');}
  if(Number(req.headers['content-length'])>limit)throw new DockError('单个文件最大 100 MB','file_too_large',413);
  const id='input_'+randomUUID().slice(0,12),name=safeUploadName(original),relative=`inputs/${id}/${name}`;
  const target=store.safePath(p,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=target+'.uploading';const handle=await fs.promises.open(temporary,'wx');
  let size=0;const hash=createHash('sha256');
  try {
    for await(const chunk of req){size+=chunk.length;if(size>limit)throw new DockError('单个文件最大 100 MB','file_too_large',413);hash.update(chunk);await handle.writeFile(chunk);}
    if(req.aborted)throw new DockError('文件上传已中断');
    await handle.close();fs.renameSync(temporary,target);
    const item={id,name,relative,size,sha256:hash.digest('hex'),createdAt:new Date().toISOString()};
    p.attachments??=[];p.attachments.push(item);store.log('input.uploaded',{projectId,id,name,size});store.save();return structuredClone(item);
  }catch(error){await handle.close().catch(()=>{});fs.rmSync(temporary,{force:true});throw error;}
}
