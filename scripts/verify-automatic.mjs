import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDock } from '../src/server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const real=JSON.parse(fs.readFileSync(path.join(root,'.data','state.json'),'utf8'));
const member=real.members.find(m=>m.id===process.argv[2]);
if(!member?.window||!member.connection?.desktop?.startsWith('AgentDock_'))throw new Error('请指定实际绑定的独立官方客户端成员');
if(real.projects.some(p=>p.takeover?.active||p.tasks.some(t=>t.assignee===member.id&&['running','queued','waiting'].includes(t.status))))throw new Error('当前官方客户端还有任务或人工接管，停止验证');
const ui=process.argv.includes('--ui');
const resumeDirectory=process.argv[3] && process.argv[3]!=='--ui' ? process.argv[3] : null;
if(resumeDirectory && (!path.resolve(resumeDirectory).startsWith(path.join(root,'artifacts','automatic-official-')) || !fs.existsSync(path.join(resumeDirectory,'state.json'))))throw new Error('只能恢复已记录的独立验证目录');
const directory=resumeDirectory || fs.mkdtempSync(path.join(root,'artifacts','automatic-official-'));
const dock=createDock({directory});
const started=Date.now();
const evidence={directory,startedAt:new Date().toISOString(),stages:[],passed:false};
const write=()=>fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(evidence,null,2));
try {
  await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${dock.server.address().port}`;
  fs.writeFileSync(path.join(root,'artifacts','automatic-official-latest.json'),JSON.stringify({directory,base,pid:process.pid}));
  dock.store.saveMember({id:'doubao_work',name:member.name,provider:member.provider,window:member.window,connection:{...member.connection,autoLaunch:false}});
  const p=resumeDirectory ? dock.store.project(dock.store.state.projects[0].id) : dock.store.createProject({title:'统筹任务投递验证',goal:'仅验证预先编写的任务如何投递与回传，不用固定模板替代模型规划',team:[{memberId:'codex'},{memberId:'doubao_work'}]});
  evidence.mode='coordinator-authored-transport-fixture';
  evidence.projectId=p.id;evidence.base=base;
  dock.store.activity.on('change',()=>{const items=dock.store.activity.snapshot();evidence.stages.push(...items.filter(i=>i.status==='running').map(i=>({title:i.title,at:Date.now()-started})));write();});
  const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
  const response=ui ? null : resumeDirectory
    ? await fetch(base+`/api/projects/${p.id}/run`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'})
    : await fetch(base+`/api/projects/${p.id}/messages`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({requestId:'official-verification',text:'这是 AgentDock 自身的自动派发验证。请在本次要求指定的新成果目录内写 ready.txt，内容严格为“自动派发验证通过”。不要生成额外报告或做其他任务。完成后按提示输出完成标记。'})});
  if(response && !response.ok)throw new Error((await response.json()).error);
  if(response)evidence.messageResponseMs=Date.now()-started;
  write();console.log(`验证界面已准备：${base}`);
  let task;
  while(Date.now()-started<180000){
    const messages=dock.store.inbox(p.id).filter(item=>item.type==='user.message');
    if(!dock.store.project(p.id).tasks.length&&messages.length){
      // This fixed task is a transport test fixture authored by the developer,
      // not a planner implementation and not an automatic rewrite of the user goal.
      dock.store.inbox(p.id,messages.map(item=>item.id));
      dock.store.createTask(p.id,{title:'执行已编写的小文件验证',assignee:'doubao_work',stage:'execution',dispatchMode:'automatic',output:'deliveries/transport-check/ready.txt',description:'这是隔离的 AgentDock 传输验证。只在指定路径写入 ready.txt，内容严格为“自动派发验证通过”。不生成额外报告，不执行其他工作。',acceptance:'指定本地文件存在，UTF-8 内容严格匹配约定文本，由验证程序回读与核对。'});
    }
    task=dock.store.project(p.id).tasks.find(t=>t.fast);
    if(task?.dispatch?.status==='sent'&&!evidence.dispatchedMs){evidence.dispatchedMs=Date.parse(task.fast.dispatchedAt)-Date.parse(task.fast.receivedAt);evidence.attempts=task.attempts;write();console.log(`已实际派发：${evidence.dispatchedMs} ms，填写次数 ${task.attempts}`);}
    if(task?.status==='review')break;
    if(dock.store.project(p.id).execution?.phase==='blocked')throw new Error(dock.store.project(p.id).execution.detail);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(task?.status!=='review')throw new Error('未在验证时限内收到实际完成回复');
  const artifacts=dock.store.project(p.id).artifacts;
  const artifact=artifacts.find(a=>a.relative.replaceAll('\\','/').endsWith('/ready.txt'));
  if(!artifact)throw new Error('没有收集到真实 ready.txt');
  const content=fs.readFileSync(dock.store.safePath(dock.store.project(p.id),artifact.relative),'utf8').replace(/^\uFEFF/,'').trim();
  if(content!=='自动派发验证通过')throw new Error('真实文件内容不匹配');
  Object.assign(evidence,{passed:true,completedMs:Date.now()-Date.parse(task.fast.receivedAt),taskId:task.id,dispatch:task.dispatch.status,attempts:task.attempts,artifact,content,coordinatorConnected:dock.store.state.coordinator.connected});
  write();console.log(JSON.stringify({passed:true,dispatchedMs:evidence.dispatchedMs,completedMs:evidence.completedMs,attempts:task.attempts,coordinatorConnected:evidence.coordinatorConnected}));
  if(ui){dock.automatic.stop();dock.native.stop();await new Promise(resolve=>setTimeout(resolve,30000));}
} catch(error){evidence.error=error.message;write();console.error(error.message);process.exitCode=1;}
finally{await dock.close();}
