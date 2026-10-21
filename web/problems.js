const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const runtimeLabel=status=>({dormant:'Codex 待命',starting:'Codex 正在连接',ready:'Codex 已就绪',working:'Codex 正在统筹',error:'Codex 需要处理'}[status]||'自动统筹');
export function createProblemCenter({onAction}){
  const banner=document.querySelector('#problem-banner'),dialog=document.querySelector('#problem-dialog'),body=document.querySelector('#problem-body');
  let remote=[],local=null,operation=null,pending=false,seen,renderedKey;
  try{seen=new Set(JSON.parse(sessionStorage.getItem('dock-seen-problems')||'[]'));}catch{seen=new Set();}
  const all=()=>[...(local?[local]:[]),...(operation?[operation]:[]),...remote];
  const remember=()=>{for(const issue of all())seen.add(issue.id);try{sessionStorage.setItem('dock-seen-problems',JSON.stringify([...seen].slice(-200)));}catch{}};
  function contents(force=false){
    const issues=all(),key=JSON.stringify(issues);if(!force&&renderedKey===key)return;renderedKey=key;
    body.innerHTML=issues.length?issues.map(issue=>`<article class="problem-card"><small>${escape(issue.scope||'工作台')}</small><h3>${escape(issue.title)}</h3><p>${escape(issue.remedy)}</p><details><summary>查看实际原因</summary><pre>${escape(issue.detail)}</pre></details><div class="dialog-actions">${issue.action==='thread'&&issue.threadId?`<a class="secondary" href="codex://threads/${escape(issue.threadId)}">打开本轮统筹 ↗</a>`:issue.action==='thread'?'<span class="field-note">请在任务记录核对已创建的工作单。</span>':`<button class="secondary" data-problem-action="${escape(issue.id)}">${({check:'检查统筹连接',member:'查看成员与处理步骤',local:'重新检查工作台',dismiss:'已了解'}[issue.action]||'查看处理步骤')}</button>`}</div></article>`).join(''):'<p class="dialog-note">刚才的问题已解除，可以关闭此提示。</p>';
    body.querySelectorAll('[data-problem-action]').forEach(button=>button.onclick=async()=>{const issue=all().find(i=>i.id===button.dataset.problemAction);if(!issue)return;if(issue.action==='dismiss'){operation=null;render();return;}button.disabled=true;button.textContent='正在检查…';try{await onAction(issue);}finally{if(button.isConnected){button.disabled=false;contents(true);}}});
  }
  function open(){pending=false;contents();remember();if(!dialog.open)dialog.showModal();}
  function maybeOpen(){
    if(!pending||dialog.open)return;
    // Preserve forms, drafts and human desktop takeover. The persistent banner
    // remains available; the popup appears when that interaction is finished.
    const editing=document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');
    if(document.querySelector('#dialog')?.open||editing)return;
    open();
  }
  function render(){
    const issues=all(),active=new Set(issues.map(issue=>issue.id));
    // Once resolved, the same cause appearing again is a new incident. While
    // it remains unresolved, polls, SSE and reloads must not open it again.
    for(const id of seen)if(!active.has(id))seen.delete(id);
    try{sessionStorage.setItem('dock-seen-problems',JSON.stringify([...seen].slice(-200)));}catch{}
    banner.classList.toggle('hidden',!issues.length);
    banner.querySelector('b').textContent=issues.length?`${issues.length} 个问题需要处理`:'';
    banner.querySelector('span').textContent=issues[0]?`${issues[0].scope||'工作台'}：${issues[0].title}`:'';
    if(dialog.open){contents();remember();pending=false;}
    if(!issues.length)pending=false;
    else if(issues.some(issue=>!seen.has(issue.id)))pending=true;
    maybeOpen();
  }
  banner.querySelector('button').onclick=open;
  document.querySelector('#problem-close').onclick=()=>dialog.close();
  document.querySelector('#dialog')?.addEventListener('close',()=>setTimeout(maybeOpen,0));
  document.addEventListener('focusout',()=>setTimeout(maybeOpen,0));
  return {
    update(issues){remote=issues||[];render();},
    operationFailed(error){operation={id:'operation:'+error.message,scope:'刚才的操作',title:'操作未完成',detail:error.message,remedy:'按下方实际原因处理后再操作。若涉及消息发送或客户端输入，请先核对是否已经发送，避免重复提交。',action:'dismiss'};render();},
    connectionFailed(detail){local={id:'local-service-unavailable',scope:'本地工作台',title:'工作台服务连接中断',detail,remedy:'先点击“重新检查工作台”。若服务已停止，请运行共作的启动脚本，再回到此页面；页面重连不会重复发送你的消息。',action:'local'};render();},
    connectionRestored(){if(local){local=null;render();}},
    close(){dialog.close();},open
  };
}
