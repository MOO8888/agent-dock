import fs from 'node:fs';
import path from 'node:path';
import { executeTool } from './tools.mjs';
import { taskPrompt } from './store.mjs';

const closed = task => ['done', 'cancelled'].includes(task.status);
const normalize = text => (text || '').replaceAll('\r\n', '\n').replace(/\n+$/, '');

// Select only known composer/send controls from the current official UI observation.
export function composerControls(observation) {
  if (observation.partial) throw new Error('窗口控件未完整读回，请等待重新观察');
  const usable = element => element.enabled !== false && element.offscreen !== true && !element.password;
  if (observation.elements.some(e=>usable(e)&&e.type==='Button'&&(/^(停止生成|停止回答|停止响应|停止任务)$/.test(e.name||'')||/stop-msg|stop-response/.test(e.className||'')))) throw new Error('官方客户端仍在执行任务，请等它结束后再继续');
  const inputs = observation.elements.filter(e => e.canSetValue && usable(e) && /(^|\s)ProseMirror(\s|$)/.test(e.className || ''));
  if (inputs.length !== 1) throw new Error('没有唯一可用的输入框，需要统筹者核对客户端');
  const buttons = observation.elements.filter(e => e.type === 'Button' && e.canInvoke && usable(e) && (/^(发送|发送消息|Send)$/i.test(e.name || '') || /g-send-msg-btn-bg/.test(e.className || '')));
  if (buttons.length > 1) throw new Error('发送按钮不唯一，已停止自动派发');
  return { input: inputs[0], send: buttons[0] };
}

export function freshReply(observation, task) {
  const input = observation.elements.find(e => e.canSetValue && /(^|\s)ProseMirror(\s|$)/.test(e.className || ''));
  const promptRows = observation.elements.filter(e => e.type === 'Text' && (e.name || '').startsWith(`【AgentDock 任务 ${task.id}】`));
  if (!input || !promptRows.length) return '';
  const start = promptRows.at(-1).index;
  const footer = observation.elements.find(e=>e.index>start&&e.index<input.index&&e.type==='Button'&&(/^(本地电脑|上下文用量|按需确认)$/.test(e.name||'')||/permissionModeTrigger/.test(e.className||'')));
  const rows = observation.elements.filter(e => e.type === 'Text' && e.index > start && e.index < (footer?.index||input.index) && e.name?.trim());
  let reply=rows.map(e => e.name.trim()).filter((line, index, all) => index === 0 || line !== all[index - 1]).join('\n');
  const marker=`【AgentDock 完成 ${task.id}】`,end=reply.indexOf(marker);
  if(end>=0)reply=reply.slice(0,end+marker.length);
  return reply.slice(-18000);
}

