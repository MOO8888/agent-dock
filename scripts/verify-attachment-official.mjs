const memberId=process.argv[2];if(!memberId)throw Error('Pass the explicitly selected dedicated member ID as the first argument.');
import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';import {createDock} from '../src/server.mjs';import {NativeBridge} from '../src/native.mjs';
const real=JSON.parse(fs.readFileSync('.data/state.json','utf8')),member=real.members.find(m=>m.id===memberId);
const busy=state=>state.projects.some(p=>p.takeover?.active||p.status==='running');
if(busy(real)||!member?.window||member.status!=='ready')throw Error('Official client must be bound and idle');
const directory=fs.mkdtempSync(path.resolve('artifacts/attachment-official-')),dock=createDock({directory,native:new NativeBridge()});
const result={directory,startedAt:new Date().toISOString()};
try{
 dock.store.saveMember({id:'doubao_work',name:member.name,provider:member.provider,window:member.window,connection:{...member.connection,autoLaunch:false}});
 const p=dock.store.createProject({title:'附件原文读取验证（测试）',goal:'只读取测试附件并回传校验内容，不处理其他文件',team:[{memberId:'codex'},{memberId:'doubao_work'}]});
 await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${dock.server.address().port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
 const code=randomBytes(12).toString('hex'),original=Buffer.from(`附件验证\n校验码：${code}\n请只读取本文件。\n`);
 const response=await fetch(base+`/api/projects/${p.id}/attachments`,{method:'POST',headers:{cookie,'x-file-name':encodeURIComponent('附件原文.txt'),'content-type':'application/octet-stream'},body:original});
 if(!response.ok)throw Error('Upload failed: '+response.status);const input=await response.json();result.input=input;
 const relative='deliveries/attachment-proof.json';
 dock.store.postCoordinator(p.id,{text:'验证计划：由豆包工作读取刚上传的原始文本，仅提取其中校验码和文件名写成 JSON；统筹随后与原文件逐字核对。不生成图片，不读取其他用户资料。'});
 const task=dock.store.createTask(p.id,{title:'读取上传附件并输出校验码',assignee:'doubao_work',stage:'execution',dispatchMode:'automatic',attachmentIds:[input.id],output:relative,description:'请用本地文件工具打开参考附件中的原始文本；从“校验码：”后读取完整校验码。不要猜测，不读取其他文件，不发送网络请求。写出产物 JSON，字段 code 为你从附件实际读到的校验码，filename 为附件文件名。除此以外不改其他文件。',acceptance:'实际 JSON 可以解析；code 与附件中的校验码完全一致，filename 为 附件原文.txt。完成后报告实际读取路径与产物路径。'});
 result.taskId=task.id;dock.store.runProject(p.id);const deadline=Date.now()+180000;let previous='';
 while(Date.now()<deadline){
  if(busy(JSON.parse(fs.readFileSync('.data/state.json','utf8'))))throw Error('Real work started; verification paused');
  const current=dock.store.task(p.id,task.id)[1],phase=current.status+':'+(dock.store.project(p.id).execution?.phase||'');
  if(phase!==previous){console.log(JSON.stringify({phase,at:new Date().toISOString()}));previous=phase;}
  if(current.status==='review'){
   const output=JSON.parse(fs.readFileSync(path.join(p.workspace,relative),'utf8').replace(/^\uFEFF/,''));
   if(output.code!==code||output.filename!=='附件原文.txt')throw Error('Official file readback does not match uploaded original');
   dock.store.updateTask(p.id,task.id,{status:'done',evidence:[{type:'file',path:relative,detail:'Original upload and official worker output match the exact private challenge code and filename.'}]});
   result.passed=true;result.output=relative;result.dispatch=current.dispatch?.status;result.messageCount=dock.store.project(p.id).messages.filter(m=>m.provenance?.type==='official-ui').length;break;
  }
  if(dock.store.project(p.id).execution?.phase==='blocked')throw Error(dock.store.project(p.id).execution.detail);
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 if(!result.passed)throw Error('Timed out awaiting actual official reply; do not resend');
}catch(error){result.passed=false;result.error=error.message;process.exitCode=1;}
finally{
 for(const p of dock.store.state.projects)if(p.status==='running')dock.store.pauseProject(p.id,'验证结束；停止新的操作，不取消官方已开始的任务');
 await dock.close();result.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
