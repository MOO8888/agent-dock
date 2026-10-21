import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { validateConnection } from './connections.mjs';
import { Activity } from './activity.mjs';
import {validateInference} from './preferences.mjs';
import {validateHostInference,queueHostSettings} from './coordinator.mjs';
import {replaceState} from './persistence.mjs';

export class DockError extends Error {
  constructor(message, code = 'invalid_request', status = 400) { super(message); this.code = code; this.status = status; }
}
const id = prefix => `${prefix}_${randomUUID().slice(0, 12)}`;
const now = () => new Date().toISOString();
const required = (v, label, max = 20000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new DockError(`${label}不能为空，且不能超过 ${max} 字符`);
  return v.trim();
};
const taskStates = new Set(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']);
const closed = t => ['done', 'cancelled'].includes(t.status);

export function taskPrompt(project, task) {
  // One line also works with directed character input. JSON escaping preserves
  // multiline requirements/code without sending an Enter key to a chat composer.
  const round=project.rounds?.find(r=>r.id===task.roundId);
  const details = { 项目: project.title, 总目标: round?.refinedGoal||round?.goal||project.goal, 你的任务: task.title, 要求: task.description,
    本地工作目录: project.workspace, 产物位置: task.kind==='consultation'?'仅在当前会话发表评议，不写文件':task.output || '在本地工作目录内选择清晰的文件名', 验收标准: task.acceptance };
  const role=project.team?.find(e=>e.memberId===task.assignee)?.role;if(role)details.你的项目分工=role;
  if(task.attachments?.length)details.参考附件=task.attachments.map(file=>({文件名:file.name,本地路径:path.join(project.workspace,file.relative),SHA256:file.sha256}));
  if(task.inference?.model||task.inference?.effort)details.执行设置={模型:task.inference.model||'客户端当前模型',推理程度:task.inference.effort||'客户端当前设置'};
  if (task.reworks && task.history?.length) details.本轮修正要求 = task.history.at(-1).reason;
  if (task.fast) {
    if(task.kind==='consultation')details.会商规则='本轮只从你的项目职责出发评议：提出必要问题、实现建议、风险或验收建议。没有问题可以明确说明。不要执行、写文件或声称已经做完。评议完成也使用下方完成标记，以便统筹收集各方意见。';
    details.回传格式 = task.kind==='consultation'?`列出你本职责的必要问题、建议和风险，没有问题可明确写无。发表评议后回复【AgentDock 完成 ${task.id}】，由统筹汇总，不代表开始或完成执行。`:`缺关键要求时回复【AgentDock 提问 ${task.id}】及问题；完成后报告实际文件和检查结果，最后回复【AgentDock 完成 ${task.id}】。`;
    return `【AgentDock 任务 ${task.id}】${JSON.stringify(details)}`;
  }
  return `【AgentDock 任务 ${task.id}】请完成以下任务（JSON 字符串内的换行已转义）：${JSON.stringify(details)}。遇到阻碍时说明具体原因；完成后报告实际修改的文件、运行或检查结果，不要只报告计划。`;
}

export class Store extends EventEmitter {
  constructor(directory) {
    super(); this.activity = new Activity(); this.directory = path.resolve(directory); fs.mkdirSync(this.directory, { recursive: true });
    this.file = path.join(this.directory, 'state.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      version: 1, revision: 0, projects: [], members: [
        { id: 'codex', name: 'Codex', provider: 'Codex', role: '统筹', coordinator: true, color: '#688976', status: 'unbound', window: null, fallback: null },
        { id: 'trae', name: 'TRAE', provider: 'TRAE', role: '代码执行', coordinator: false, color: '#756ac6', status: 'unbound', window: null, fallback: null },
        { id: 'doubao', name: '豆包', provider: '豆包', role: '构思与检验', coordinator: false, color: '#b78050', status: 'unbound', window: null, fallback: null },
        { id: 'doubao_work', name: '豆包工作', provider: '豆包工作', role: '本地执行', coordinator: false, color: '#ba8856', status: 'unbound', window: null, fallback: null }
      ], activeProjectId: null, coordinator: { connected: false, lastSeen: null, host: null }, audit: []
    };
    // A restarted workbench never silently resumes partially dispatched work.
    let changed = false;
    if (!this.state.deletedProjects) { this.state.deletedProjects = []; changed = true; }
    if(!this.state.clientDesktop) {this.state.clientDesktop=this.state.projects.find(p=>p.desktop?.startsWith('AgentDock_'))?.desktop||`AgentDock_${randomUUID().replaceAll('-','').slice(0,10)}`;changed=true;}
    for(const m of this.state.members) if(!m.coordinator&&!m.connection&&m.window?.executable) {
      const desktop=this.state.projects.filter(p=>p.memberIds?.includes(m.id)&&p.desktop?.startsWith('AgentDock_')).at(-1)?.desktop||'default';
      m.connection={autoBind:true,autoLaunch:false,executable:m.window.executable,arguments:'',desktop,className:m.window.className||'',title:m.window.title||''};changed=true;
    }
    for(const m of this.state.members) if(!m.coordinator&&m.connection?.autoBind&&m.window) {m.connection.windowHint={id:m.window.id,pid:m.window.pid};m.window=null;if(!['quota','login','busy','error'].includes(m.status)){m.status='unbound';m.detail='使用项目时再核对已配置的客户端窗口';}changed=true;}
    for(const m of this.state.members)if(m.configurationBusy){delete m.configurationBusy;changed=true;}
    for (const p of this.state.projects) {
      if(!p.team) { p.team=(p.memberIds||this.state.members.map(m=>m.id)).map(memberId=>({memberId,role:this.member(memberId).role}));changed=true; }
      if (p.status === 'running') { p.status = 'paused'; changed = true; this.addSystem(p, '工作台重新启动，项目进度已保留。恢复前请核实正在执行的任务。'); }
    }
    this.state.coordinator = { connected: false, lastSeen: null, host: null };
    if (changed || !fs.existsSync(this.file)) this.save();
  }
  save() {
    this.state.revision++; const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2)); replaceState(temp, this.file);
    this.emit('change', this.state.revision);
  }
  snapshot() { return { ...structuredClone(this.state), activities: this.activity.snapshot() }; }
  project(projectId) { const p = this.state.projects.find(p => p.id === projectId); if (!p) throw new DockError('项目不存在', 'not_found', 404); return p; }
  member(memberId) { const m = this.state.members.find(m => m.id === memberId); if (!m) throw new DockError('成员不存在', 'not_found', 404); return m; }
  task(projectId, taskId) { const p = this.project(projectId); const t = p.tasks.find(t => t.id === taskId); if (!t) throw new DockError('任务不存在', 'not_found', 404); return [p, t]; }
  team(input) {
    const entries=input??this.state.members.map(m=>({memberId:m.id,role:m.role}));
    if(!Array.isArray(entries)||!entries.length) throw new DockError('请选择项目成员');
    const result=entries.map(entry=>{const m=this.member(entry.memberId);return {memberId:m.id,role:required(entry.role??m.role,'项目分工',100)};});
    if(new Set(result.map(e=>e.memberId)).size!==result.length)throw new DockError('项目成员不能重复');
    if(!result.some(e=>this.member(e.memberId).coordinator))throw new DockError('项目需要包含统筹者');
    return result;
  }
  addSystem(p, text) { p.messages.push({ id: id('msg'), author: 'system', name: '工作台', kind: 'system', text, createdAt: now(), provenance: { type: 'system' } }); }
  log(action, data = {}) { this.state.audit.push({ id: id('event'), action, data, createdAt: now() }); this.state.audit = this.state.audit.slice(-1000); }
  createProject({ title, goal, freedom = 'autonomous', team }) {
    const projectTeam=this.team(team);
    const p = { id: id('project'), title: required(title, '项目名称', 100), goal: required(goal, '项目目标'), freedom, status: 'draft', createdAt: now(), updatedAt: now(), tasks: [], messages: [], artifacts: [], inbox: [], maxReworks: 3, desktop: 'default', memberIds: this.state.members.map(m => m.id) };
    p.workspace = path.join(this.directory, 'projects', p.id, 'workspace'); fs.mkdirSync(p.workspace, { recursive: true });
    p.team=projectTeam;p.memberIds=projectTeam.map(e=>e.memberId);
    const desktops=this.state.members.filter(m=>p.memberIds.includes(m.id)&&m.connection?.autoBind).map(m=>m.connection.desktop).filter(d=>d&&d!=='default');
    if(new Set(desktops).size===1) p.desktop=desktops[0];
    this.addSystem(p, '项目已建立。真实成员回复和操作记录会显示在这里。');
    this.state.projects.push(p); this.log('project.created', { projectId: p.id }); this.save(); return structuredClone(p);
  }
  updateProject(projectId, changes) {
    const p = this.project(projectId), validated = {};
    for (const key of ['title', 'goal']) if (key in changes) validated[key] = required(changes[key], key, key === 'title' ? 100 : 20000);
    if ('freedom' in changes) { if (!['autonomous', 'creative', 'ask'].includes(changes.freedom)) throw new DockError('未知的自主模式'); validated.freedom = changes.freedom; }
    if ('maxReworks' in changes) { if (!Number.isInteger(changes.maxReworks) || changes.maxReworks < 0 || changes.maxReworks > 20) throw new DockError('返工上限应为 0 到 20'); validated.maxReworks = changes.maxReworks; }
    if ('desktop' in changes) validated.desktop = required(changes.desktop, '桌面', 100);
    if('team' in changes) { validated.team=this.team(changes.team);validated.memberIds=validated.team.map(e=>e.memberId);if(p.tasks.some(t=>!closed(t)&&!validated.memberIds.includes(t.assignee)))throw new DockError('成员还有未完成任务，请先安排交接再移出项目','member_has_tasks',409); }
    if (validated.goal && validated.goal !== p.goal) { p.inbox.push({ id: id('inbox'), type: 'project.goal_changed', text: validated.goal, createdAt: now(), acknowledged: false }); this.addSystem(p, '项目目标已更新，统筹者需要重新评估受影响的任务。'); }
    Object.assign(p, validated);
    p.updatedAt = now(); this.save(); return structuredClone(p);
  }
  deleteProject(projectId) {
    const p = this.project(projectId);
    if (this.state.projects.some(q => q.takeover?.active)) throw new DockError('请先退出人工接管，再删除项目', 'human_takeover_active', 409);
    if (p.status === 'running') throw new DockError('请先暂停项目，再移入回收站；已在客户端运行的任务需要在那里处理', 'project_running', 409);
    if (p.tasks.some(t => t.dispatch?.status === 'sending')) throw new DockError('任务正在派发，请等待本次操作结束后再删除', 'project_dispatching', 409);
    // Only move the saved record. Client conversations and workspace files stay put.
    p.statusBeforeDelete = p.status; p.deletedAt = now(); p.updatedAt = p.deletedAt;
    this.state.projects = this.state.projects.filter(q => q.id !== p.id);
    this.state.deletedProjects.push(p);
    if (this.state.activeProjectId === p.id) this.state.activeProjectId = null;
    this.log('project.deleted', { projectId: p.id }); this.save(); return structuredClone(p);
  }
  restoreProject(projectId) {
    const p = this.state.deletedProjects.find(q => q.id === projectId);
    if (!p) throw new DockError('回收站中没有这个项目', 'not_found', 404);
    if (this.state.projects.some(q => q.takeover?.active)) throw new DockError('请先退出人工接管，再恢复项目', 'human_takeover_active', 409);
    p.status = p.statusBeforeDelete === 'completed' ? 'completed' : 'paused';
    delete p.deletedAt; delete p.statusBeforeDelete; p.updatedAt = now();
    this.state.deletedProjects = this.state.deletedProjects.filter(q => q.id !== p.id);
    this.state.projects.push(p);
    this.addSystem(p, '项目已从回收站恢复，聊天、任务和本地成果已保留。继续推进前请核实客户端中的任务状态。');
    this.log('project.restored', { projectId: p.id }); this.save(); return structuredClone(p);
  }
  runProject(projectId) {
    const p = this.project(projectId);
    if(this.state.projects.some(q=>q.takeover?.active)) throw new DockError('用户正在人工接管，请先返回原桌面', 'human_takeover_active', 409);
    const other = this.state.projects.find(q => q.id !== p.id && q.status === 'running');
    if (other) throw new DockError(`请先暂停“${other.title}”，第一版同一时间运行一个项目`, 'project_busy', 409);
    if (p.status === 'completed') throw new DockError('已完成项目请先新增任务或修改目标', 'project_completed', 409);
    if (p.status === 'running') return structuredClone(p);
    p.status = 'running'; this.state.activeProjectId = p.id;
    p.inbox.push({ id: id('inbox'), type: 'project.start', text: p.goal, createdAt: now(), acknowledged: false });
    this.addSystem(p, '项目已启动，等待 Codex 领取统筹待办。未连接统筹者时不会自动生成成员回复。');
    this.log('project.started', { projectId: p.id }); this.save(); return structuredClone(p);
  }
  pauseProject(projectId, reason = '用户暂停了项目') {
    const p = this.project(projectId); p.status = 'paused'; this.addSystem(p, reason);
    this.log('project.paused', { projectId: p.id }); this.save(); return structuredClone(p);
  }
  completeProject(projectId, summary) {
    const p = this.project(projectId);
    if (p.inbox.some(item => item.type === 'user.message' && !item.acknowledged)) throw new DockError('还有未处理的用户补充，不能宣布项目完成', 'pending_messages', 409);
    if (!p.tasks.length || p.tasks.some(t => !closed(t))) throw new DockError('仍有未完成任务，不能宣布项目完成', 'unfinished_tasks', 409);
    for (const t of p.tasks.filter(t => t.status === 'done' && t.output)) if (!fs.existsSync(this.safePath(p, t.output))) throw new DockError(`成果已丢失：${t.output}`, 'artifact_missing', 409);
    p.status = 'completed'; this.addSystem(p, required(summary, '交付总结'));
    if (this.state.activeProjectId === p.id) this.state.activeProjectId = null;
    this.log('project.completed', { projectId: p.id }); this.save(); return structuredClone(p);
  }
  inputs(projectId,ids=[]) {
    const p=this.project(projectId);
    if(!Array.isArray(ids)||ids.length>20||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new DockError('附件列表不正确，最多 20 个');
    return ids.map(id=>{const file=p.attachments?.find(a=>a.id===id);if(!file)throw new DockError('附件不属于当前项目','input_not_found',404);const target=this.safePath(p,file.relative);if(!fs.existsSync(target)||createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==file.sha256)throw new DockError('附件已丢失或被修改，请重新上传','input_changed',409);return structuredClone(file);});
  }
  postUser(projectId, text, requestId, attachmentIds=[]) {
    const p = this.project(projectId),attachments=this.inputs(projectId,attachmentIds); text = required(text|| (attachments.length?'请查看附件并规划处理方案。':''), '消息');
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId))) throw new DockError('消息标识不正确');
    const existing = requestId && p.messages.find(m => m.author === 'user' && m.requestId === requestId);
    if (existing) { if (existing.text !== text||JSON.stringify(existing.attachments?.map(a=>a.id)||[])!==JSON.stringify(attachmentIds)) throw new DockError('同一消息标识不能用于不同内容', 'message_conflict', 409); return structuredClone(existing); }
    if (this.state.projects.some(q => q.takeover?.active)) throw new DockError('请先返回原桌面再发送；你的输入仍保留', 'human_takeover_active', 409);
    const other = this.state.projects.find(q => q.id !== p.id && q.status === 'running');
    if (other) throw new DockError(`“${other.title}”正在运行，请先暂停它再发送到此项目`, 'project_busy', 409);
    const wasRunning = p.status === 'running';
    const message = { id: id('msg'), author: 'user', name: '你', kind: 'message', text, ...(attachments.length?{attachments}:{}), ...(requestId ? { requestId } : {}), createdAt: now(), provenance: { type: 'user' } };
    p.messages.push(message); p.inbox.push({ id: id('inbox'), type: 'user.message', text, ...(attachments.length?{attachments}:{}),messageId: message.id, autoStart: true, createdAt: now(), acknowledged: false });
    p.status = 'running'; p.updatedAt = now(); this.state.activeProjectId = p.id;
    if (!wasRunning) { this.addSystem(p, '消息已发送，项目自动开始推进。'); this.log('project.started_by_message', { projectId: p.id, messageId: message.id }); }
    this.save(); return structuredClone(message);
  }
  postCoordinator(projectId, { text, kind = 'message', taskId = null, summaryOf = null }) {
    const p = this.project(projectId);
    if (taskId) this.task(projectId, taskId);
    const m = this.state.members.find(m => m.coordinator);
    const message = { id: id('msg'), author: m.id, name: m.name, kind, text: required(text, '消息'), taskId, createdAt: now(), provenance: { type: summaryOf ? 'coordinator_summary' : 'coordinator', summaryOf } };
    p.messages.push(message); this.save(); return structuredClone(message);
  }
  postWorker(projectId, { memberId, text, taskId, evidence, kind = 'message' }) {
    const p = this.project(projectId), m = this.member(memberId);
    if (!evidence?.observationId || evidence.memberId !== m.id || evidence.type !== 'official-ui') throw new DockError('成员发言需要来自已绑定窗口的真实观察记录', 'missing_provenance', 409);
    if (taskId) this.task(projectId, taskId);
    const message = { id: id('msg'), author: m.id, name: m.name, kind: kind === 'question' ? 'question' : 'message', text: required(text, '成员回复'), taskId, createdAt: now(), provenance: structuredClone(evidence) };
    p.messages.push(message); this.save(); return structuredClone(message);
  }
  createTask(projectId, input) {
    const p = this.project(projectId), m = this.member(input.assignee);
    if(!p.memberIds.includes(m.id))throw new DockError('这位成员未加入当前项目，请先编辑项目分工','member_not_in_project',409);
    const dependsOn = [...new Set(input.dependsOn || [])]; for (const d of dependsOn) this.task(projectId, d);
    const t = { id: id('task'), title: required(input.title, '任务名称', 160), description: required(input.description, '任务要求'), acceptance: required(input.acceptance, '验收标准'), output: input.output || '', assignee: m.id, dependsOn, status: 'queued', attempts: 0, reworks: 0, evidence: [], dispatch: null, createdAt: now(), updatedAt: now() };
    if(input.roundId){if(!p.rounds?.some(r=>r.id===input.roundId))throw new DockError('协作轮次不存在');t.roundId=input.roundId;}
    if(input.kind!==undefined&&!['consultation','work'].includes(input.kind))throw new DockError('任务类型不正确');
    t.kind=input.kind||'work';
    if (input.stage && !['planning','execution','review','delivery'].includes(input.stage)) throw new DockError('未知的工作流阶段');
    t.stage = input.stage || (m.coordinator ? 'planning' : 'execution');
    t.attachments=this.inputs(projectId,input.attachmentIds||[]);
    t.inference=structuredClone(m.inference||{});
    if (input.dispatchMode === 'automatic') {
      if (m.coordinator || (!t.output&&t.kind!=='consultation')) throw new DockError('自动派发需要执行成员和明确的产物路径');
      t.coordination = {source:'codex', automatic:true, plannedAt:now()};
      t.fast = {outputDirectory:t.output?path.posix.dirname(t.output.replaceAll('\\','/')):null,readbacks:0,receivedAt:t.createdAt};
      if (t.output&&t.fast.outputDirectory === '.') throw new DockError('自动任务的产物须放在独立子目录中');
    }
    if (t.output) this.safePath(p, t.output);
    p.tasks.push(t); this.log('task.created', { projectId, taskId: t.id, assignee: m.id }); this.save(); return structuredClone(t);
  }
  updateTask(projectId, taskId, input) {
    const [p, t] = this.task(projectId, taskId);
    if (input.status && !taskStates.has(input.status)) throw new DockError('未知的任务状态');
    if (input.status === 'running') {
      if (p.status !== 'running') throw new DockError('项目未运行，不能开始任务', 'project_paused', 409);
      if (t.dependsOn.some(d => this.task(projectId, d)[1].status !== 'done')) throw new DockError('前置任务尚未完成', 'dependency_pending', 409);
    }
    if (input.evidence && (!Array.isArray(input.evidence) || input.evidence.some(e => !e || typeof e !== 'object' || Array.isArray(e) || !e.type || !(e.detail || e.path || e.artifactId || e.observationId)))) throw new DockError('验收证据需要类型及实际结果或文件引用', 'invalid_evidence');
    const evidence = input.evidence ? [...t.evidence, ...input.evidence] : t.evidence;
    if (input.status === 'done' && !evidence.length) throw new DockError('完成任务需要提供验收证据', 'missing_evidence', 409);
    const finalOutput = input.output ?? t.output;
    if (input.status === 'done' && finalOutput && !fs.existsSync(this.safePath(p, finalOutput))) throw new DockError('任务产物尚未落到本地，不能标为完成', 'artifact_missing', 409);
    if (input.assignee) {this.member(input.assignee);if(!p.memberIds.includes(input.assignee))throw new DockError('负责人需要先加入当前项目','member_not_in_project',409);}
    if (input.output) this.safePath(p, input.output);
    for (const key of ['title', 'description', 'acceptance']) if (key in input) required(input[key], key, key === 'title' ? 160 : 20000);
    if (input.stage && !['planning','execution','review','delivery'].includes(input.stage)) throw new DockError('未知的工作流阶段');
    for (const key of ['title', 'description', 'acceptance', 'output', 'assignee', 'status', 'stage']) if (key in input) t[key] = input[key];
    if (t.output) this.safePath(p, t.output); t.evidence = evidence; t.updatedAt = now();
    if (input.note) this.addSystem(p, `${t.title}：${input.note}`);
    this.log('task.updated', { projectId, taskId, status: t.status }); this.save(); return structuredClone(t);
  }
  prepareDispatch(projectId, taskId, baselineText = '') {
    const [p, t] = this.task(projectId, taskId);
    if (p.status !== 'running') throw new DockError('项目已暂停，派发已停止', 'project_paused', 409);
    if (t.dependsOn.some(d => this.task(projectId, d)[1].status !== 'done')) throw new DockError('前置任务未完成', 'dependency_pending', 409);
    if (t.dispatch && ['sending', 'sent', 'unknown', 'prepared'].includes(t.dispatch.status)) throw new DockError('已有派发记录，请先核实对方会话，避免重复执行', 'duplicate_dispatch', 409);
    const m = this.member(t.assignee);
    if (m.coordinator) throw new DockError('统筹任务由 Codex 通过本地工具执行，不向统筹客户端重复发送', 'coordinator_task', 409);
    if (!m.window) throw new DockError('请先在成员设置里绑定官方客户端窗口', 'window_unbound', 409);
    if (m.status === 'quota' || m.status === 'login') throw new DockError('成员需要处理额度或登录', 'member_unavailable', 409);
    const prompt = taskPrompt(p, t);
    t.dispatch = { id: id('dispatch'), status: 'sending', phase: 'filling', prompt, baselineText, createdAt: now() }; t.attempts++; t.status = 'running';
    this.save(); return { prompt, member: structuredClone(m), task: structuredClone(t) };
  }
  dispatchOutcome(projectId, taskId, status, detail = '') {
    const [p, t] = this.task(projectId, taskId);
    if (!t.dispatch) throw new DockError('没有派发记录');
    t.dispatch.status = status; t.dispatch.detail = detail;
    if (status === 'unknown') { t.status = 'waiting'; this.addSystem(p, t.dispatch.phase==='filling' ? `${t.title}：草稿尚未通过核对，未调用发送按钮；请重新观察，禁止再次填写。` : `${t.title}：派发结果不确定，请查看成员会话后再决定是否重试。`); }
    if (status === 'prepared') t.status = 'waiting';
    if (status === 'failed') t.status = 'queued';
    this.log('task.dispatched', { projectId, taskId, status }); this.save(); return structuredClone(t);
  }
  rework(projectId, taskId, reason) {
    const [p, t] = this.task(projectId, taskId);
    reason = required(reason, '返工原因');
    if (t.reworks >= p.maxReworks) { t.status = 'waiting'; this.addSystem(p, `${t.title} 已达到返工上限，需要用户决定。`); this.save(); return structuredClone(t); }
    (t.history ||= []).push({ at: now(), evidence: structuredClone(t.evidence), dispatch: structuredClone(t.dispatch), reason });
    t.reworks++; t.status = 'queued'; t.dispatch = null; t.evidence = [];
    if(t.fast){t.fast.suspended=false;t.fast.waitingForUser=false;t.fast.readbacks=0;}
    this.addSystem(p, `安排第 ${t.reworks} 次返工：${t.title}。原因：${reason}`); this.save(); return structuredClone(t);
  }
  memberState(memberId, status, detail = '') {
    if (!['ready', 'busy', 'quota', 'login', 'error'].includes(status)) throw new DockError('未知成员状态');
    const m = this.member(memberId); m.status = status; m.detail = detail;
    if (['quota', 'login', 'error'].includes(status)) {
      for (const p of this.state.projects.filter(p => p.status === 'running')) {
        const fallback = m.fallback && this.state.members.find(v => v.id === m.fallback && p.memberIds.includes(v.id) && !['quota', 'login', 'error'].includes(v.status));
        const affected = p.tasks.filter(t => t.assignee === m.id && !closed(t));
        for (const t of affected) {
          // An uncertain or executing dispatch requires a handoff, not an automatic resend.
          if (fallback && (!t.dispatch || t.dispatch.status === 'failed')) { t.assignee = fallback.id; t.status = 'queued'; }
          else t.status = 'waiting';
        }
        this.addSystem(p, `${m.name} ${status === 'quota' ? '额度不足' : status === 'login' ? '需要登录' : '执行异常'}。${fallback ? `备用成员为 ${fallback.name}；已派发任务需要核实后交接。` : '请用户处理或指定备用成员。'} ${detail}`);
      }
    }
    this.log('member.status', { memberId, status }); this.save(); return structuredClone(m);
  }
  saveMember(input) {
    const existing = input.id && this.state.members.find(m => m.id === input.id);
    const m = existing || { id: id('member'), color: '#66849b', coordinator: false, status: 'unbound', window: null, fallback: null };
    const name = required(input.name ?? m.name, '成员名称', 80), provider = required(input.provider ?? m.provider, '客户端名称', 80), role = required(input.role ?? m.role, '角色', 100);
    let connection;
    let quota;
    const inference='inference' in input?validateInference(input.inference):undefined;
    if(inference&&m.coordinator)validateHostInference(inference);
    if ('quota' in input) {
      if (input.quota === null) quota = null;
      else {
        const q=input.quota;
        if (!q || !Number.isFinite(q.remaining) || !Number.isFinite(q.total) || q.total<=0 || q.remaining<0 || q.remaining>q.total) throw new DockError('额度需要有效的剩余量和总量');
        if (q.resetAt && !Number.isFinite(Date.parse(q.resetAt))) throw new DockError('额度重置时间无效');
        quota={remaining:q.remaining,total:q.total,unit:required(q.unit||'次','额度单位',30),resetAt:q.resetAt||null,source:'manual',updatedAt:now()};
      }
    }
    if('connection' in input) { if(m.coordinator)throw new DockError('统筹者通过本地工具连接，不设置客户端自动启动');connection=validateConnection(input.connection,m.connection); }
    if(input.window?.executable&&!m.coordinator&&!connection) connection=validateConnection({autoBind:m.connection?.autoBind??true,executable:input.window.executable,desktop:input.bindingDesktop??m.connection?.desktop??'default',className:input.window.className||'',title:input.window.title||''},m.connection);
    if (input.coordinator === false && m.coordinator && !this.state.members.some(v => v.id !== m.id && v.coordinator)) throw new DockError('至少需要一个统筹者');
    if (input.fallback) { const f = this.member(input.fallback); if (f.id === m.id) throw new DockError('备用成员不能是自己'); let cursor = f; const visited = new Set([m.id]); while (cursor) { if (visited.has(cursor.id)) throw new DockError('备用成员不能形成循环'); visited.add(cursor.id); cursor = cursor.fallback && this.state.members.find(v => v.id === cursor.fallback); } }
    Object.assign(m, { name, provider, role });
    if(inference){m.inference=inference;delete m.inferenceApplied;delete m.inferenceError;if(m.coordinator)queueHostSettings(this,m,inference);}
    if ('quota' in input) m.quota=quota;
    if(connection) {m.connection=connection;}
    for (const key of ['color', 'fallback', 'window', 'profile', 'coordinator']) if (key in input) m[key] = input[key];
    if (m.coordinator) this.state.members.forEach(other => { if (other.id !== m.id) other.coordinator = false; });
    if (m.window && !['quota', 'login', 'error'].includes(m.status)) m.status = 'ready';
    if (!existing) this.state.members.push(m);
    if (!this.state.members.some(v => v.coordinator)) throw new DockError('至少需要一个统筹者');
    this.save(); return structuredClone(m);
  }
  heartbeat(host = 'Codex') { this.state.coordinator = { connected: true, host, lastSeen: now() }; this.save(); return this.snapshot(); }
  inbox(projectId, acknowledge = []) {
    const p = this.project(projectId);
    if (acknowledge.length) { p.inbox.forEach(v => { if (acknowledge.includes(v.id)) v.acknowledged = true; }); this.save(); }
    return structuredClone(p.inbox.filter(v => !v.acknowledged));
  }
  safePath(p, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes(':') || /(^|[\\/])\.\.([\\/]|$)/.test(relative)) throw new DockError('文件路径必须位于项目工作目录内', 'path_outside_workspace');
    const root = fs.realpathSync(p.workspace), target = path.resolve(root, relative);
    if (target === root || !target.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) throw new DockError('文件超出项目目录', 'path_outside_workspace');
    let probe = target;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real.toLowerCase() !== root.toLowerCase() && !real.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) throw new DockError('文件链接指向项目目录外', 'path_outside_workspace');
    return target;
  }
  writeArtifact(projectId, { relative, content, author = 'codex' }) {
    const p = this.project(projectId); this.member(author);
    const file = this.safePath(p, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8'); return this.registerArtifact(projectId, { relative, author });
  }
  registerArtifact(projectId, { relative, author = 'codex', description = '' }) {
    const p = this.project(projectId), file = this.safePath(p, relative); this.member(author);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new DockError('成果文件尚不存在', 'artifact_missing', 404);
    const stat = fs.statSync(file), hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    let artifact = p.artifacts.find(a => a.relative === relative);
    if (!artifact) { artifact = { id: id('artifact'), relative }; p.artifacts.push(artifact); }
    Object.assign(artifact, { author, description, size: stat.size, sha256: hash, updatedAt: now() });
    this.log('artifact.registered', { projectId, relative, sha256: hash }); this.save(); return structuredClone(artifact);
  }
}
