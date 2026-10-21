import path from 'node:path';
import fs from 'node:fs';
import { DockError } from './store.mjs';

export function validateConnection(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DockError('客户端连接设置格式不正确');
  const c={...previous};
  for(const key of ['autoBind','autoLaunch']) if(key in input) { if(typeof input[key]!=='boolean') throw new DockError('自动连接设置应为开关'); c[key]=input[key]; }
  for(const key of ['executable','arguments','desktop','className','title']) if(key in input) {
    if(typeof input[key]!=='string' || input[key].length>4000 || /[\r\n\0]/.test(input[key])) throw new DockError('客户端路径或启动设置不正确'); c[key]=input[key].trim();
  }
  c.autoBind??=false; c.autoLaunch??=false; c.desktop||='default'; c.arguments??=''; c.executable??='';
  if(c.executable && (!path.win32.isAbsolute(c.executable)||!c.executable.toLowerCase().endsWith('.exe'))) throw new DockError('请选择官方客户端的完整 .exe 路径');
  if(/^(cmd|powershell|pwsh|wscript|cscript|mshta|node|python|bash|sh)\.exe$/i.test(path.win32.basename(c.executable)))throw new DockError('客户端自动启动不能配置终端或脚本解释器');
  if(c.desktop!=='default'&&!/^AgentDock_[a-zA-Z0-9_]{1,64}$/.test(c.desktop)) throw new DockError('自动连接只能使用当前桌面或共作工作桌面');
  if(c.autoBind&&!c.executable) throw new DockError('开启自动绑定前，请设置客户端程序路径');
  if(c.autoLaunch&&(!c.autoBind||c.desktop==='default')) throw new DockError('自动启动需要开启自动绑定并使用独立工作桌面');
  return c;
}

