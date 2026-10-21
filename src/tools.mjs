import { DockError, taskPrompt } from './store.mjs';
import { syncTakeovers } from './takeover.mjs';
import {checkInference} from './preferences.mjs';
import { track } from './activity.mjs';
import {bindCoordinator,reportHostSettings} from './coordinator.mjs';

export function definitions() {
  const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
  const string = { type: 'string' }, project = { projectId: string }, task = { ...project, taskId: string };
  return [
    tool('dock_state', '读取工作台项目、任务、成员和真实消息。先调用它发现 ID，不要猜 ID。'),
    tool('dock_connect', '标记当前 Codex 已连接到工作台并读取项目状态。', { host: string }),
    tool('dock_disconnect', '统筹实际结束本轮时清除在线心跳，保留绑定和设置；不会终止官方客户端。', {threadId:string,reason:string}, ['threadId']),
    tool('dock_bind_coordinator', '保存用户已授权的专用 Codex 任务绑定。此操作本身不会唤醒任务。', {threadId:string,title:string}, ['threadId']),
    tool('dock_report_host_settings', '专用统筹通过官方 send_message_to_thread 向自己的任务提交下一轮模型参数后，记录真实成功或失败回执。submitted 仅表示已提交，不证明当前轮模型已改变。', {requestId:string,threadId:string,status:{type:'string',enum:['submitted','failed']},detail:string}, ['requestId','threadId','status','detail']),
    tool('dock_inbox', '领取用户目标和新消息。完成处理后传 acknowledge 确认消息 ID。', { ...project, acknowledge: { type: 'array', items: string } }, ['projectId']),
    tool('dock_wait', '等待项目变化或用户插话，最多 45 秒。没有变化返回当前进度，不生成虚构回复。', { ...project, afterRevision: { type: 'integer' }, timeoutMs: { type: 'integer', minimum: 0, maximum: 45000 } }, ['projectId']),
    tool('dock_message', '发布当前统筹者自己的发言或明确标记的总结。不可冒充其他成员。', { ...project, text: string, kind: string, taskId: string, summaryOf: string }, ['projectId', 'text']),
    tool('dock_progress', '报告统筹者当前实际操作；正在执行时短暂显示转圈，finished 后收起。不能把计划或未观察的成员动作标为执行。', { ...project, taskId:string, phase:{type:'string',enum:['planning','running_code','reading','writing','reviewing','finished']}, detail:string }, ['projectId','phase']),
    tool('dock_create_task', '由 Codex 规划后创建任务。提供具体提示词、验收、产物位置、阶段和要交给成员的附件 ID；automatic 仅代为投递这份已写好的任务。', { ...project, title: string, description: string, acceptance: string, assignee: string, output: string,attachmentIds:{type:'array',items:string}, stage:{type:'string',enum:['planning','execution','review','delivery']},dispatchMode:{type:'string',enum:['manual','automatic']}, dependsOn: { type: 'array', items: string } }, ['projectId', 'title', 'description', 'acceptance', 'assignee']),
    tool('dock_update_task', '根据真实进度更新任务。done 必须带验收证据；暂停项目不能启动任务。', { ...task, status: string, stage:{type:'string',enum:['planning','execution','review','delivery']},note: string, assignee: string, evidence: { type: 'array', items: { type: 'object', additionalProperties: true } } }, ['projectId', 'taskId']),
    tool('dock_rework', '带具体问题安排返工，达到项目上限后等待用户决定。', { ...task, reason: string }, ['projectId', 'taskId', 'reason']),
    tool('dock_member_status', '报告通过官方界面观察到的登录、额度或异常情况。', { memberId: string, status: { type: 'string', enum: ['ready', 'busy', 'quota', 'login', 'error'] }, detail: string }, ['memberId', 'status']),
    tool('dock_observe', '读取已绑定成员的真实官方窗口控件、文字和后台截图。返回 observationId 后才能操作。只检查文字时 screenshot=false 可减少图像消耗。', { memberId: string, ...project, screenshot: { type: 'boolean' } }, ['memberId', 'projectId']),
    tool('dock_ui_action', '对最新观察中的具体控件进行后台填写、点击或选择。没有可操作控件时停止，绝不抢占用户鼠标。', { memberId: string, ...project, observationId: string, action: { type: 'string', enum: ['set_value', 'invoke', 'select'] }, elementIndex: { type: 'integer', minimum: 0 }, value: string }, ['memberId', 'projectId', 'observationId', 'action', 'elementIndex']),
    tool('dock_dispatch_prompt', '生成派发任务的完整提示词供检查，本工具不发消息。', { ...task }, ['projectId', 'taskId']),
    tool('dock_prepare_dispatch', '先填写并核对任务草稿，不发送；适用于填写后才出现发送按钮的客户端。随后重新观察并用 dock_dispatch 发送同一草稿。', { ...task, observationId: string, inputIndex: { type: 'integer', minimum: 0 } }, ['projectId', 'taskId', 'observationId', 'inputIndex']),
    tool('dock_dispatch', '把任务提示词填写到已观察的输入框并点击已观察的发送按钮。结果不确定时禁止自动重发。', { ...task, observationId: string, inputIndex: { type: 'integer' }, sendIndex: { type: 'integer' } }, ['projectId', 'taskId', 'observationId', 'inputIndex', 'sendIndex']),
    tool('dock_import_reply', '从官方窗口真实观察文本导入成员回复。text 必须出现在该观察内。', { ...project, memberId: string, taskId: string, observationId: string, text: string }, ['projectId', 'memberId', 'observationId', 'text']),
    tool('dock_write_file', '把统筹者实际生成的文本文件写入项目工作目录并登记成果。', { ...project, relative: string, content: string }, ['projectId', 'relative', 'content']),
    tool('dock_register_file', '登记项目目录内已经存在的真实成果文件，保存大小和 SHA-256。', { ...project, relative: string, author: string, description: string }, ['projectId', 'relative']),
    tool('dock_pause', '暂停项目，停止新的界面操作；已在官方客户端运行的工作需要单独核实。', { ...project, reason: string }, ['projectId']),
    tool('dock_complete', '全部任务完成且有证据后提交项目交付总结。', { ...project, summary: string }, ['projectId', 'summary'])
  ];
}

