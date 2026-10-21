export const stages = [
  {id:'planning',label:'方案规划',short:'规划'},
  {id:'execution',label:'成员执行',short:'执行'},
  {id:'review',label:'检验与返工',short:'检验'},
  {id:'delivery',label:'成果交付',short:'交付'}
];
export const liveTask = task => !['done','cancelled'].includes(task.status);
export function groupTasks(project) {
  return stages.map(stage=>({...stage,tasks:project.tasks.filter(task=>task.status!=='cancelled'&&(task.stage||'execution')===stage.id)}));
}
export function workflowStage(project) {
  if (project.status==='completed') return 'delivery';
  if (project.inbox?.some(item=>item.type==='user.message'&&!item.acknowledged)) return 'planning';
  if (project.tasks.some(t=>t.status==='review'||t.stage==='review'&&liveTask(t))) return 'review';
  if (project.tasks.some(t=>t.stage==='delivery'&&liveTask(t))) return 'delivery';
  if (project.tasks.some(t=>!['planning','review','delivery'].includes(t.stage)&&liveTask(t))) return 'execution';
  return 'planning';
}
export function agentLogo(member) {
  const provider=(member?.provider||'').toLowerCase();
  if (/codex|openai/.test(provider)) return '/agents/codex.png';
  if (/豆包工作|doubao.?work/.test(provider)) return '/agents/doubao-work.png';
  if (/豆包|doubao/.test(provider)) return '/agents/doubao.png';
  if (/trae|trea/.test(provider)) return '/agents/trae.png';
  return null;
}
export function quotaState(member, now=Date.now()) {
  const q=member.quota;
  if (!q || !Number.isFinite(q.total)||q.total<=0||!Number.isFinite(q.remaining)||q.remaining<0||q.remaining>q.total) return {known:false,percent:null,label:member.status==='quota'?'额度不足':'额度未知',detail:member.status==='quota'?(member.detail||'已报告额度不足；未读取到具体数量。'):'尚未读取到官方额度。可在成员设置中记录，不估算使用量。'};
  const expired=!!q.resetAt&&Date.parse(q.resetAt)<=now,stale=now-Date.parse(q.updatedAt)>86400000;
  const percent=Math.round(q.remaining/q.total*100);
  return {known:!expired,percent:expired?null:percent,stale,label:expired?'待更新额度':`剩余 ${percent}%`,detail:`剩余 ${q.remaining} / ${q.total} ${q.unit||'次'}\n来源：${q.source==='manual'?'手动记录，非实时同步':'官方读取'}${stale?'（记录较旧）':''}\n记录时间：${new Date(q.updatedAt).toLocaleString('zh-CN')}${q.resetAt?`\n重置时间：${new Date(q.resetAt).toLocaleString('zh-CN')}`:''}${expired?'\n已过重置时间，请更新记录。':''}`};
}