export class ClientConnections {
  constructor(store,native,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),delays=[300,700,1500,3000,5000],fileExists=fs.existsSync}={}) {
    this.store=store;this.native=native;this.sleep=sleep;this.delays=delays;this.fileExists=fileExists;this.pending=null;this.launched=new Set();this.stopped=false;
    this.status={running:false,startedAt:null,finishedAt:null};
  }
  start(projectId,{runningOnly=false}={}) {
    const project=this.store.project(projectId);
    if(runningOnly&&project.status!=='running')return this.status;
    if(this.pending) return this.status;
    this.status={running:true,startedAt:new Date().toISOString(),finishedAt:null};
    this.pending=this.connect(projectId,{runningOnly}).catch(error=>{this.status.error=error.message;}).finally(()=>{this.status.running=false;this.status.finishedAt=new Date().toISOString();this.pending=null;if(!this.stopped)this.store.save();});
    return this.status;
  }
  reconnect() {
    if(this.stopped||this.pending||this.store.state.projects.some(p=>p.takeover?.active))return;
    const project=this.store.state.projects.find(p=>p.status==='running');
    if(project)this.start(project.id,{runningOnly:true});
  }
  available() {
    if(this.stopped) throw new DockError('工作台正在关闭，自动连接已停止');
    if(this.store.state.projects.some(p=>p.takeover?.active)) throw new DockError('人工接管期间暂停自动连接','human_takeover_active',409);
  }
  update(member,changes) { Object.assign(member,changes); this.store.save(); }
  matches(windows,c,memberId) {
    const executable=path.win32.normalize(c.executable).toLowerCase();
    return windows.filter(w=>w.executable&&path.win32.normalize(w.executable).toLowerCase()===executable
      &&(!c.className||w.className===c.className)
      &&(c.desktop!=='default'||!c.title||w.title===c.title)
      &&(w.minimized||w.width>=350)
      &&(!memberId||!this.store.state.members.some(other=>{if(other.id===memberId)return false;const bound=other.window||other.connection?.windowHint;return bound?.id===w.id&&bound?.pid===w.pid;})));
  }
  async connect(projectId,{runningOnly=false}={}) {
    const store=this.store,project=store.project(projectId);
    const available=()=>{this.available();if(runningOnly&&project.status!=='running')throw new DockError('项目未运行，自动连接已停止','project_inactive',409);};
    available();
    const configured=store.state.members.filter(m=>!m.coordinator&&m.connection?.autoBind&&project.memberIds.includes(m.id));
    const projectDesktops=[...new Set(configured.map(m=>m.connection.desktop).filter(d=>d!=='default'))];
    if(project.desktop==='default'&&['draft','paused','running'].includes(project.status)&&projectDesktops.length===1&&!project.tasks.some(t=>t.dispatch&&['sending','unknown','sent'].includes(t.dispatch.status)&&!['done','cancelled'].includes(t.status)))store.updateProject(project.id,{desktop:projectDesktops[0]});
    const desktops=new Map();
    for(const member of configured) {
      available();if(!project.memberIds.includes(member.id))continue;const c=structuredClone(member.connection);
      try {
        if(c.desktop!=='default'&&!desktops.has(c.desktop)) { available();desktops.set(c.desktop,await this.native.call('ensure_desktop',{desktop:c.desktop})); }
        available();let windows=(await this.native.call('windows',{desktop:c.desktop})).windows;let matches=this.matches(windows,c,member.id);
        // Preserve an explicitly bound live instance when several exist. Never
        // substitute an unrelated window just because its title resembles an AI.
        if(JSON.stringify(c)!==JSON.stringify(member.connection))continue;
        const hint=member.window||c.windowHint;
        const bound=this.matches(windows,{...c,title:''},member.id).find(w=>w.id===hint?.id&&w.pid===hint?.pid);
        if(bound) matches=[bound];
        if(matches.length>1) throw new DockError('找到多个匹配窗口，请在监视面板选择一次专用窗口','ambiguous_window',409);
        if(!matches.length&&c.autoLaunch&&!this.launched.has(member.id)) {
          if(!this.fileExists(c.executable)) throw new DockError('已保存的客户端路径不存在，请在团队设置中更新','client_missing',404);
          available();this.launched.add(member.id);
          this.update(member,{window:null,status:'unbound',detail:'正在启动已配置的官方客户端…'});
          const profile=path.join(store.directory,'profiles',member.id);fs.mkdirSync(profile,{recursive:true});
          const args=c.arguments.replaceAll('{workspace}',project?.workspace||store.directory).replaceAll('{profile}',profile);
          await this.native.call('launch',{desktop:c.desktop,executable:c.executable,arguments:args,cwd:project?.workspace||store.directory});
          for(const delay of this.delays) { await this.sleep(delay);available();matches=this.matches((await this.native.call('windows',{desktop:c.desktop})).windows,c,member.id);if(matches.length)break; }
        }
        available();
        if(matches.length>1) throw new DockError('客户端出现多个匹配窗口，请选择专用窗口','ambiguous_window',409);
        if(!matches.length) { this.update(member,{window:null,status:'unbound',detail:c.autoLaunch?'客户端尚未提供可绑定窗口；可能需要处理登录，或复用了原桌面的进程。':'未找到已配置窗口；打开专用客户端后会再次自动查找。'});continue; }
        // A settings change during startup wins over the older in-flight scan.
        if(JSON.stringify(c)!==JSON.stringify(member.connection)) continue;
        const w=matches[0];const same=w.id===hint?.id&&w.pid===hint?.pid;
        const status=['quota','login'].includes(member.status)||(same&&['busy','error'].includes(member.status))?member.status:'ready';
        if(!same)this.native.observations?.clear();
        this.launched.delete(member.id);
        const changes={window:w,status,connection:{...member.connection,className:w.className,title:w.title},detail:status!=='ready'&&member.detail?member.detail:'已自动绑定专用客户端窗口；登录和任务状态由统筹者核实。'};
        if(Object.entries(changes).some(([key,value])=>JSON.stringify(member[key])!==JSON.stringify(value))) {
          this.update(member,changes);store.log('client.auto_bound',{memberId:member.id,desktop:c.desktop,pid:w.pid,windowId:w.id});store.save();
        }
      } catch(error) {
        if(['human_takeover_active','project_inactive'].includes(error.code)||this.stopped)throw error;
        this.update(member,{window:null,status:'error',detail:`自动连接需要处理：${error.message}`});
      }
    }
  }
  stop() { this.stopped=true; }
}