export async function executeTool(name, args, store, native) {
  const stages = { dock_observe: '正在读取操作画面', dock_ui_action: args.action === 'set_value' ? '正在输入' : '正在操作客户端', dock_prepare_dispatch: '正在输入任务', dock_dispatch: '正在发送任务', dock_write_file: '正在写入文件', dock_register_file: '正在检查成果', dock_complete: '正在整理交付' };
  if (!stages[name] || !args.projectId) return execute(name, args, store, native);
  let memberId = args.memberId || 'codex', detail = args.value || args.relative || '';
  if (args.taskId) { const [, task] = store.task(args.projectId, args.taskId); memberId = task.assignee; detail = task.title; }
  return track(store, { projectId: args.projectId, taskId: args.taskId, memberId, title: stages[name], detail }, () => execute(name, args, store, native));
}

async function execute(name, args, store, native) {
  const member = () => store.member(args.memberId);
  const running = () => { const p=store.project(args.projectId); if(p.takeover?.active) throw new DockError('用户正在人工接管，AI 操作已停止', 'human_takeover_active', 409); if (p.status !== 'running') throw new DockError('项目已暂停，操作已停止', 'project_paused', 409); };
  switch (name) {
    case 'dock_state': await syncTakeovers(store,native); return store.snapshot();
    case 'dock_connect': await syncTakeovers(store,native); return store.heartbeat(args.host);
    case 'dock_disconnect': {
      if(store.state.coordinatorBinding?.threadId!==args.threadId)throw new DockError('结束状态不属于绑定的统筹任务','host_thread_mismatch',409);
      store.state.coordinator={connected:false,host:store.state.coordinator.host,lastSeen:null,detail:String(args.reason||'统筹已停止，请在专用任务发送“继续”恢复').slice(0,300)};store.save();return store.snapshot();
    }
    case 'dock_bind_coordinator': return bindCoordinator(store,args);
    case 'dock_report_host_settings': return reportHostSettings(store,args);
    case 'dock_inbox': return store.inbox(args.projectId, args.acknowledge);
    case 'dock_wait': {
      if (store.state.revision > (args.afterRevision ?? 0)) return store.snapshot();
      await new Promise(resolve => { const stop = () => { clearTimeout(timer); store.off('change', stop); resolve(); }; const timer = setTimeout(stop, Math.min(45000, Math.max(0, args.timeoutMs ?? 30000))); store.once('change', stop); });
      return store.snapshot();
    }
    case 'dock_message': return store.postCoordinator(args.projectId, args);
    case 'dock_progress': {
      const p=store.project(args.projectId);if(args.taskId)store.task(p.id,args.taskId);
      if(args.phase!=='finished')running();
      const titles={planning:'正在安排任务',running_code:'正在执行代码',reading:'正在读取内容',writing:'正在写入文件',reviewing:'正在检验成果'};
      if(args.phase!=='finished'&&!titles[args.phase])throw new DockError('未知的操作阶段');
      if(args.detail!==undefined&&typeof args.detail!=='string')throw new DockError('操作说明应为文字');
      return {activityId:store.activity.report(p.id,{title:titles[args.phase],detail:args.detail,taskId:args.taskId,finished:args.phase==='finished'})};
    }
    case 'dock_create_task': return store.createTask(args.projectId, args);
    case 'dock_update_task': return store.updateTask(args.projectId, args.taskId, args);
    case 'dock_rework': return store.rework(args.projectId, args.taskId, args.reason);
    case 'dock_member_status': return store.memberState(args.memberId, args.status, args.detail);
    case 'dock_observe': { await syncTakeovers(store,native); const p=store.project(args.projectId); if(p.takeover?.active) throw new DockError('人工接管期间暂停观察，请等用户返回桌面', 'human_takeover_active', 409); return native.observe(member(), p.desktop, { screenshot: args.screenshot !== false }); }
    case 'dock_ui_action': {
      running(); const result = await native.act(member(), args);
      if (result.result.foregroundChanged) store.pauseProject(args.projectId, '操作期间前台窗口发生变化，项目已暂停，请核实是否需要人工接管。');
      return result;
    }
    case 'dock_dispatch_prompt': {
      const [p, t] = store.task(args.projectId, args.taskId);
      return { taskId: t.id, assignee: t.assignee, prompt: taskPrompt(p, t) };
    }
    case 'dock_prepare_dispatch': {
      running(); const [p,t]=store.task(args.projectId,args.taskId), m=store.member(t.assignee);
      const initial=native.checked(m,args.observationId), input=initial.elements[args.inputIndex];
      checkInference(m,t,initial);
      if(initial.partial || !input?.canSetValue || input.password || input.enabled===false || input.offscreen===true) throw new DockError('请选择完整观察中可填写的输入框', 'invalid_controls', 409);
      if(input.value?.trim()) throw new DockError('输入框中已有内容，请先由用户处理草稿，避免覆盖', 'input_not_empty', 409);
      const dispatch=store.prepareDispatch(p.id,t.id,initial.text||'');
      try {
        const typed=await native.act(m,{observationId:args.observationId,action:'set_value',elementIndex:args.inputIndex,value:dispatch.prompt},{readbackTimeoutMs:t.fast?400:6000});
        running();
        if(typed.result.foregroundChanged) { store.pauseProject(p.id,'填写期间前台窗口发生变化，项目已暂停，请核实。'); throw new DockError('前台窗口发生变化，已停止发送', 'foreground_changed', 409); }
        t.dispatch.phase='prepared'; store.dispatchOutcome(p.id,t.id,'prepared','完整草稿已填写并读回；尚未调用发送按钮');
        return typed;
      } catch(e) { store.dispatchOutcome(p.id,t.id,'unknown',e.message); throw e; }
    }
    case 'dock_dispatch': {
      running(); const [p, t] = store.task(args.projectId, args.taskId), m = store.member(t.assignee);
      const initial = native.checked(m, args.observationId);
      checkInference(m,t,initial);
      const originalInput = initial.elements[args.inputIndex], originalSend = initial.elements[args.sendIndex];
      if (!originalInput?.canSetValue || originalInput.password || !originalSend?.canInvoke || originalSend.type !== 'Button') throw new DockError('请选择可填写的输入框和实际发送按钮', 'invalid_controls', 409);
      // A filling-only failure can leave an exact, unsent task draft behind.
      // Recover by sending that verified draft once, without typing it again.
      // The exact legacy message was emitted only from native set_value, before
      // any Invoke call, by earlier versions that did not record the phase.
      const legacyFillFailure = t.dispatch?.phase === undefined && t.dispatch?.detail === '后台填写未在实际输入框中生效，已停止发送；需要客户端适配或人工接管';
      const resume = (t.dispatch?.status === 'prepared' && t.dispatch.phase === 'prepared') || (t.dispatch?.status === 'unknown' && (t.dispatch.phase === 'filling' || legacyFillFailure));
      if (resume && ['quota','login'].includes(m.status)) throw new DockError('成员需要处理额度或登录', 'member_unavailable', 409);
      if (resume && t.dependsOn.some(id=>store.task(p.id,id)[1].status!=='done')) throw new DockError('前置任务未完成', 'dependency_pending', 409);
      if (t.dispatch && ['sending','sent','unknown','prepared'].includes(t.dispatch.status) && !resume) throw new DockError('发送阶段结果需要核实，禁止重复发送', 'duplicate_dispatch', 409);
      const normalize = value => (value || '').replaceAll('\r\n','\n').replace(/\n+$/,'');
      if (resume && (initial.partial || normalize(originalInput.value) !== normalize(t.dispatch.prompt))) throw new DockError('草稿未完整匹配原派发内容，已停止；请先核实', 'dispatch_draft_mismatch', 409);
      if (!resume && originalInput.value?.trim()) throw new DockError('输入框中已有内容，请先由用户处理草稿，避免覆盖', 'input_not_empty', 409);
      // Electron clients can remove the standalone `disabled` CSS token when
      // the composer receives text. Keep the remaining control identity exact.
      const identity = element => JSON.stringify([element.automationId, element.name, element.type,
        (element.className || '').split(/\s+/).filter(token => token && token !== 'disabled').join(' ')]);
      const sendIdentity = identity(originalSend);
      const dispatch = resume ? { prompt:t.dispatch.prompt } : store.prepareDispatch(args.projectId, args.taskId, initial.text || '');
      try {
        const typed = resume ? { observation:initial } : await native.act(m, { observationId: args.observationId, action: 'set_value', elementIndex: args.inputIndex, value: dispatch.prompt });
        running();
        // Refresh indices after filling the input: sendIndex must refer to the same
        // control identity, not a stale position in a changing accessibility tree.
        const before = typed.observation.elements;
        const matches = before.filter(element => identity(element) === sendIdentity && element.canInvoke && element.type === 'Button' && element.enabled !== false && element.offscreen !== true);
        if (matches.length !== 1) throw new DockError('发送控件发生变化或不唯一，请重新观察并核实', 'send_control_changed', 409);
        t.dispatch.phase='invoking'; t.status='running'; store.save();
        const sent = await native.act(m, { observationId: typed.observation.observationId, action: 'invoke', elementIndex: matches[0].index });
        if (sent.result.foregroundChanged) store.pauseProject(p.id, '发送期间前台窗口发生变化，项目已暂停，请核实是否需要人工接管。');
        t.dispatch.phase='invoked'; store.dispatchOutcome(p.id, t.id, 'sent', '官方客户端发送按钮已调用，等待真实回复'); return sent;
      } catch (e) { store.dispatchOutcome(p.id, t.id, 'unknown', e.message); throw e; }
    }
    case 'dock_import_reply': {
      const m = member(), o = native.checked(m, args.observationId);
      const normalize = s => s.replace(/\s+/g, ' ').trim();
      if (!normalize(o.text).includes(normalize(args.text)) || normalize(args.text).length < 3) throw new DockError('回复原文未出现在所选窗口观察中，无法标为成员真实发言', 'reply_not_observed', 409);
      if (args.taskId) {
        const [, task] = store.task(args.projectId, args.taskId);
        if (task.assignee !== m.id) throw new DockError('所选成员不是这项任务的负责人', 'reply_member_mismatch', 409);
        if (task.dispatch && (normalize(task.dispatch.prompt).includes(normalize(args.text)) || normalize(task.dispatch.baselineText || '').includes(normalize(args.text)))) throw new DockError('这段文字是派发内容或此前已有的会话，不能当作本次新回复', 'reply_not_new', 409);
      }
      return store.postWorker(args.projectId, { ...args, evidence: { type: 'official-ui', memberId: m.id, observationId: o.observationId, windowTitle: o.window.title, executable: o.window.executable, capturedAt: o.createdAt, rawText: args.text } });
    }
    case 'dock_write_file': return store.writeArtifact(args.projectId, args);
    case 'dock_register_file': return store.registerArtifact(args.projectId, args);
    case 'dock_pause': return store.pauseProject(args.projectId, args.reason);
    case 'dock_complete': return store.completeProject(args.projectId, args.summary);
    default: throw new DockError('未知工具', 'tool_not_found', 404);
  }
}
