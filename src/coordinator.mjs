import {randomUUID} from 'node:crypto';
import {DockError} from './store.mjs';

// Supported by the installed Codex app's public task tool. A rejected host
// request remains failed; a saved preference is never labelled as applied.
export const hostModels = ['gpt-6.1-sol','gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'];
export const hostEfforts = model => ['low','medium','high','xhigh','max',...(/-luna$/.test(model)?[]:['ultra'])];
export function validateHostInference(value){
  if(value.model&&!hostModels.includes(value.model))throw new DockError('当前 Codex 宿主未列出这个模型','host_model_unavailable');
  if(value.effort&&!hostEfforts(value.model).includes(value.effort))throw new DockError('这个模型不支持所选推理程度','host_effort_unavailable');
  if(value.effort==='ultra'&&!value.model)throw new DockError('请选择明确支持 ultra 的模型');
}
export function bindCoordinator(store,input){
  if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(input.threadId||''))throw new DockError('专用统筹任务 ID 不正确');
  const previous=store.state.coordinatorBinding;
  if(previous?.threadId!==input.threadId){
    for(const request of store.state.coordinatorRequests||[])if(request.status==='pending')request.status='superseded';
    for(const member of store.state.members.filter(m=>m.coordinator))delete member.hostSettingReceipt;
  }
  store.state.coordinatorBinding={threadId:input.threadId,title:String(input.title||'共作专用统筹').slice(0,100),hostId:'local',boundAt:new Date().toISOString()};
  if(previous?.threadId!==input.threadId)for(const member of store.state.members.filter(m=>m.coordinator))if(member.inference?.model||member.inference?.effort)queueHostSettings(store,member,member.inference);
  store.save();return structuredClone(store.state.coordinatorBinding);
}
export function queueHostSettings(store,member,inference){
  const requests=store.state.coordinatorRequests||=[];
  for(const request of requests)if(request.memberId===member.id&&request.status==='pending')request.status='superseded';
  delete member.hostSettingReceipt;
  if(!inference.model&&!inference.effort)return;
  const request={id:'host_settings_'+randomUUID(),memberId:member.id,threadId:store.state.coordinatorBinding?.threadId||null,inference:{...inference},status:'pending',createdAt:new Date().toISOString()};
  requests.push(request);store.state.coordinatorRequests=requests.slice(-20);
}
export function reportHostSettings(store,{requestId,threadId,status,detail}){
  const request=store.state.coordinatorRequests?.find(r=>r.id===requestId);
  if(!request||request.status!=='pending')throw new DockError('设置请求已更新或已处理，请重新读取','host_request_stale',409);
  if(!request.threadId||request.threadId!==threadId||store.state.coordinatorBinding?.threadId!==threadId)throw new DockError('设置回执不属于绑定的统筹任务','host_thread_mismatch',409);
  if(!['submitted','failed'].includes(status)||typeof detail!=='string'||!detail.trim()||detail.length>2000)throw new DockError('请报告官方任务工具的提交结果');
  request.status=status;request.detail=detail.trim();request.reportedAt=new Date().toISOString();
  store.member(request.memberId).hostSettingReceipt=structuredClone(request);
  store.save();return structuredClone(request);
}
