export function projectProgress(project, state, now = Date.now()) {
  if (!project || project.takeover?.active) return null;
  const activities = (state.activities || []).filter(item => item.projectId === project.id && item.expiresAt > now);
  const operation = activities.findLast(item => item.status === 'running') || activities.at(-1);
  if (project.status !== 'running' && operation?.status !== 'running') return null;
  const name = id => state.members.find(member => member.id === id)?.name || '团队';
  if (project.execution?.phase === 'delivered' && operation?.status !== 'running') return null;
  if (operation) return { ...operation, title: `${name(operation.memberId)} · ${operation.status === 'done' ? '操作完成' : operation.status === 'error' ? '操作需要处理' : operation.title}`, spinning: operation.status === 'running' };
  if(project.council?.phase==='blocked')return {title:'会商需要处理',detail:project.council.detail,spinning:false,status:'error'};
  if(project.council?.phase==='waiting_user')return {title:'等待你补充本轮',detail:project.council.detail,spinning:false};
  const pending = project.inbox?.some(item => !item.acknowledged);
  if (!pending && project.tasks.every(task=>['done','cancelled'].includes(task.status))) return null;
  const running = project.tasks.find(task => task.status === 'running');
  if (running) {
    if (running.dispatch?.status === 'unknown') return { title: '派发结果需要核实', detail: running.dispatch.detail, spinning: false };
    const fresh=project.execution?.taskId===running.id&&now-Date.parse(project.execution.observedAt||project.execution.dispatchedAt)<20000;
    return { title: `${name(running.assignee)} · ${fresh?'正在处理任务':'等待实际进度'}`, detail: fresh?project.execution.excerpt||running.title:'客户端任务尚未验收；当前没有新的操作回报。', spinning:!!fresh };
  }
  if (project.execution?.phase === 'blocked') return { title: '需要处理', detail: project.execution.detail, spinning: false, status: 'error' };
  if (project.execution?.phase === 'waiting_user') return { title: '等待你的答复', detail: project.execution.detail, spinning: false };
  if (project.execution?.phase === 'delivered') return null;
  if (project.execution?.phase === 'reading') return { title: '正在核对输入', detail: project.execution.detail, spinning: true };
  if (project.execution?.phase === 'queued') return { title: /^正在/.test(project.execution.detail) ? '正在准备派发' : '等待派发', detail: project.execution.detail, spinning: /^正在/.test(project.execution.detail) };
  if (project.execution?.phase === 'coordinator' || pending && !state.coordinator.connected) return { title: '等待 Codex 统筹', detail: project.execution?.detail || '目标已收到，统筹尚未领取，任务还没有派发。', spinning: false };
  if (pending) return { title: '等待统筹领取', detail: '目标已自动提交，等待实际分工。', spinning: false };
  return null;
}
