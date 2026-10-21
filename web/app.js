import { initResizableWorkspace } from './layout.js';
import { projectProgress } from './activity.js';
import { stages,groupTasks,workflowStage,liveTask,agentLogo,quotaState } from './workflow.js';
import {attachmentComposer} from './uploads.js';
import {createProblemCenter,runtimeLabel} from './problems.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { draft: '准备中', running: '正在推进', paused: '已暂停', completed: '已交付', queued: '待开始', waiting: '等待处理', review: '待检验', done: '已完成', failed: '执行异常', cancelled: '已取消', unbound: '待绑定', ready: '已绑定', busy: '工作中', quota: '额度不足', login: '需要登录', error: '需要处理' };
const dispatchLabel = dispatch => !dispatch ? '尚未派发' : dispatch.status==='unknown' && dispatch.phase==='filling' ? '草稿待核对（未发送）' : ({prepared:'草稿待发送',sending:'正在准备',sent:'已发送',unknown:'发送结果待核实',failed:'派发失败'}[dispatch.status] || '待核实');
let state = null, selected = localStorage.getItem('dock-project'), tab = 'chat', observation = null, observedMember = null;
let toastTimer, loading = null, refreshAgain = false, layoutController, sending = null, pendingSend = null, activityKey = '';
let attachments, roundSelectionKey;
const problems=createProblemCenter({onAction:async issue=>{
  if(issue.action==='local'){try{await refresh();toast('工作台已恢复连接');}catch(error){toast(error.message,true);}return;}
  if(issue.action==='check'){await checkCoordinator();return;}
  problems.close();if(issue.projectId)chooseProject(issue.projectId);
  showDialog('成员连接处理',`<p class="dialog-note">${escape(issue.scope)}</p><p class="dialog-note">${escape(issue.remedy)}</p><ol class="recovery-steps"><li>确认共作独立工作桌面里的专用客户端已完成登录或首次准备。</li><li>返回后，在右侧选择这个成员，点击“绑定窗口”选择正确实例。</li><li>查看任务中的草稿与发送记录；若发送结果不确定，先在客户端核对，避免重复发送。</li></ol><p class="field-note">本提示只读取已记录的错误，没有操作客户端。</p>`);
}});
const current = () => state?.projects.find(p => p.id === selected);
function projectActivity(p) {
  if (p.status !== 'running') return labels[p.status];
  if (p.tasks.some(t => t.status === 'running')) return '正在执行任务';
  if (p.execution?.phase === 'blocked') return '需要处理';
  if (p.tasks.some(t => t.status === 'waiting')) return '等待处理';
  if (p.tasks.some(t => t.status === 'review')) return '等待验收';
  if (p.execution?.mode === 'direct' && p.execution.phase === 'queued') return '等待任务派发';
  if(p.council){const active={opening:'统筹正在细化目标',consolidating:'统筹正在汇总意见',consulting:'各成员会商中',executing:'按分工执行',verifying:'统筹正在核验',waiting_user:'等待你的答复',blocked:'需要处理'}[p.council.phase];if(active)return active;}
  if (!state.coordinator.connected) return '等待统筹者';
  return p.tasks.some(t => t.status === 'queued') ? '等待任务派发' : '等待统筹安排';
}
const projectMembers = p => state.members.filter(m=>!p||p.memberIds.includes(m.id)).map(m=>({...m,role:p?.team?.find(e=>e.memberId===m.id)?.role||m.role}));
function projectTeamFields(project) {
  return `<fieldset class="project-team-fields"><legend>项目成员与分工</legend><p class="field-note">这份分工只用于当前项目，可以随时修改。</p>${state.members.map(m=>`<div class="project-team-row"><label class="check-label"><input type="checkbox" data-project-member="${m.id}" ${!project||project.memberIds.includes(m.id)?'checked':''} ${m.coordinator?'disabled':''}>${escape(m.name)}${m.coordinator?' · 统筹':''}</label><input aria-label="${escape(m.name)}的项目分工" data-project-role="${m.id}" value="${escape(project?.team?.find(e=>e.memberId===m.id)?.role||m.role)}" maxlength="100" required></div>`).join('')}</fieldset>`;
}
function wireProjectTeam(form) {
  for(const checkbox of form.querySelectorAll('[data-project-member]')) {const role=[...form.querySelectorAll('[data-project-role]')].find(e=>e.dataset.projectRole===checkbox.dataset.projectMember);const update=()=>role.disabled=!checkbox.checked;checkbox.onchange=update;update();}
}
function readProjectTeam(form) {return [...form.querySelectorAll('[data-project-member]')].filter(e=>e.checked).map(e=>({memberId:e.dataset.projectMember,role:[...form.querySelectorAll('[data-project-role]')].find(role=>role.dataset.projectRole===e.dataset.projectMember).value}));}
function editProjectTeam() {
  const p=current();if(!p)return;
  showDialog('编辑项目分工',`<form id="project-team-form">${projectTeamFields(p)}<div class="dialog-actions"><button class="primary">保存项目分工</button></div></form>`,()=>{const form=$('#project-team-form');wireProjectTeam(form);form.onsubmit=safe(async event=>{event.preventDefault();await request(`/api/projects/${p.id}`,{method:'PATCH',body:{team:readProjectTeam(form)}});closeDialog();await refresh();toast('已保存当前项目的分工');});});
}
function quotaFields(m) {
 const q=m.quota||{},local=q.resetAt?new Date(Date.parse(q.resetAt)-new Date(q.resetAt).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
 return `<details class="client-settings"><summary>额度记录 · ${escape(quotaState(m).label)}</summary><p class="field-note">按官方客户端显示手动记录。圆环显示剩余比例，悬停查看数量与更新时间；不会自动扣减或假装实时同步。清空剩余量与总量即可恢复未知。</p><div class="form-grid"><label>剩余额度<input name="quotaRemaining" type="number" min="0" step="any" value="${q.remaining??''}"></label><label>总额度<input name="quotaTotal" type="number" min="0" step="any" value="${q.total??''}"></label><label>单位<input name="quotaUnit" maxlength="30" value="${escape(q.unit||'次')}"></label><label>重置时间（可选）<input name="quotaReset" type="datetime-local" value="${local}"></label></div></details>`;
}
function connectionFields(m) {
  if(m.coordinator)return '<p class="field-note">自动统筹显示官方本地运行时的实际状态；待命和等待成员回复不会判为掉线。</p>';
  const c=m.connection||{};
  return `<details class="client-settings"><summary>客户端自动连接${c.autoBind?' · 已开启':''}</summary><label>客户端程序路径<input name="executable" value="${escape(c.executable||m.window?.executable||'')}" placeholder="官方客户端的完整 .exe 路径"></label><label>启动参数（可选）<input name="clientArguments" value="${escape(c.arguments||'')}" placeholder="支持 {workspace} 和 {profile}"></label><label class="check-label"><input name="autoBind" type="checkbox" ${c.autoBind?'checked':''}>运行当前项目时自动绑定</label><label class="check-label"><input name="autoLaunch" type="checkbox" ${c.autoLaunch?'checked':''}>专用客户端未启动时自动启动</label><label class="check-label"><input name="isolated" type="checkbox" ${c.desktop!=='default'?'checked':''}>使用共作独立工作桌面</label><p class="field-note">多个匹配窗口会提示选择；登录和权限确认由你处理。</p>${m.detail?`<p class="field-note">${escape(m.detail)}</p>`:''}</details>`;
}
function toast(text, error = false) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').className = `toast${error ? ' error' : ''}`; toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), error ? 7000 : 3500); }
async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: options.body == null ? undefined : JSON.stringify(options.body) }); }
  catch { throw new Error('无法连接本地工作台，请确认服务仍在运行后重试'); }
  let value; try { value=await response.json(); } catch { throw new Error('无法读取工作台返回的内容，请刷新页面后重试'); }
  if (!response.ok) {const error=new Error(value.error || '请求失败');error.code=value.code;throw error;} return value;
}
async function tool(name, args) { return request('/api/tools/call', { method: 'POST', body: { name, arguments: args } }); }
function safe(fn) { return async (...args) => { try { await fn(...args); } catch (e) { toast(e.message, true);problems.operationFailed(e); } }; }
function avatar(member, extra = '') { const name = member?.name || '工作台',logo=agentLogo(member); return `<span class="avatar ${logo?'brand-avatar':''} ${extra}" ${logo?'':`data-color="${escape(member?.color || '#7a9471')}"`}>${logo?`<img src="${logo}" alt="${escape(member.name)} Logo" width="26" height="26">`:escape(name.slice(0,1))}</span>`; }
function quotaRing(member) {
  const q=quotaState(member),tone=!q.known?'unknown':q.percent<=15?'low':q.percent<=40?'medium':'healthy';
  return `<span class="agent-meter ${tone} ${q.stale?'stale':''}" aria-label="${escape(q.label)}"><svg viewBox="0 0 44 44" aria-hidden="true"><circle class="meter-track" cx="22" cy="22" r="19"/><circle class="meter-value" cx="22" cy="22" r="19" pathLength="100" stroke-dasharray="${q.known?q.percent:0} 100"/></svg>${avatar(member)}${!q.known?'<i class="meter-unknown">?</i>':''}</span><span class="quota-tooltip" role="tooltip" popover="manual"><b>${escape(member.name)} · ${escape(q.label)}</b><span>${escape(q.detail)}</span></span>`;
}
function colors() { $$('.avatar[data-color]').forEach(el => { if (/^#[0-9a-f]{6}$/i.test(el.dataset.color)) el.style.backgroundColor = el.dataset.color; }); }
function showDialog(title, html, bind = () => {}) {
  $('#dialog-title').textContent = title; $('#dialog-body').innerHTML = html;
  if (!$('#dialog').open) $('#dialog').showModal(); bind(); colors();
}
function closeDialog() { $('#dialog').close(); }
async function refresh() {
  if (loading) { refreshAgain = true; return loading; }
  loading = (async () => {
  state = await request('/api/state');
  problems.connectionRestored();
  if (!state.projects.some(p => p.id === selected)) {
    selected = state.projects.at(-1)?.id || null; observation = null;
    if (selected) localStorage.setItem('dock-project', selected); else localStorage.removeItem('dock-project');
  }
  render();
  })();
  try { await loading; }
  finally { loading = null; if (refreshAgain) { refreshAgain = false; await refresh(); } }
}
function chooseProject(projectId) { selected = projectId; localStorage.setItem('dock-project', selected); observation = null; tab = 'chat'; render(); }
function render() {
  problems.update(state.issues);
  $('#project-count').textContent = state.projects.length;
  $('#trash-count').textContent = (state.deletedProjects || []).length;
  $('#project-list').innerHTML = state.projects.length ? state.projects.map(p => `<button class="project-nav ${p.id === selected ? 'active' : ''}" data-project="${p.id}" aria-label="${escape(p.title)}" title="${escape(p.title)}"><span class="project-symbol" aria-hidden="true">${p.status === 'running' ? '◉' : '▱'}</span><span>${escape(p.title)}</span></button>`).join('') : '<div class="nav-note">还没有项目。<br>从一个目标开始。</div>';
  $$('[data-project]').forEach(button => {
    button.onclick = () => chooseProject(button.dataset.project);
    button.oncontextmenu = event => { event.preventDefault(); chooseProject(button.dataset.project); projectActions(); };
  });
  $('#member-list').innerHTML = projectMembers(current()).map(m => `<button class="member-nav" data-member="${m.id}" aria-label="${escape(m.name)} · ${escape(m.role)} · ${escape(quotaState(m).label)}">${quotaRing(m)}<span class="member-caption"><b>${escape(m.name)}</b><small>${escape(m.role)}${m.coordinator && !m.role.includes('统筹') ? ' · 统筹' : ''}</small></span><i class="member-dot ${m.status}"></i></button>`).join('');
  $$('[data-member]').forEach(button => button.onclick = () => memberThread(button.dataset.member));
  $$('[data-member]').forEach(button=>{
    const tip=button.querySelector('.quota-tooltip');
    const show=()=>{const r=button.getBoundingClientRect();tip.showPopover?.();tip.style.left=`${Math.max(8,Math.min(r.right+10,window.innerWidth-288))}px`;tip.style.top=`${Math.max(8,Math.min(r.top,window.innerHeight-tip.offsetHeight-12))}px`;};
    const hide=()=>tip.hidePopover?.();button.onmouseenter=show;button.onmouseleave=hide;button.onfocus=show;button.onblur=hide;
  });
  const p = current(); $('#welcome').classList.toggle('hidden', !!p); $('#project-view').classList.toggle('hidden', !p);
  if (!p) { $('#project-breadcrumb').textContent = '开始一个项目'; colors(); layoutController?.refresh(); return; }
  $('#project-breadcrumb').textContent = p.title; $('#project-title').textContent = p.title; $('#project-goal').textContent = p.goal;
  $('#project-status').textContent = projectActivity(p);
  $('#project-status').dataset.status = p.status === 'running' && !p.tasks.some(t => ['running','review'].includes(t.status)) ? 'waiting' : p.status;
  $('#task-count').textContent = p.tasks.length; $('#artifact-count').textContent = p.artifacts.length;
  $('#run-project').innerHTML = p.status === 'running' ? '暂停项目 <span>Ⅱ</span>' : p.status === 'paused' ? '继续推进 <span>▷</span>' : p.status === 'completed' ? '已交付 <span>✓</span>' : '发送即开始';
  $('#run-project').disabled = ['draft', 'completed'].includes(p.status);
  $('#enter-desktop').classList.toggle('hidden', p.desktop === 'default');
  $('#enter-desktop').disabled = !!p.takeover?.active;
  $('#team-caption').textContent = `${projectMembers(p).length} 位成员 · 按需协作`;
  const workers = projectMembers(p).filter(m => !m.coordinator);
  $('#open-integration').textContent=state.coordinatorRuntime?.enabled?runtimeLabel(state.coordinatorRuntime.status):'连接 Codex';
  $('#coordinator-hint').textContent = state.coordinatorRuntime?.enabled ? state.coordinatorRuntime.status==='error'?'统筹需要处理 · 查看顶部解决方案':'发送后自动会商 · 统筹细化后分工' : state.coordinator.connected ? 'Codex 规划后分工执行' : '等待 Codex 统筹 · 不直接转发';
  const activeRound=p.rounds?.findLast(r=>!['completed','cancelled'].includes(r.status)),selectionKey=p.id+':'+(activeRound?.id||'')+':'+(activeRound?.status==='waiting_user');
  if(roundSelectionKey!==selectionKey){$('#message-mode').value=activeRound?.status==='waiting_user'?'continue':'new';roundSelectionKey=selectionKey;}
  renderMessages(p); renderTasks(p); renderArtifacts(p); renderProgress(p); setTab(tab);
  renderAgentControls(p);attachments?.render();
  const previousMember = $('#monitor-member').value;
  $('#monitor-member').innerHTML = projectMembers(p).filter(m => !m.coordinator).map(m => `<option value="${m.id}">${escape(m.name)} · ${escape(labels[m.status] || m.status)}</option>`).join('');
  if (projectMembers(p).some(m => m.id === previousMember && !m.coordinator)) $('#monitor-member').value = previousMember;
  renderScreen(); colors();
  renderActivity();
  if(p.takeover?.active) { $('#screen').innerHTML='<div class="screen-empty"><span>◌</span><b>人工接管中</b><p>窗口观察已暂停。<br>返回原桌面后再恢复项目。</p></div>'; $('#monitor-notice').textContent='正在等待你处理客户端确认，AI 不会操作或读取当前画面。'; }
}
function projectActions() {
  const p=current(); if(!p)return;
  showDialog('项目操作', `<p class="dialog-note">${escape(p.title)}</p><div class="project-menu"><button id="rename-project">重命名<span>修改项目名称</span></button><button id="menu-project-team">编辑分工<span>安排当前项目的成员与职责</span></button><button id="delete-project" class="danger-text">删除项目<span>移入回收站，可以恢复</span></button></div>`, () => {
    $('#rename-project').onclick=()=>renameProject(p);
    $('#menu-project-team').onclick=editProjectTeam;
    $('#delete-project').onclick=()=>deleteProjectDialog(p);
  });
}
function renameProject(p) {
  showDialog('重命名项目', `<form id="rename-project-form"><label>项目名称<input name="title" value="${escape(p.title)}" required maxlength="100" autofocus></label><div class="dialog-actions"><button class="secondary" type="button" id="rename-cancel">取消</button><button class="primary" type="submit">保存名称</button></div></form>`, () => {
    $('#rename-cancel').onclick=closeDialog;
    $('#rename-project-form').onsubmit=safe(async event=>{
      event.preventDefault(); const title=new FormData(event.target).get('title');
      const renamed=await request(`/api/projects/${p.id}`,{method:'PATCH',body:{title}});
      const settings=$('#settings-form');if(settings.dataset.projectId===p.id&&settings.elements.title.value===p.title)settings.elements.title.value=renamed.title;
      closeDialog();await refresh();toast('项目名称已更新');
    });
  });
}
function deleteProjectDialog(p) {
  const running=p.status==='running';
  showDialog(running?'先暂停项目':'删除项目？', `<p class="dialog-note">${running?'请先暂停':'“'+escape(p.title)+'”将移入回收站'}。聊天、任务、分工和本地成果会保留，可以随时恢复。</p><p class="dialog-note">${running?'暂停会停止新的操作。':'删除会停止工作台继续处理这个项目。'}已在官方客户端运行的任务可能继续执行，需要在客户端中处理。</p><div class="dialog-actions"><button class="secondary" id="delete-cancel">取消</button>${running?'<button class="primary" id="delete-pause">暂停项目</button>':'<button class="danger-button" id="delete-confirm">移入回收站</button>'}</div>`,()=>{
    $('#delete-cancel').onclick=closeDialog;
    if(running)$('#delete-pause').onclick=safe(async()=>{const paused=await request(`/api/projects/${p.id}/pause`,{method:'POST',body:{}});await refresh();deleteProjectDialog(paused);});
    else $('#delete-confirm').onclick=safe(async()=>{await request(`/api/projects/${p.id}`,{method:'DELETE'});closeDialog();await refresh();toast('项目已移入回收站，本地成果已保留');});
  });
}
function projectTrash() {
  const items=state.deletedProjects||[];
  showDialog('项目回收站', `<p class="dialog-note">删除的项目保留在这里，本地成果仍在原目录。恢复后不会自动派发任务。</p>${items.length?items.slice().reverse().map(p=>`<div class="trash-item"><div><b>${escape(p.title)}</b><small>${escape(new Date(p.deletedAt).toLocaleString('zh-CN'))} · ${p.tasks.length} 项任务 · ${p.artifacts.length} 个成果</small></div><button class="secondary" data-restore-project="${p.id}">恢复</button></div>`).join(''):'<div class="empty-dialog">回收站是空的。</div>'}`,()=>{
    $$('[data-restore-project]').forEach(button=>button.onclick=safe(async()=>{const p=await request(`/api/projects/${button.dataset.restoreProject}/restore`,{method:'POST',body:{}});closeDialog();await refresh();chooseProject(p.id);toast('项目已恢复，请核实任务状态后继续推进');}));
  });
}
function renderMessages(p) {
  const list = $('#messages'), nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const key = `${p.id}:${p.messages.length}:${p.messages.at(-1)?.id}:${JSON.stringify([p.council,p.rounds?.map(r=>[r.id,r.status,r.sessions]),p.tasks.map(t=>[t.id,t.status,t.dispatch?.status,t.fast?.suspended]),state.members.map(m=>[m.id,m.status])])}`;
  if (list.dataset.renderKey === key) return;
  const sameProject=list.dataset.projectId===p.id,seen=new Set([...list.querySelectorAll('[data-message-id]')].map(el=>el.dataset.messageId));
  const opened=new Set([...list.querySelectorAll('details[open][data-log-id]')].map(el=>el.dataset.logId));
  list.dataset.renderKey = key;list.dataset.projectId=p.id;
  const route=workflowStage(p);
  $('#workflow-route').innerHTML=stages.map((s,i)=>`<span class="${s.id===route?'current':''}"><i>${i+1}</i>${s.short}</span>${i<3?'<b aria-hidden="true">→</b>':''}`).join('');
  let log=[];
  const flush=()=>{if(!log.length)return '';const id=log[0].id;const html=`<details class="system-log" data-log-id="${id}" ${opened.has(id)?'open':''}><summary>工作台记录 <span>${log.length} 条</span></summary>${log.map(m=>`<p data-message-id="${m.id}"><time>${new Date(m.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>${escape(m.text)}</p>`).join('')}</details>`;log=[];return html;};
  list.innerHTML = councilCards(p)+`<div class="date-divider">项目群聊 · 讨论、分工与交接</div>` + p.messages.map(m => {
    if(m.author==='system'||m.kind==='system'){log.push(m);return '';}
    const preceding=flush();
    const member = state.members.find(v => v.id === m.author);
    const av = m.author === 'user' ? '<span class="avatar user">你</span>' : m.author === 'system' ? '<span class="avatar system">⌁</span>' : avatar(member);
    const source = { 'official-ui': '窗口原文', coordinator: '统筹发言', coordinator_summary: '统筹总结', system: '系统记录', user: '用户消息' }[m.provenance?.type] || '记录';
    const role=m.author==='user'?'项目发起人':member?.coordinator?'统筹 · 规划与验收':p.team?.find(e=>e.memberId===m.author)?.role||member?.role||'团队成员';
    const text=m.provenance?.type==='official-ui'?m.text.replace(/【AgentDock (?:完成|提问) [^】]+】/g,'').replace(/^展开全部\s*\n(?:今天 \d{2}:\d{2}\s*\n)?/,'').trim():m.text;
    const fileLinks=(m.attachments||[]).map(file=>`<a class="attachment-chip" href="/api/projects/${p.id}/attachments/${file.id}" download="${escape(file.name)}">▤ ${escape(file.name)} <small>${(file.size/1024).toFixed(1)} KB</small></a>`).join('');
    const body=(text.length>650?`<div class="message-text">${escape(text.slice(0,260))}…</div><details class="message-expand"><summary>展开完整内容</summary><div class="message-text">${escape(text.slice(260))}</div></details>`:`<div class="message-text">${escape(text)}</div>`)+(fileLinks?`<div class="message-files">${fileLinks}</div>`:'');
    return preceding+`<article data-message-id="${m.id}" class="message ${m.author==='user'?'from-user':member?.coordinator?'from-coordinator':'from-worker'} ${m.kind==='question'?'is-question':''} ${sameProject&&!seen.has(m.id)?'message-enter':''}">${av}<div class="message-body"><div class="message-head"><b>${escape(m.name)}</b><span class="message-source">${escape(role)}</span><time>${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><div class="message-bubble">${m.kind==='question'?'<span class="question-label">需要确认</span>':''}${body}${m.taskId?`<small class="message-task">关联任务 · ${escape(p.tasks.find(t=>t.id===m.taskId)?.title||m.taskId)}</small>`:''}</div>${m.provenance?.type === 'official-ui' ? `<details class="message-evidence"><summary>${source} · 查看来源</summary><pre>${escape(m.provenance.windowTitle)}\n${escape(m.provenance.capturedAt)}\n\n${escape(m.provenance.rawText)}</pre></details>` : ''}</div></article>`;
  }).join('')+flush();
  $$('[data-council-member]').forEach(button=>button.onclick=()=>memberThread(button.dataset.councilMember));
  if (nearBottom || p.messages.length < 4) list.scrollTop = list.scrollHeight;
}
function councilCards(p){
  const r=p.rounds?.find(round=>!['completed','cancelled'].includes(round.status))||p.rounds?.at(-1);if(!r)return '';
  const names={opening:'规划者细化目标',consulting:'各成员独立评议',consolidating:'统筹汇总意见',executing:'分工执行与检验',verifying:'统筹核验成果',waiting_user:'等待你补充',completed:'本轮已交付',blocked:'需要处理'};
  return `<section class="council-card" aria-label="本轮团队会商"><header><b>${escape(names[p.council?.phase]||'新一轮协作')}</b><small>${p.rounds.indexOf(r)+1} 轮 · ${escape(r.title)}</small></header><div class="council-members">${r.participants.map(person=>{
    const m=state.members.find(m=>m.id===person.memberId),session=r.sessions[person.memberId],assessment=p.tasks.find(t=>t.roundId===r.id&&t.assignee===person.memberId&&t.kind==='consultation');
    const label=person.coordinator?(r.status==='thinking'?'正在规划':r.threadId?'独立统筹会话':'待创建会话'):assessment?.status==='done'?'已发表意见':assessment?.fast?.suspended?'需要处理':m?.status==='login'?'需要登录':session?.status==='unknown'?'会话待核对':assessment?.dispatch?.status==='sent'?'正在评议':session?.status==='opening'?'正在创建会话':'待创建会话';
    return `<button type="button" data-council-member="${escape(person.memberId)}" title="${escape(assessment?.fast?.suspended?assessment.fast.error||'请核对官方客户端':'查看该成员的实际发言')}">${avatar(m)}<span><b>${escape(person.name)}</b><small>${escape(person.role)}</small><em>${escape(label)}</em></span></button>`;
  }).join('')}</div>${p.council?.detail?`<p>${escape(p.council.detail)}</p>`:''}</section>`;
}
function renderTasks(p) {
  const key = JSON.stringify([p.id, p.tasks.map(t => [t.id,t.stage,t.updatedAt,t.status,t.dispatch?.status,t.dispatch?.phase])]);
  if ($('#task-board').dataset.renderKey === key) return;
  const board=$('#task-board'),sameProject=board.dataset.projectId===p.id,open=new Set([...board.querySelectorAll('details[open][data-stage]')].map(el=>el.dataset.stage));
  board.dataset.renderKey = key;board.dataset.projectId=p.id;
  board.innerHTML = p.tasks.length ? groupTasks(p).filter(g=>g.tasks.length).map(g=>`<details class="task-stage" data-stage="${g.id}" ${sameProject?(open.has(g.id)?'open':''):(g.tasks.some(liveTask)?'open':'')}><summary><span>${escape(g.label)}</span><small>${g.tasks.filter(t=>t.status==='done').length} / ${g.tasks.length} 已完成</small></summary><div class="stage-tasks">${g.tasks.map(t => {
    const m = state.members.find(m => m.id === t.assignee);
    return `<article class="task-card"><div class="task-card-head">${avatar(m)}<b>${escape(t.title)}</b><span class="status-pill ${t.status}">${labels[t.status]}</span></div><div class="task-meta"><span>${escape(m?.name || t.assignee)}</span><span>${t.coordination?'Codex 已规划':'项目任务'}</span><select data-task-stage="${t.id}" aria-label="${escape(t.title)}的工作流阶段">${stages.map(stage=>`<option value="${stage.id}" ${(t.stage||'execution')===stage.id?'selected':''}>${stage.label}</option>`).join('')}</select></div><details><summary>提示词、验收与交接</summary><p>${escape(t.description)}</p><pre>验收：${escape(t.acceptance)}\n产物：${escape(t.output || '由成员在项目目录内选择')}\n派发：${escape(dispatchLabel(t.dispatch))}\n前置任务：${t.dependsOn.length} · 返工 ${t.reworks}/${p.maxReworks}\n证据：${escape(JSON.stringify(t.evidence, null, 2))}</pre><div class="task-controls"><button class="secondary" data-prompt="${t.id}">查看派发内容</button><button class="secondary" data-rework="${t.id}">安排返工</button></div></details></article>`;
  }).join('')}</div></details>`).join('') : '<div class="empty-pane">Codex 先讨论方案、编写具体提示词，<br>再创建任务并派发给执行成员。</div>';
  $$('[data-task-stage]').forEach(select=>select.onchange=safe(async()=>{await tool('dock_update_task',{projectId:p.id,taskId:select.dataset.taskStage,stage:select.value});await refresh();}));
  $$('[data-prompt]').forEach(button => button.onclick = safe(async () => { const result = await tool('dock_dispatch_prompt', { projectId: p.id, taskId: button.dataset.prompt }); showDialog('任务交接内容', `<p class="dialog-note">这段内容用于官方客户端会话。查看不会派发任务。</p><pre class="dialog-code">${escape(result.prompt)}</pre><div class="dialog-actions"><button class="primary" id="copy-prompt">复制提示词</button></div>`, () => $('#copy-prompt').onclick = safe(async () => { await navigator.clipboard.writeText(result.prompt); toast('已复制任务内容'); })); }));
  $$('[data-rework]').forEach(button => button.onclick = () => showDialog('安排返工', `<form id="rework-form"><label>需要修正的问题<textarea name="reason" rows="4" required placeholder="说明具体问题和期望结果"></textarea></label><div class="dialog-actions"><button class="primary">提交返工</button></div></form>`, () => $('#rework-form').onsubmit = safe(async event => { event.preventDefault(); await tool('dock_rework', { projectId: p.id, taskId: button.dataset.rework, reason: new FormData(event.target).get('reason') }); closeDialog(); await refresh(); })));
}
function renderArtifacts(p) {
  $('#workspace-path').textContent = `本地工作目录：${p.workspace}`;
  const key = JSON.stringify([p.id,p.goal,p.artifacts.map(a=>[a.id,a.sha256,a.description]),p.tasks.map(t=>t.output)]);
  if ($('#artifact-list').dataset.renderKey === key) return;
  $('#artifact-list').dataset.renderKey = key;
  const isImage = a => /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(a.relative);
  const images=p.artifacts.filter(isImage), files=p.artifacts.filter(a=>!isImage(a));
  const url=a=>`/api/artifact/${p.id}/${a.id}?v=${a.sha256}`;
  const meta=a=>`${(a.size/1024).toFixed(1)} KB · ${escape(state.members.find(m=>m.id===a.author)?.name||a.author)}`;
  const expectsImages=/图片|照片|生图/.test(p.goal)||p.tasks.some(t=>/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(t.output||''));
  $('#artifact-list').innerHTML = (images.length?`<h3 class="artifact-section-title">图片成果</h3><div class="artifact-gallery">${images.map(a=>`<article class="image-artifact"><button class="image-preview" data-preview-image="${a.id}" aria-label="放大查看 ${escape(a.relative)}"><img src="${url(a)}" alt="${escape(a.description||a.relative)}" loading="lazy" decoding="async"><span class="image-preview-error hidden">暂时无法预览，请打开或下载查看</span></button><div class="image-artifact-info"><b>${escape(a.relative)}</b><small>${meta(a)} · <span data-image-size="${a.id}">读取尺寸中</span></small><div class="image-artifact-actions"><button class="secondary" data-preview-image="${a.id}">放大查看</button><a class="secondary" href="${url(a)}&download=1" download="${escape(a.relative.split(/[\\/]/).at(-1))}">下载图片</a></div></div></article>`).join('')}</div>`:expectsImages?'<div class="empty-pane artifact-images-empty">还没有图片成果。<br>图片实际生成并保存后，会在这里显示预览。</div>':'')+(files.length?`<h3 class="artifact-section-title">文件与报告</h3>${files.map(a=>`<article class="artifact"><span class="artifact-icon">▤</span><div><b>${escape(a.relative)}</b><small>${meta(a)} · SHA-256 ${a.sha256.slice(0,10)}</small></div><a href="${url(a)}" target="_blank" rel="noopener">打开 ↗</a></article>`).join('')}`:p.artifacts.length||expectsImages?'':'<div class="empty-pane">真实成果会登记在这里。<br>文件保存后才可以交付。</div>');
  $$('[data-preview-image]').forEach(button=>button.onclick=()=>{
    const a=images.find(a=>a.id===button.dataset.previewImage);
    showDialog('图片成果',`<img class="image-full-preview" src="${url(a)}" alt="${escape(a.description||a.relative)}"><p class="dialog-note">${escape(a.relative)} · ${meta(a)}</p><div class="dialog-actions"><a class="secondary" href="${url(a)}" target="_blank" rel="noopener">打开原图 ↗</a><a class="primary" href="${url(a)}&download=1" download="${escape(a.relative.split(/[\\/]/).at(-1))}">下载图片</a></div>`);
  });
  $$('.image-preview img').forEach(img=>{
    const update=()=>{const card=img.closest('.image-artifact');card.querySelector('[data-image-size]').textContent=`${img.naturalWidth} × ${img.naturalHeight}`;};
    img.onload=update;img.onerror=()=>{img.classList.add('hidden');img.nextElementSibling.classList.remove('hidden');img.closest('.image-artifact').querySelector('[data-image-size]').textContent='预览不可用';};
    if(img.complete&&img.naturalWidth)update();
  });
}
function renderProgress(p) {
  const route=workflowStage(p),groups=groupTasks(p),live=p.tasks.filter(liveTask),tasks=p.tasks.filter(t=>t.status!=='cancelled'),done=tasks.filter(t=>t.status==='done').length;
  $('#workflow-route').innerHTML=stages.map((s,i)=>`<span class="${s.id===route?'current':''}"><i>${i+1}</i>${s.short}</span>${i<3?'<b aria-hidden="true">→</b>':''}`).join('');
  const area=$('#progress-summary'),key=JSON.stringify([p.id,p.status,route,p.tasks.map(t=>[t.id,t.title,t.stage,t.status])]);if(area.dataset.renderKey===key)return;
  const same=area.dataset.projectId===p.id,open=new Set([...area.querySelectorAll('details[open][data-progress-stage]')].map(el=>el.dataset.progressStage));area.dataset.renderKey=key;area.dataset.projectId=p.id;
  const active=p.status==='running';
  area.innerHTML=`<div class="progress-overview"><b>${p.status==='completed'?'本轮已交付':active?(live.length?`${live.length} 项待推进`:'等待 Codex 规划'):labels[p.status]}</b><small>${done} / ${tasks.length} 已验收</small></div>`+(active?groups.filter(g=>g.tasks.some(liveTask)).map(g=>`<details class="progress-stage" data-progress-stage="${g.id}" ${same&&open.has(g.id)?'open':''}><summary>${g.label}<span>${g.tasks.filter(liveTask).length}</span></summary>${g.tasks.filter(liveTask).map(t=>`<div class="progress-task"><span>${escape(t.title)}</span><small>${labels[t.status]}</small></div>`).join('')}</details>`).join(''):'')+(done?`<details class="progress-history"><summary>已完成记录 · ${done}</summary>${groups.filter(g=>g.tasks.some(t=>t.status==='done')).map(g=>`<details><summary>${g.label}</summary>${g.tasks.filter(t=>t.status==='done').map(t=>`<div class="progress-task"><span>${escape(t.title)}</span><small>已完成</small></div>`).join('')}</details>`).join('')}</details>`:'');
}
function renderScreen() {
  if (observation && observedMember === $('#monitor-member').value) {
    $('#screen').innerHTML = observation.screenshot?.available ? `<img alt="官方客户端的真实操作画面" src="data:image/png;base64,${observation.screenshot.data}">` : `<div class="screen-empty"><span>◌</span><b>暂时无法获取后台画面</b><p>${escape(observation.screenshot?.reason || '可以查看真实控件文字')}</p></div>`;
    $('#monitor-notice').textContent = `${observation.window.title} · ${new Date(observation.createdAt).toLocaleTimeString('zh-CN')}。${observation.screenshot?.available ? '真实窗口截图' : '控件文字仍可检查'}`;
  } else {
    $('#screen').innerHTML = '<div class="screen-empty"><span>▧</span><b>还没有操作画面</b><p>绑定官方客户端窗口，<br>查看真实文字和后台截图。</p></div>';
    $('#monitor-notice').textContent = '操作组件不会移动你当前的鼠标。';
  }
  layoutController?.refresh();
}
function setTab(value) {
  tab = value; $$('.tab').forEach(el => { el.classList.toggle('active', el.dataset.tab === value); el.setAttribute('aria-selected', String(el.dataset.tab === value)); });
  for (const name of ['chat', 'tasks', 'artifacts', 'settings']) $(`#${name}-pane`).classList.toggle('hidden', value !== name);
  if (value === 'settings') fillSettings();
  layoutController?.refresh();
}
async function fillSettings(force = false) {
  const p = current(), form = $('#settings-form'); if (!p || (!force && form.dataset.projectId === p.id)) return;
  form.dataset.projectId = p.id;
  for (const name of ['title', 'goal', 'freedom', 'maxReworks']) form.elements[name].value = p[name];
  try { const result = await request('/api/desktops'); $('#desktop-select').innerHTML = result.items.map(d => `<option value="${escape(d)}">${d === 'default' ? '当前桌面 · 仅后台控件操作' : `实验桌面 · ${escape(d)}`}</option>`).join(''); }
  catch { $('#desktop-select').innerHTML = '<option value="default">当前桌面 · 操作组件待构建</option>'; }
  form.elements.desktop.value = p.desktop;
}
function newProject(template = 'custom') {
  const presets = { game: ['横版冒险小游戏', '制作一个可在本地浏览器运行的马里奥类横版小游戏。支持移动、跳跃、平台碰撞、收集物、失败重开和胜利条件。自由决定适合首个版本的规模，交付可运行文件和实际检查结果。'], report: ['研究报告', '围绕我指定的主题整理资料、核实主要事实，交付一份结构清晰的研究报告。缺少研究主题时先向我提问。'], custom: ['', ''] };
  const [title, goal] = presets[template];
  showDialog('开始一个项目', `<p class="dialog-note">给出目标。统筹者按你的团队配置安排工作，过程中你随时可以补充想法。</p><form id="new-project-form"><label>项目名称<input name="title" required maxlength="100" placeholder="给这个项目起个名字" value="${escape(title)}"></label><label>任务目标<textarea name="goal" rows="5" required placeholder="想完成什么，最终希望得到什么？">${escape(goal)}</textarea></label><label>自主程度<select name="freedom"><option value="autonomous">自主推进 · 重要缺口再提问</option><option value="creative">自由发挥 · 自行决定方案细节</option><option value="ask">先沟通方案 · 再推进执行</option></select></label>${projectTeamFields()}<div class="dialog-actions"><button type="button" class="secondary" id="new-cancel">取消</button><button class="primary" type="submit">创建项目 ↗</button></div></form>`, () => {
    $('#new-cancel').onclick = closeDialog; wireProjectTeam($('#new-project-form'));
    $('#new-project-form').onsubmit = safe(async event => { event.preventDefault(); const p = await request('/api/projects', { method: 'POST', body: {...Object.fromEntries(new FormData(event.target)),team:readProjectTeam(event.target)} }); closeDialog(); await refresh(); chooseProject(p.id); toast('项目已建立'); });
    $('#new-project-form input').focus();
  });
}
function memberThread(memberId,selectedRound){
  const p=current(),m=projectMembers(p).find(v=>v.id===memberId),rounds=p.rounds||[];
  const selected=selectedRound??(rounds.find(r=>!['completed','cancelled'].includes(r.status))?.id||rounds.at(-1)?.id||'all');
  const messages=p.messages.filter(message=>message.author===memberId&&(selected==='all'||message.roundId===selected||p.tasks.find(t=>t.id===message.taskId)?.roundId===selected));
  const roundSelect=rounds.length?'<label>独立对话<select id="member-round"><option value="all">全部记录</option>'+rounds.map((r,i)=>'<option value="'+escape(r.id)+'" '+(r.id===selected?'selected':'')+'>第 '+(i+1)+' 轮 · '+escape(r.title)+'</option>').join('')+'</select></label>':'';
  showDialog(m.name+' · '+m.role,roundSelect+'<p class="dialog-note">仅显示该成员的真实发言；尚未返回时保持空白，不由统筹代写。</p>'+(messages.length?messages.map(v=>'<div class="thread-item"><time>'+escape(new Date(v.createdAt).toLocaleString('zh-CN'))+'</time>'+escape(v.text)+'</div>').join(''):'<div class="empty-dialog">该对话还没有成员的真实回复。</div>')+'<div class="dialog-actions"><button class="secondary" id="thread-settings">配置团队</button></div>',()=>{if($('#member-round'))$('#member-round').value=selected;if($('#member-round'))$('#member-round').onchange=event=>memberThread(memberId,event.target.value);$('#thread-settings').onclick=teamDialog;});
}
function renderAgentControls(p){
  $('#agent-controls').innerHTML=projectMembers(p).map(m=>`<button type="button" class="agent-control" data-model-member="${m.id}" aria-label="设置 ${escape(m.name)} 的模型和推理程度">${avatar(m)}<span>${escape(m.name)}</span><small>${escape(m.inferenceApplied?.actual||(m.hostSettingReceipt?.status==='submitted'?'下轮参数已提交':m.hostSettingReceipt?.status==='failed'?'设置提交失败':m.inference?.model||m.inference?.effort?'待应用':m.modelCatalog?.current||'客户端当前'))}</small><b>⌄</b></button>`).join('');
  $$('[data-model-member]').forEach(button=>button.onclick=()=>inferenceDialog(button.dataset.modelMember));
}
function inferenceDialog(memberId){
  const m=state.members.find(m=>m.id===memberId),q=m.inference||{},catalog=m.modelCatalog||{};
  const hostModels=['gpt-6.1-sol','gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'];
  const models=m.coordinator?(catalog.models||hostModels):(catalog.models||[]),hostEfforts=model=>catalog.effortsByModel?.[model]||['low','medium','high','xhigh','max',...(!model||/-luna$/.test(model)?[]:['ultra'])],efforts=m.coordinator?hostEfforts(q.model):(catalog.efforts||[]);
  const opts=(values,current,empty)=>`<option value="">${empty}</option>`+[...new Set([...values,...(current?[current]:[])])].map(v=>`<option value="${escape(v)}" ${v===current?'selected':''}>${escape(v)}</option>`).join('');
  showDialog(`${m.name} · 模型与推理`, `<p class="dialog-note">${m.coordinator&&state.coordinatorRuntime?.enabled?'保存后直接用于下一次实际统筹轮次。正在运行的一轮保持原参数；可读取官方运行时的真实可选模型。':m.coordinator?'设置交给专用统筹，通过 Codex 官方任务工具提交下一轮参数。当前轮不能中途切换；提交后请在专用任务发送“继续”，启动下一轮。统筹停止时新设置保持等待。':'从已绑定的官方客户端菜单读取选项。切换期间不发送任务；成员执行或有待核对草稿时，不能切换。'}</p><form id="inference-form"><div class="form-grid"><label>模型<select name="model">${opts(models,q.model,'使用客户端当前模型')}</select></label><label>推理程度<select name="effort">${opts(efforts,q.effort,'使用客户端当前设置')}</select></label></div><p class="field-note">实际状态：${escape(m.inferenceApplied?.actual||(m.coordinator?(state.coordinatorRuntime?.enabled?'将用于下次实际统筹轮次':m.hostSettingReceipt?.status==='submitted'?'下轮参数已提交；请在专用任务发送“继续”':m.hostSettingReceipt?.status==='failed'?'提交失败：'+m.hostSettingReceipt.detail:'等待专用统筹提交设置'):[catalog.current,catalog.currentEffort].filter(Boolean).join(' ')||'尚未回读确认'))}${m.inferenceApplied?.appliedAt?' · '+escape(new Date(m.inferenceApplied.appliedAt).toLocaleString('zh-CN')):''}</p>${m.inferenceError?`<p class="field-note">${escape(m.inferenceError)}</p>`:''}<p class="field-note">附件保存在当前项目的 inputs 目录。Codex 选择相关附件写入任务后，执行成员从本地原文件读取。</p><div class="dialog-actions">${m.coordinator?(state.coordinatorRuntime?.enabled?'<button type="button" id="read-models" class="secondary">读取官方选项</button>':state.coordinatorBinding?`<a class="secondary" href="codex://threads/${escape(state.coordinatorBinding.threadId)}">打开专用统筹 ↗</a>`:''):'<button type="button" id="read-models" class="secondary">读取官方选项</button>'}<button class="primary" type="submit">${m.coordinator?'保存并交给统筹':'保存并应用'}</button></div></form>`,()=>{
    if(m.coordinator)$('#inference-form').elements.model.onchange=event=>{const effort=$('#inference-form').elements.effort,previous=effort.value;effort.innerHTML=opts(hostEfforts(event.target.value),hostEfforts(event.target.value).includes(previous)?previous:'','使用客户端当前设置');};
    if($('#read-models'))$('#read-models').onclick=safe(async()=>{const button=$('#read-models');button.disabled=true;button.textContent='正在读取…';try{await request(`/api/projects/${current().id}/members/${m.id}/model-options`,{method:'POST',body:{}});await refresh();inferenceDialog(m.id);}finally{if(button.isConnected){button.disabled=false;button.textContent='读取官方选项';}}});
    $('#inference-form').onsubmit=safe(async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;button.textContent=m.coordinator?'正在交接…':'正在应用…';try{const inference=Object.fromEntries(new FormData(event.target));await request('/api/members',{method:'POST',body:{id:m.id,inference}});if(!m.coordinator&&(inference.model||inference.effort))await request(`/api/projects/${current().id}/members/${m.id}/apply-model`,{method:'POST',body:{inference}});closeDialog();await refresh();toast(m.coordinator?(state.coordinatorRuntime?.enabled?'设置已保存；下次统筹轮次直接使用':'设置已排队；专用统筹运行时提交下一轮参数'):'设置已保存；实际切换以官方回读为准');}finally{if(button.isConnected){button.disabled=false;button.textContent=m.coordinator?'保存并交给统筹':'保存并应用';}}});
  });
}
function teamDialog() {
  showDialog('客户端与默认团队', `<p class="dialog-note">这里保存客户端连接和默认分工。每个项目的成员与分工可以单独编辑。</p>${state.members.map(m => `<form class="member-edit" data-edit="${m.id}"><div class="member-edit-head">${avatar(m)}<b>${escape(m.name)}</b><small>${m.coordinator?'统筹者':'执行成员'}</small></div><div class="form-grid"><label>成员名称<input name="name" required value="${escape(m.name)}"></label><label>官方客户端<input name="provider" required value="${escape(m.provider)}"></label><label>默认分工<input name="role" required value="${escape(m.role)}"></label><label>备用成员<select name="fallback"><option value="">未设置 · 需要时询问</option>${state.members.filter(v=>v.id!==m.id).map(v=>`<option value="${v.id}" ${m.fallback===v.id?'selected':''}>${escape(v.name)}</option>`).join('')}</select></label></div>${quotaFields(m)}${connectionFields(m)}<button class="secondary" type="submit">保存成员</button></form>`).join('')}<div class="dialog-actions">${current()?'<button class="secondary" id="project-team-edit">编辑当前项目分工</button>':''}<button id="add-member" class="primary">＋ 添加成员</button></div>`,()=>{
    if(current())$('#project-team-edit').onclick=editProjectTeam;
    for(const form of $$('.member-edit')) form.onsubmit=safe(async event=>{
      event.preventDefault();const m=state.members.find(m=>m.id===form.dataset.edit),values=Object.fromEntries(new FormData(form));
      const body={id:m.id,name:values.name,provider:values.provider,role:values.role,fallback:values.fallback||null};
      if(values.quotaRemaining!==''||values.quotaTotal!=='') {
        if(values.quotaRemaining===''||values.quotaTotal==='')throw new Error('请同时填写剩余额度和总额度');
        body.quota={remaining:Number(values.quotaRemaining),total:Number(values.quotaTotal),unit:values.quotaUnit||'次',resetAt:values.quotaReset?new Date(values.quotaReset).toISOString():null};
      } else if(m.quota) body.quota=null;
      if(!m.coordinator)body.connection={autoBind:form.elements.autoBind.checked,autoLaunch:form.elements.autoLaunch.checked,executable:values.executable,arguments:values.clientArguments,desktop:form.elements.isolated.checked?(m.connection?.desktop?.startsWith('AgentDock_')?m.connection.desktop:state.clientDesktop):'default'};
      await request('/api/members',{method:'POST',body});await refresh();toast('默认团队和客户端连接已保存');
    });
    $('#add-member').onclick=()=>showDialog('添加 AI 成员','<form id="member-add"><label>成员名称<input name="name" required placeholder="例如：豆包工作"></label><label>官方客户端<input name="provider" required></label><label>默认分工<input name="role" required></label><div class="dialog-actions"><button class="primary">添加成员</button></div></form>',()=>$('#member-add').onsubmit=safe(async event=>{event.preventDefault();await request('/api/members',{method:'POST',body:Object.fromEntries(new FormData(event.target))});closeDialog();await refresh();teamDialog();}));
  });
}
async function integrationDialog() {
  if(state.coordinatorRuntime?.enabled){const runtime=state.coordinatorRuntime;return showDialog('自动会商统筹', `<p class="dialog-note"><strong>${escape(runtimeLabel(runtime.status))}</strong>${runtime.lastChecked?' · 最近确认 '+escape(new Date(runtime.lastChecked).toLocaleTimeString('zh-CN')):''}</p>${runtime.error?`<p class="dialog-note">${escape(runtime.error)}</p>`:''}<p class="dialog-note">等待成员回复、两分钟没有新消息都不会算掉线。待命时会在下次需要规划时自动唤起。</p><p class="dialog-note">检查连接只确认官方运行时和 ChatGPT 登录，不会发起模型推理、重新派发任务或绑定其他成员。</p><div class="dialog-actions"><button class="primary" id="check-coordinator">检查统筹连接</button></div>`,()=>{$('#check-coordinator').onclick=safe(async()=>{const button=$('#check-coordinator');button.disabled=true;button.textContent='正在检查…';try{await checkCoordinator();integrationDialog();}finally{if(button.isConnected){button.disabled=false;button.textContent='检查统筹连接';}}});});}
  const data = await request('/api/integration');
  showDialog('让 Codex 来统筹', `${state.coordinatorBinding?`<p class="dialog-note">专用任务：${escape(state.coordinatorBinding.title)}。${state.coordinator.connected?'最近收到统筹心跳。':'当前未收到统筹心跳，请进入任务发送“继续”，再回到群聊。'}中断后不会自动唤醒。</p><div class="dialog-actions"><a class="primary" href="codex://threads/${escape(state.coordinatorBinding.threadId)}">打开专用统筹 ↗</a></div>`:''}<p class="dialog-note">工作台已经准备好本地工具。完成下面的一次性接入后，Codex 才能实际领取目标、派发任务和持续交接。此页面不会替你修改全局配置。</p><label>统筹 Skill 位置<pre class="dialog-code">${escape(data.skillPath)}</pre></label><label>Codex 的本地 MCP 配置<pre class="dialog-code">${escape(data.config)}</pre></label><p class="dialog-note">${escape(data.instructions)}</p><pre class="dialog-code">使用 $coordinate-project 连接 AgentDock，领取正在运行的项目目标并自主推进。执行成员只通过官方客户端界面工作。先报告当前接入状态，遇到未绑定窗口、登录或额度不足时说明需要处理什么。</pre><div class="dialog-actions"><button class="secondary" id="copy-config">复制连接配置</button><button class="primary" id="copy-start">复制统筹指令</button></div>`, () => {
    $('#copy-config').onclick = safe(async () => { await navigator.clipboard.writeText(data.config); toast('已复制连接配置'); });
    $('#copy-start').onclick = safe(async () => { await navigator.clipboard.writeText('使用 $coordinate-project 连接 AgentDock，领取正在运行的项目目标并自主推进。执行成员只通过官方客户端界面工作。先报告当前接入状态。'); toast('已复制统筹指令'); });
  });
}
async function checkCoordinator(){try{await request('/api/coordinator/check',{method:'POST',body:{}});await refresh();toast('Codex 官方连接与登录已确认；没有重发任务');}catch(error){await refresh().catch(()=>{});toast(error.message,true);}}
async function bindWindow() {
  const p = current(), memberId = $('#monitor-member').value, m = state.members.find(v => v.id === memberId);
  showDialog(`绑定 ${m.name} 的官方窗口`, '<p class="dialog-note">正在读取当前本地桌面的可见窗口…</p>');
  const result = await request(`/api/windows?desktop=${encodeURIComponent(p.desktop)}`);
  const windows = result.windows.filter(w => !/共作 · AgentDock/i.test(w.title));
  showDialog(`绑定 ${m.name} 的官方窗口`, `<p class="dialog-note">选择正在使用的官方会话窗口。绑定不会发送消息。当前桌面：${escape(result.desktop)}</p>${windows.length ? windows.map(w => `<button class="window-choice" data-window="${w.id}"><b>${escape(w.title)}</b><small>${escape(w.executable || w.className)} · PID ${w.pid}</small></button>`).join('') : '<div class="empty-dialog">这个桌面还没有可绑定窗口。<br>先打开官方客户端，或在实验桌面启动应用。</div>'}`, () => {
    $$('[data-window]').forEach(button => button.onclick = safe(async () => { const window = windows.find(w => w.id === Number(button.dataset.window)); await request('/api/members', { method: 'POST', body: { id: m.id, window, bindingDesktop:p.desktop } }); closeDialog(); await refresh(); toast(`${m.name} 已绑定窗口`); await observeWindow(); }));
  });
}
async function observeWindow() {
  if (loading) return; const p = current(); if (!p) return;
  loading = true; $('#refresh-monitor').disabled = true;
  try { const memberId = $('#monitor-member').value; observation = await tool('dock_observe', { projectId: p.id, memberId }); observedMember = memberId; renderScreen(); }
  finally { loading = false; $('#refresh-monitor').disabled = false; }
}
function elementsDialog() {
  if (!observation || observedMember !== $('#monitor-member').value) return toast('请先刷新所选成员的窗口观察', true);
  showDialog('真实窗口控件', `<p class="dialog-note">观察时间：${escape(observation.createdAt)}。控件操作依赖这次观察，过期后需要刷新。登录和密码字段由你接管。</p>${observation.elements.map(e => `<div class="ui-element"><div class="element-title"><code>#${e.index} · ${escape(e.type)}</code><b>${escape(e.name || e.automationId || '未命名控件')}</b>${e.canSetValue ? `<button data-set="${e.index}">后台填写</button>` : ''}${e.canInvoke ? `<button data-invoke="${e.index}">后台点击</button>` : ''}</div>${e.value ? `<pre>${escape(e.value)}</pre>` : ''}</div>`).join('') || '<div class="empty-dialog">该客户端没有暴露可读控件，请人工接管。</div>'}`, () => {
    $$('[data-set]').forEach(button => button.onclick = () => { const index = Number(button.dataset.set); showDialog('填写官方窗口输入框', `<form id="element-set"><label>要填写的内容<textarea name="value" rows="5" required></textarea></label><p class="field-note">仅填写，不自动发送。项目需要处于运行状态。</p><div class="dialog-actions"><button class="primary">填写输入框</button></div></form>`, () => $('#element-set').onsubmit = safe(async event => { event.preventDefault(); const result = await tool('dock_ui_action', { projectId: current().id, memberId: observedMember, observationId: observation.observationId, elementIndex: index, action: 'set_value', value: new FormData(event.target).get('value') }); observation = result.observation; renderScreen(); elementsDialog(); })); });
    $$('[data-invoke]').forEach(button => button.onclick = safe(async () => { const result = await tool('dock_ui_action', { projectId: current().id, memberId: observedMember, observationId: observation.observationId, elementIndex: Number(button.dataset.invoke), action: 'invoke' }); observation = result.observation; renderScreen(); elementsDialog(); }));
  });
}
function taskDialog() {
  showDialog('添加工作任务', `<form id="task-create"><label>任务名称<input name="title" required></label><label>工作流阶段<select name="stage">${stages.map(stage=>`<option value="${stage.id}" ${stage.id==='execution'?'selected':''}>${stage.label}</option>`).join('')}</select></label><label>具体要求<textarea name="description" rows="3" required></textarea></label><div class="form-grid"><label>负责成员<select name="assignee">${projectMembers(current()).map(m => `<option value="${m.id}">${escape(m.name)} · ${escape(m.role)}</option>`).join('')}</select></label><label>产物相对路径<input name="output" placeholder="例如 game/index.html"></label></div><label>验收标准<textarea name="acceptance" rows="3" required placeholder="用什么实际结果判断完成？"></textarea></label><div class="dialog-actions"><button class="primary">建立任务</button></div></form>`, () => $('#task-create').onsubmit = safe(async event => { event.preventDefault(); await request(`/api/projects/${current().id}/tasks`, { method: 'POST', body: Object.fromEntries(new FormData(event.target)) }); closeDialog(); await refresh(); toast('任务已建立'); }));
}
$('#new-project').onclick = () => newProject(); $('#welcome-new').onclick = () => newProject(); $$('.starter').forEach(el => el.onclick = () => newProject(el.dataset.template));
$('#dialog-close').onclick = closeDialog; $('#dialog').addEventListener('click', event => { if (event.target === $('#dialog')) { const r = $('#dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); } });
$$('.tab').forEach(el => el.onclick = () => setTab(el.dataset.tab));
$('#edit-team').onclick = teamDialog; $('#integration').onclick = safe(integrationDialog); $('#open-integration').onclick = safe(integrationDialog);
$('#run-project').onclick = safe(async () => { const p = current(); await request(`/api/projects/${p.id}/${p.status === 'running' ? 'pause' : 'run'}`, { method: 'POST', body: {} }); await refresh(); toast(p.status === 'running' ? '项目已暂停，新操作已停止' : '目标已加入统筹待办'); });
$('#export-project').onclick = () => { window.location.href = `/api/projects/${current().id}/export`; };
$('#project-actions').onclick = projectActions; $('#project-trash').onclick = projectTrash;
$('#composer').onsubmit = safe(async event => {
  event.preventDefault(); const text = $('#message-input').value.trim(), projectId = current()?.id;
  const attachmentIds=attachments?.ids(projectId)||[], mode=$('#message-mode').value;
  if ((!text&&!attachmentIds.length) || !projectId || sending) return;
  if(attachments?.uploading(projectId))return toast('附件仍在上传，请稍后发送');
  if (pendingSend?.text !== text || pendingSend?.projectId !== projectId||JSON.stringify(pendingSend?.attachmentIds)!==JSON.stringify(attachmentIds)||pendingSend?.mode!==mode) pendingSend = { projectId, text,attachmentIds,mode, requestId: crypto.randomUUID() };
  const requestBody = pendingSend; sending = { projectId }; renderActivity();
  try {
    await request(`/api/projects/${projectId}/messages`, { method: 'POST', body: { text,attachmentIds,mode, requestId: requestBody.requestId } });
    attachments?.clear(projectId,attachmentIds);
    pendingSend = null;
    if (current()?.id === projectId && $('#message-input').value.trim() === text) $('#message-input').value = '';
    await refresh(); if (current()?.id === projectId) $('#messages').scrollTop = $('#messages').scrollHeight;
  } finally { sending = null; renderActivity(); }
});
$('#message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } };
$('#add-task').onclick = taskDialog; $('#bind-window').onclick = safe(bindWindow); $('#refresh-monitor').onclick = safe(observeWindow); $('#inspect-text').onclick = elementsDialog;
$('#monitor-member').onchange = renderScreen;
function monitorOpen(open) { $('.monitor').classList.toggle('mobile-open', open); $('#toggle-monitor').setAttribute('aria-expanded', String(open)); $('#toggle-monitor').textContent = open ? '收起监视' : '监视'; layoutController?.refresh(); }
$('#toggle-monitor').onclick = () => monitorOpen(!$('.monitor').classList.contains('mobile-open'));
const monitorClose = document.createElement('button'); monitorClose.className = 'icon-button mobile-monitor-close'; monitorClose.setAttribute('aria-label', '关闭监视'); monitorClose.textContent = '×'; $('.monitor-heading').append(monitorClose); monitorClose.onclick = () => monitorOpen(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#dialog').open) monitorOpen(false); });
$('#take-over').onclick = safe(async () => { await request(`/api/projects/${current().id}/pause`, { method: 'POST', body: {} }); await refresh(); toast('项目已暂停。请在官方客户端自行接管；已运行的任务需要在那里处理。'); });
$('#enter-desktop').onclick = () => showDialog('进入工作桌面', '<p class="dialog-note">将暂时切换当前屏幕到本项目的独立桌面。AI 的操作与观察会暂停，你可以自行处理登录、文件夹信任等客户端确认。</p><p class="dialog-note">完成后点击工作桌面左上角的“返回我的桌面”。窗口会保留，10 分钟后也会自动返回。已在客户端运行的任务仍可能继续执行。</p><div class="dialog-actions"><button class="secondary" id="desktop-cancel">取消</button><button class="primary" id="desktop-enter">进入工作桌面</button></div>', () => {
  $('#desktop-cancel').onclick = closeDialog;
  $('#desktop-enter').onclick = safe(async () => { await request(`/api/projects/${current().id}/takeover`, {method:'POST',body:{}}); closeDialog(); await refresh(); toast('人工接管已开始，使用左上角按钮返回'); });
});
$('#settings-form').onsubmit = safe(async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.target)); values.maxReworks = Number(values.maxReworks); await request(`/api/projects/${current().id}`, { method: 'PATCH', body: values }); await refresh(); toast('项目设置已保存'); });
$('#create-desktop').onclick = safe(async () => { const result = await request('/api/desktops', { method: 'POST', body: {} }); await request(`/api/projects/${current().id}`, { method: 'PATCH', body: { desktop: result.name } }); await refresh(); await fillSettings(true); toast('实验桌面已建立。客户端兼容性需要逐个验证。'); });
$('#launch-desktop').onclick = () => {
  if (current().desktop === 'default') return toast('请先创建并选择实验桌面', true);
  showDialog('在本地实验桌面启动应用', `<p class="dialog-note">应用仍在你的电脑上运行，可以访问本地项目。部分客户端会复用已打开的进程，实际窗口可能仍在原桌面，需要核实。</p><form id="desktop-launch"><label>启动后自动绑定给<select name="memberId">${projectMembers(current()).filter(m=>!m.coordinator).map(m=>`<option value="${m.id}">${escape(m.name)}</option>`).join('')}</select></label><label>官方客户端或验证应用的程序路径<input name="executable" required placeholder="C:\\…\\app.exe"></label><label>启动参数（可选）<input name="arguments" placeholder="留空即可"></label><div class="dialog-actions"><button class="primary">启动应用</button></div></form>`, () => $('#desktop-launch').onsubmit = safe(async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.target)); const result = await request('/api/desktop/launch', { method: 'POST', body: { projectId: current().id, ...values } }); closeDialog(); toast(result.queued?'正在启动并自动绑定已配置的客户端':`应用已启动，PID ${result.pid}。请绑定并核实窗口。`); }));
};
const events = new EventSource('/api/events');
let connectionTimer;
const refreshFailure=error=>problems.connectionFailed(error.message);
events.addEventListener('change', () => refresh().catch(refreshFailure));
events.addEventListener('activity', event => { if (!state) return; try { state.activities = JSON.parse(event.data).activities; renderActivity(); } catch { /* A later state refresh can recover malformed events. */ } });
events.onopen = () => { clearTimeout(connectionTimer);$('#connection').className = 'connection'; $('#connection').textContent = '本地已连接';refresh().catch(refreshFailure); };
events.onerror = () => { $('#connection').className = 'connection offline'; $('#connection').textContent = '正在重连';clearTimeout(connectionTimer);connectionTimer=setTimeout(()=>refresh().catch(refreshFailure),4000); };
refresh().catch(refreshFailure);
setInterval(() => refresh().catch(refreshFailure), 30000);


$('#edit-project-team').onclick=editProjectTeam;
layoutController = initResizableWorkspace({app:$('.app')});
attachments=attachmentComposer({form:$('#composer'),getProject:current,onChange:()=>{renderActivity();layoutController?.refresh();},onError:text=>toast(text,true)});

function renderActivity() {
  const p = current(), element = $('#execution-activity');
  const progress = sending && sending.projectId === p?.id ? { title: '正在发送目标', detail: '提交给 Codex 讨论、规划与分工', spinning: true } : state ? projectProgress(p, state) : null;
  const sendButton = $('.send'),uploading=attachments?.uploading(p?.id),busy = String(!!sending||!!uploading);
  if (sendButton.dataset.busy !== busy) { sendButton.dataset.busy = busy; sendButton.disabled = !!sending||!!uploading; sendButton.innerHTML = sending||uploading ? '<span class="activity-spinner" aria-hidden="true"></span>' : '↑'; }
  const key = JSON.stringify([p?.id, progress]); if (key === activityKey) return; activityKey = key;
  element.classList.toggle('hidden', !progress);
  if (progress) element.innerHTML = `${progress.spinning ? '<span class="activity-spinner" aria-hidden="true"></span>' : `<span class="activity-mark" aria-hidden="true">${progress.status === 'error' ? '!' : '◌'}</span>`}<div><b>${escape(progress.title)}</b>${progress.detail ? `<small>${escape(progress.detail)}</small>` : ''}${/统筹/.test(progress.title)&&!state.coordinator.connected?'<button type="button" class="resume-coordinator">连接并继续统筹 ↗</button>':''}</div>`;
  else element.innerHTML = '';
  const resume=element.querySelector('.resume-coordinator');if(resume)resume.onclick=safe(integrationDialog);
  layoutController?.refresh();
}
setInterval(renderActivity, 500);
