import {createHash} from 'node:crypto';

// Diagnose observed failures only. Idle coordinators are not disconnected, and
// an ambiguous client error must not be presented as confirmed quota/login.
export function solutionFor(detail,{coordinator=false,uncertain=false}={}){
  if(uncertain)return {code:'outcome_uncertain',title:'上轮结果需要核对',remedy:'先打开官方统筹会话检查上轮结果。检查连接只恢复通道，不会重新发任务。',action:'thread'};
  if(/quota|额度|usage limit|rate limit|429|用量/i.test(detail)&&!/登录或额度/.test(detail))return {code:'quota',title:'额度或请求频率受限',remedy:'查看官方客户端显示的剩余额度和重置时间；恢复后继续，也可以在项目分工中选择备用成员。',action:coordinator?'check':'member'};
  if(/ChatGPT 登录|unauthorized|unauthenticated|401|登录失效|需要登录|未登录/i.test(detail))return {code:'login',title:coordinator?'Codex 登录需要处理':'客户端需要登录',remedy:coordinator?'在官方 Codex 客户端确认 ChatGPT 登录，然后点击“检查统筹连接”。':'进入共作工作桌面，在该专用客户端完成登录，再返回检查绑定。',action:coordinator?'check':'member'};
  if(/窗口|绑定|登录或额度/.test(detail))return {code:'client',title:'成员客户端需要处理',remedy:'检查共作工作桌面中的专用实例是否已准备好。若窗口关闭或失效，请重新绑定；登录和额度以客户端实际提示为准。',action:'member'};
  if(coordinator&&/退出|连接|启动|超时|协议|EPIPE|ECONN|ENOTFOUND|fetch failed|network|stream disconnected/i.test(detail))return {code:'runtime',title:'Codex 统筹连接异常',remedy:'点击“检查统筹连接”重新建立官方本地通道。若仍失败，请确认 Codex 已安装、已登录，并能正常完成请求；已派发的工作不会重发。',action:'check'};
  return {code:'attention',title:coordinator?'统筹暂停，需要处理':'任务暂停，需要处理',remedy:coordinator?'查看下方实际原因，打开本轮会话核对。方案已落盘的部分会保留，不会自动重复派发。':'打开对应成员和任务记录，核实草稿、发送结果及客户端提示后再继续。',action:coordinator?'thread':'member'};
}
export function diagnostics(state,runtime){
  const issues=[],seen=new Set();
  const add=(key,detail,context={})=>{if(!detail)return;const solution=solutionFor(detail,context),id=createHash('sha256').update(key+'\n'+detail).digest('hex').slice(0,20);if(seen.has(id))return;seen.add(id);issues.push({id,detail,...solution,...context});};
  if(runtime?.status==='error')add('runtime',runtime.error,{coordinator:true,scope:'Codex 统筹'});
  for(const p of state.projects){
    if(['completed','deleted'].includes(p.status))continue;
    for(const r of p.rounds||[])if(r.status==='error')add(r.id,r.error,{coordinator:true,uncertain:!!(r.outcomeUncertain||r.applyingTurnId),scope:p.title,projectId:p.id,threadId:r.threadId});
    for(const t of p.tasks||[]){if(['done','cancelled'].includes(t.status))continue;const detail=t.fast?.error||t.error;if(!detail)continue;const m=state.members.find(m=>m.id===t.assignee);add(`${p.id}:${t.assignee}`,detail,{scope:`${p.title} · ${m?.name||t.assignee}`,projectId:p.id,memberId:t.assignee});}
    if(p.execution?.phase==='blocked'&&!issues.some(i=>i.projectId===p.id&&i.detail===p.execution.detail))add(p.id+':execution',p.execution.detail,{scope:p.title,projectId:p.id});
  }
  return issues;
}
export function coordinatorState(state,runtime,busy){
  if(!runtime)return {coordinator:{...state.coordinator,connected:!!state.coordinator.lastSeen&&Date.now()-Date.parse(state.coordinator.lastSeen)<120000},runtime:{enabled:false,busy:false}};
  const status=runtime.snapshot?.()||{status:busy?'working':'dormant'};
  return {coordinator:{...state.coordinator,connected:['ready','working'].includes(status.status),mode:'app-server'},runtime:{enabled:true,busy,kind:'official-codex-app-server',...status}};
}
