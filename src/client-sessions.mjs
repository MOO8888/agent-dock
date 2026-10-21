import {DockError} from './store.mjs';

// Only observed, invokable official controls. No guessed coordinates/shortcuts.
const newConversation=name=>/^(新工作任务|新建对话|新对话|新建聊天|新聊天|新建任务|新任务|New Chat|New Task)(?:\s+(?:Ctrl|Control|⌘|\().*)?$/i.test(name||'');
export class ClientSessions{
  constructor(store,native){Object.assign(this,{store,native});}
  async ensure(project,task,member){
    if(!task.roundId)return;
    const round=project.rounds?.find(r=>r.id===task.roundId);if(!round)throw new DockError('协作轮次不存在');
    const guard=()=>{if(project.status!=='running'||project.takeover?.active)throw new DockError('项目已暂停，停止创建会话','project_paused',409);};guard();
    const session=round.sessions[member.id]||={status:'pending'};
    if(session.status==='ready'){
      if(session.windowId!==member.window?.id||session.pid!==member.window?.pid)throw new DockError('成员窗口已改变，请核对该轮会话，未自动重建','conversation_changed',409);
      return;
    }
    if(session.status==='opening'||session.status==='unknown')throw new DockError('新对话创建结果待核对，不会再次点击','conversation_uncertain',409);
    const o=await this.native.observe(member,project.desktop,{screenshot:false});guard();
    if(o.elements.some(e=>e.type==='Button'&&e.name==='登录')){this.store.memberState(member.id,'login','专用客户端需要用户登录');throw new DockError('请先完成专用客户端登录','client_login',409);}
    if(o.elements.some(e=>e.canSetValue&&e.value?.trim()))throw new DockError('客户端有未发送草稿，保留原草稿，未创建新对话','input_not_empty',409);
    const buttons=o.elements.filter(e=>e.canInvoke&&e.enabled!==false&&e.offscreen!==true&&newConversation(e.name));
    if(buttons.length!==1)throw new DockError('没有唯一可用的新对话控件，请完成客户端准备；未复用历史对话','new_conversation_unavailable',409);
    Object.assign(session,{status:'opening',windowId:member.window.id,pid:member.window.pid,control:buttons[0].name,openedAt:new Date().toISOString()});this.store.save();
    try{
      const result=await this.native.act(member,{observationId:o.observationId,elementIndex:buttons[0].index,action:'invoke'});guard();
      if(result.observation.partial||!result.observation.elements.some(e=>e.canSetValue)||result.observation.elements.some(e=>e.canSetValue&&e.value?.trim()))throw new DockError('新会话输入区尚未确认，请核对窗口');
      Object.assign(session,{status:'ready',observationId:result.observation.observationId});this.store.save();
    }catch(error){session.status='unknown';session.error=error.message;this.store.save();throw error;}
  }
}
