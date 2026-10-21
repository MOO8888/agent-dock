import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';import path from 'node:path';

function installedCodex(){
  if(process.env.AGENT_DOCK_CODEX)return process.env.AGENT_DOCK_CODEX;
  const directory=path.join(process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local'),'OpenAI','Codex','bin');
  try{return fs.readdirSync(directory).map(name=>path.join(directory,name,'codex.exe')).filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]||'codex.exe';}catch{return 'codex.exe';}
}

// Public Codex App Server protocol over local stdio. Codex owns its ChatGPT
// sign-in. No API key, copied credential, hidden desktop endpoint or HTTP
// inference request is used by AgentDock.
export class CodexRuntime extends EventEmitter {
  constructor({command=installedCodex(),spawnProcess=spawn,timeout=300000}={}){
    super();Object.assign(this,{command,spawnProcess,timeout});this.pending=new Map();this.turns=new Map();this.sequence=0;this.generation=0;this.status='dormant';
  }
  snapshot(){return {status:this.status,generation:this.generation,lastChecked:this.lastChecked||null,error:this.error||null};}
  setStatus(status,error=null){this.status=status;this.error=error;this.emit('state',this.snapshot());}
  async start(){
    if(this.starting)return this.starting;
    this.setStatus('starting');
    this.starting=this.initialize().catch(error=>{this.fail(error);throw error;});return this.starting;
  }
  async initialize(){
    const args=['app-server','--listen','stdio://','-c','mcp_servers={}','-c','features.shell_tool=false','-c','features.unified_exec=false','-c','features.apps=false','-c','features.computer_use=false','-c','features.browser_use=false','-c','web_search="disabled"'];
    const child=this.spawnProcess(this.command,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});this.child=child;this.generation++;let buffer='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(this.child!==child)return;buffer+=chunk;if(buffer.length>16*1024*1024){this.fail(new Error('Codex 返回内容超限'));return;}let end;while(this.child===child&&(end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;try{this.receive(JSON.parse(line));}catch{this.fail(new Error('Codex 本地协议返回无效数据'));}}});
    child.stderr.on('data',()=>{}); // Never copy runtime diagnostics or account data to chat.
    child.stdin.on('error',()=>{if(this.child===child)this.fail(new Error('Codex 本地连接已关闭，请检查统筹连接'));});
    child.on('error',()=>{if(this.child===child)this.fail(new Error('未能启动官方 Codex 运行时，请确认已安装并登录 Codex'));});
    child.on('exit',()=>{if(this.child===child){this.child=null;this.fail(new Error('Codex 运行时已退出；已发送的工作不会自动重发'));}});
    await this.request('initialize',{clientInfo:{name:'agentdock',title:'共作 AgentDock',version:'0.1.0'}},20000);
    this.write({method:'initialized',params:{}});
    const account=await this.request('account/read',{refreshToken:false},20000);
    if(account.account?.type!=='chatgpt')throw new Error('自动统筹需要官方 Codex 的 ChatGPT 登录；未使用 API Key 或切换付费接口');
    this.accountType='chatgpt';this.lastChecked=new Date().toISOString();this.setStatus('ready');return this;
  }
  async check(){try{await this.start();const result=await this.request('account/read',{refreshToken:false});if(result.account?.type!=='chatgpt')throw new Error('自动统筹需要官方 Codex 的 ChatGPT 登录，请在官方客户端完成登录后检查连接');this.lastChecked=new Date().toISOString();this.setStatus(this.turns.size?'working':'ready');return this.snapshot();}catch(error){if(this.child)this.fail(error);throw error;}}
  write(value){if(!this.child?.stdin?.writable)throw new Error('Codex 本地连接已关闭');this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params={},timeout=20000){return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} 超时，结果需要核对`));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});}
  receive(message){
    if(message.method&&message.id!==undefined){
      // The planner has no executable tools. Never grant a runtime request to
      // run code, change files, log in, or broaden permissions automatically.
      this.write({id:message.id,error:{code:-32601,message:'共作统筹只输出方案，请在项目群聊提出所需操作，不执行本地工具或权限申请。'}});return;
    }
    if(message.id!==undefined){const pending=this.pending.get(message.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(message.id);message.error?pending.reject(new Error(message.error.message||'Codex 请求被拒绝')):pending.resolve(message.result);return;}
    const params=message.params||{},turn=this.turns.get(params.threadId);if(!turn)return;
    if(message.method==='item/agentMessage/delta')this.emit('progress',{threadId:params.threadId,stage:'writing'});
    if(message.method==='item/completed'&&params.item?.type==='agentMessage')turn.messages.set(params.item.id||'final',params.item.text||'');
    if(message.method==='turn/completed'){
      clearTimeout(turn.timer);this.turns.delete(params.threadId);this.setStatus(this.turns.size?'working':'ready');
      const actual=params.turn;
      if(actual?.status!=='completed')return turn.reject(new Error(actual?.error?.message||`Codex 本轮${actual?.status||'未完成'}`));
      try{const text=[...turn.messages.values()].at(-1)||actual.items?.filter(i=>i.type==='agentMessage').at(-1)?.text||'';turn.resolve({data:JSON.parse(text),turnId:actual.id,threadId:params.threadId});}catch{turn.reject(new Error('Codex 未返回可验证的结构化方案，尚未派发新任务'));}
    }
  }
  async models(){await this.start();return (await this.request('model/list',{})).data;}
  async createThread({cwd,model,instructions}){await this.start();const result=await this.request('thread/start',{cwd,...(model?{model}:{}),sandbox:'read-only',developerInstructions:instructions,serviceName:'agentdock-council',allowProviderModelFallback:false},60000);return result.thread.id;}
  async nameThread(threadId,name){await this.request('thread/name/set',{threadId,name});}
  async resumeThread(threadId){await this.start();await this.request('thread/resume',{threadId,excludeTurns:true},60000);}
  async run({threadId,text,model,effort,schema}){
    await this.start();if(this.turns.has(threadId))throw new Error('这轮统筹仍在运行，不会重复启动');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{const turn=this.turns.get(threadId);if(!turn)return;this.turns.delete(threadId);if(turn.turnId)this.request('turn/interrupt',{threadId,turnId:turn.turnId},5000).catch(()=>{});const error=new Error('统筹响应超时，请打开官方会话核对结果；没有重复派发');error.outcomeUncertain=true;this.setStatus(this.turns.size?'working':'ready');reject(error);},this.timeout);
      this.turns.set(threadId,{resolve,reject,timer,messages:new Map()});this.setStatus('working');
      this.request('turn/start',{threadId,input:[{type:'text',text}],...(model?{model}:{}),...(effort?{effort}:{}),outputSchema:schema},60000).then(result=>{const turn=this.turns.get(threadId);if(turn)turn.turnId=result.turn.id;this.emit('started',{threadId,turnId:result.turn.id});}).catch(error=>{const turn=this.turns.get(threadId);if(turn){clearTimeout(turn.timer);this.turns.delete(threadId);if(/超时|连接已关闭/.test(error.message))error.outcomeUncertain=true;this.setStatus(this.turns.size?'working':'ready');turn.reject(error);}});
    });
  }
  fail(error){const child=this.child;this.child=null;this.starting=null;if(child)child.kill();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();for(const turn of this.turns.values()){clearTimeout(turn.timer);const uncertain=new Error(error.message);uncertain.outcomeUncertain=true;turn.reject(uncertain);}this.turns.clear();this.setStatus('error',error.message);this.emit('unavailable',error);}
  close(){this.fail(new Error('统筹运行时已停止'));this.setStatus('dormant');}
}