export class AutomaticExecution {
  constructor(store, native, { interval = 5000, timer = true } = {}) {
    this.store = store; this.native = native; this.busy = false; this.stopped = false;
    this.lastObservation = new Map();
    this.schedule = () => { if (!this.busy && !this.stopped) queueMicrotask(() => this.tick().catch(() => {})); };
    store.on('change', this.schedule);
    if (timer) { this.timer = setInterval(this.schedule, interval); this.timer.unref(); }
  }
  status(project, phase, detail, extra = {}) {
    const next = { ...project.execution, ...extra, phase, detail };
    if (JSON.stringify(next) !== JSON.stringify(project.execution)) { project.execution = next; this.store.save(); }
  }
  wake(projectId) {
    const p = this.store.project(projectId);
    for (const task of p.tasks) if (task.fast && !closed(task)) { task.fast.suspended = false; task.fast.readbacks = 0; }
    const task = p.tasks.find(t => t.fast && !closed(t) && t.status !== 'review');
    this.status(p, task?.dispatch?.status === 'sent' ? 'working' : 'coordinator', task ? '正在核对已有任务状态' : '目标已收到，等待 Codex 规划并编写任务提示词');
    this.schedule();
  }
  async tick() {
    if (this.busy || this.stopped || this.store.state.projects.some(p => p.takeover?.active)) return;
    const p = this.store.state.projects.find(p => p.status === 'running'); if (!p) return;
    this.busy = true;
    let activeTask;
    try {
      const message = p.inbox.find(item => item.type === 'user.message' && item.autoStart && !item.acknowledged);
      const candidates=p.tasks.filter(t=>t.fast&&!closed(t)&&t.status!=='review'&&!t.fast.suspended);
      let task = candidates.find(t=>t.kind==='consultation'&&!t.dispatch&&t.coordination?.automatic) || candidates.find(t=>t.dispatch&&!t.fast.waitingForUser) || candidates.find(t=>t.coordination?.automatic&&!t.fast.waitingForUser&&t.dependsOn.every(id=>this.store.task(p.id,id)[1].status==='done')) || candidates[0];
      activeTask=task;
      if (task?.fast.waitingForUser) {
        if (message) this.status(p, 'coordinator', '群聊答复已收到，等待 Codex 更新方案与续办任务');
        return;
      }
      if (!task && message) {
        this.status(p, 'coordinator', '等待 Codex 讨论方案、编写提示词并分工；用户原话不会直接转发给执行成员'); return;
      }
      if (!task) return;
      if (task.fast.suspended) return;
      if (task.dispatch?.status === 'sent') return await this.observeReply(p, task);
      if(message && Date.parse(message.createdAt)>Date.parse(task.createdAt)) { this.status(p,'coordinator','收到新的要求，等待 Codex 更新任务后派发'); return; }
      if (task.coordination?.source !== 'codex' || !task.coordination.automatic) {
        this.status(p, 'coordinator', '旧任务尚未发送，等待 Codex 重新规划后派发'); return;
      }
      if (task.dependsOn.some(id => this.store.task(p.id,id)[1].status !== 'done')) return;
      const occupied = [...this.store.state.projects,...this.store.state.deletedProjects].some(project=>project.tasks.some(other=>other.id!==task.id&&other.assignee===task.assignee&&!closed(other)&&other.status!=='review'&&!other.fast?.waitingForUser&&other.dispatch));
      if (occupied) { this.status(p,'queued','执行成员尚有未结束任务，等待交接'); return; }
      const member=this.store.member(task.assignee);
      if (!p.desktop.startsWith('AgentDock_') || member.connection?.desktop !== p.desktop || !member.connection?.autoBind) { this.status(p,'blocked','自动派发需要已绑定的共作独立工作桌面'); return; }
      if (task.dispatch && !(task.dispatch.status === 'prepared' || (task.dispatch.status === 'unknown' && task.dispatch.phase === 'filling'))) {
        this.status(p, 'blocked', '派发结果需要核实，自动流程不会重复发送'); return;
      }
      if (task.fast.readbacks >= 10) { this.status(p, 'blocked', '草稿回读仍未匹配，请在查看控件中核对；没有重复输入'); return; }
      if(p.execution?.taskId!==task.id) this.status(p,'queued','Codex 已规划任务，正在准备发送',{mode:'coordinated',taskId:task.id});
      await this.dispatch(p, task);
    } catch (error) { if (activeTask) {activeTask.fast.suspended = true;activeTask.fast.error=error.message;}this.status(p, 'blocked', error.message); }
    finally {
      this.busy = false;
      if (!this.stopped && p.status === 'running' && p.execution?.phase === 'reading') {
        const readbacks = p.execution.readbacks || 0;
        clearTimeout(this.retryTimer); this.retryTimer = setTimeout(this.schedule, Math.min(4000, 250 * 2 ** Math.min(readbacks, 5))); this.retryTimer.unref();
      }
    }
  }
  async dispatch(p, task) {
    const member = this.store.member(task.assignee);
    if(member.configurationBusy){this.status(p,'queued','正在应用成员模型设置，任务稍后发送');return;}
    if (!member.window || ['login','quota','error'].includes(member.status)) throw new Error(`${member.name} 需要处理绑定、登录或额度`);
    if(!task.dispatch&&this.native.ensureSession)await this.native.ensureSession(p,task,member);
    if(!task.dispatch&&this.native.ensureInference)await this.native.ensureInference(p.id,task);
    let observation = await this.native.observe(member, p.desktop, { screenshot: false });
    if (p.status !== 'running' || p.takeover?.active || this.stopped) return;
    let controls = composerControls(observation);
    if (!task.dispatch) {
      if (controls.input.value?.trim()) throw new Error('官方输入框已有草稿，已保留它；请处理后再继续');
      if (taskPrompt(p,task).length > 7900) throw new Error('任务要求较长，等待统筹者拆分后再派发');
      try {
        const typed = await executeTool('dock_prepare_dispatch', { projectId: p.id, taskId: task.id, observationId: observation.observationId, inputIndex: controls.input.index }, this.store, this.native);
        observation = typed.observation; controls = composerControls(observation);
      } catch (error) {
        // Delayed readback is retried by observing only. Never type the same draft twice.
        if (task.dispatch?.status === 'unknown' && task.dispatch.phase === 'filling') { task.fast.readbacks++; this.status(p, 'reading', '已输入一次，正在等待完整草稿回读', {readbacks:task.fast.readbacks}); return; }
        throw error;
      }
    }
    if (normalize(controls.input.value) !== normalize(task.dispatch.prompt)) { task.fast.readbacks++; this.status(p, 'reading', '正在核对已输入草稿，未重复填写', {readbacks:task.fast.readbacks}); return; }
    if (!controls.send) { task.fast.readbacks++; this.status(p, 'reading', '草稿已核对，等待官方发送按钮出现', {readbacks:task.fast.readbacks}); return; }
    await executeTool('dock_dispatch', { projectId: p.id, taskId: task.id, observationId: observation.observationId, inputIndex: controls.input.index, sendIndex: controls.send.index }, this.store, this.native);
    delete task.fast.error;
    task.fast.dispatchedAt = new Date().toISOString();
    this.status(p, 'working', `${member.name} 已收到任务，等待真实回复`, { dispatchedAt: task.fast.dispatchedAt });
  }
  async observeReply(p, task) {
    const last = this.lastObservation.get(task.id) || 0;
    if (Date.now() - last < 8000) return;
    this.lastObservation.set(task.id, Date.now());
    const member = this.store.member(task.assignee), observation = await this.native.observe(member, p.desktop, { screenshot: false });
    if (p.status !== 'running' || p.takeover?.active || this.stopped) return;
    if(task.fast.error){delete task.fast.error;this.store.save();}
    const reply = freshReply(observation, task);
    const done = reply.includes(`【AgentDock 完成 ${task.id}】`);
    const question = reply.includes(`【AgentDock 提问 ${task.id}】`);
    if (!done && !question) { this.status(p, 'working', `${member.name} 正在处理任务`, { observedAt: observation.createdAt, excerpt: reply.slice(-160) }); return; }
    // Import observed text, not invented model messages. Quality verification remains explicit.
    this.store.postWorker(p.id, { memberId: member.id, text: reply, taskId: task.id, kind:question&&!done?'question':'message', evidence: { type: 'official-ui', memberId: member.id, observationId: observation.observationId, windowTitle: observation.window.title, capturedAt: observation.createdAt, rawText: observation.text, extraction: 'current-task-text-nodes' } });
    if(task.kind==='consultation'){
      this.store.updateTask(p.id,task.id,{status:'done',note:'官方会话中的职责评议已收集，执行尚未开始。',evidence:[{type:'official-ui',observationId:observation.observationId,detail:reply}]});
      this.status(p,'consulting','已收集成员意见，等待统筹汇总',{excerpt:''});return;
    }
    if (question && !done) {
      task.fast.waitingForUser = true;
      this.store.updateTask(p.id,task.id,{status:'waiting'});
      this.status(p,'waiting_user',`${member.name} 已在群聊提问，等待你的答复`,{excerpt:''});return;
    }
    let files = 0;
    const scan = relative => {
      if (files >= 30) return;
      const location = this.store.safePath(p, relative); if (!fs.existsSync(location)) return;
      for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) scan(child);
        else if (entry.isFile() && files++ < 30) this.store.registerArtifact(p.id, { relative: child, author: member.id, description: 'Codex 规划任务的实际产物；质量等待验收。' });
      }
    };
    if(task.fast.outputDirectory)scan(task.fast.outputDirectory);
    this.store.updateTask(p.id, task.id, { status: 'review', note: '真实回复已回传，新成果已收集，等待检验。' });
    this.status(p, 'delivered', '真实回复已回传，成果等待检验', { excerpt: '', finishedAt: new Date().toISOString() });
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.retryTimer); this.store.off('change', this.schedule); }
}
