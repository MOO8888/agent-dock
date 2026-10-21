import {DockError} from './store.mjs';
const pause=()=>new Promise(resolve=>setTimeout(resolve,180));
const modelName=name=>(name||'').replace(/\s+(新版|即将下线)$/,'');
export const inferenceEqual=(a={},b={})=>(a.model||'')===(b.model||'')&&(a.effort||'')===(b.effort||'');
export function validateInference(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DockError('模型设置格式不正确');
  const result={};for(const key of ['model','effort']){const v=value[key]??'';if(typeof v!=='string'||v.length>100)throw new DockError('模型和推理选项应为简短文字');result[key]=v.trim();}return result;
}
export function checkInference(member,task,observation){
  if(member.configurationBusy)throw new DockError('正在修改模型设置，请稍后派发','model_settings_busy',409);
  if(!task.inference?.model&&!task.inference?.effort)return;
  const applied=task.inferenceApplied||member.inferenceApplied;
  if(!applied||!inferenceEqual(task.inference,applied)||!observation.elements.some(e=>e.type==='Button'&&e.name===applied.actual))throw new DockError('任务要求的模型和推理程度尚未在官方界面确认，请先应用设置','inference_unconfirmed',409);
}
export class ClientPreferences {
  constructor(store,native){this.store=store;this.native=native;this.busy=new Set();}
  guard(projectId,memberId){
    const p=this.store.project(projectId),m=this.store.member(memberId);
    if(!p.memberIds.includes(m.id))throw new DockError('成员未加入当前项目');
    if(this.store.state.projects.some(p=>p.takeover?.active))throw new DockError('人工接管期间停止读取和修改客户端','human_takeover_active',409);
    if(m.coordinator)throw new DockError('Codex 模型由运行本次统筹的宿主选择，共作无法改变已经运行的宿主模型。设置会记录为待应用。','host_model_control_required',409);
    if(!m.window||!m.connection?.desktop?.startsWith('AgentDock_'))throw new DockError('请先绑定独立工作桌面的官方客户端','window_unbound',409);
    if(this.store.state.projects.some(p=>p.tasks.some(t=>t.assignee===m.id&&!['done','cancelled','review'].includes(t.status)&&(t.status==='running'||['sending','prepared','unknown'].includes(t.dispatch?.status)))))throw new DockError('成员正在执行或有待核对草稿，请结束后再切换模型','member_busy',409);
    return {p,m};
  }
  async fresh(m,p,predicate){for(let i=0;i<4;i++){const o=await this.native.observe(m,p.desktop,{screenshot:false});if(!o.partial&&predicate(o))return o;await pause();}throw new DockError('官方菜单尚未完整读回，未作未经确认的选择','model_menu_unavailable',409);}
  async act(m,o,e,action='invoke'){if(!e)throw new DockError('没有唯一可用的模型控件');try{await this.native.act(m,{observationId:o.observationId,elementIndex:e.index,action});}catch(error){if(error.message)throw error;throw new DockError(`官方控件“${e.name}”尚未完成操作，请重新读取菜单`,'model_action_failed',409);}}
  async menu(m,p){
    let o=await this.fresh(m,p,()=>true);
    if(o.elements.some(e=>e.type==='Menu'&&e.name))return o;
    const controls=o.elements.filter(e=>e.type==='Button'&&e.canInvoke&&e.enabled!==false&&e.offscreen!==true&&/^(自动|豆包 \d)/.test(e.name));
    if(controls.length!==1)throw new DockError('未识别到唯一的官方模型选择器，保留客户端设置','model_control_unsupported',409);
    try{await this.act(m,o,controls[0]);}catch(error){
      // Some UIA providers report a stale element after the popup has opened.
      // Read the actual menu; do not invoke the same toggle a second time.
      try{return await this.fresh(m,p,o=>o.elements.some(e=>e.type==='Menu'&&e.name===controls[0].name)&&o.elements.some(e=>e.type==='MenuItem'));}catch{throw error;}
    }
    return this.fresh(m,p,o=>o.elements.some(e=>e.type==='MenuItem'));
  }
  async readMenu(m,p){
    let o=await this.menu(m,p);
    const models=o.elements.filter(e=>e.type==='MenuItem'&&e.canInvoke&&!/^推理强度/.test(e.name)).map(e=>modelName(e.name));
    if(!models.length)throw new DockError('官方模型菜单没有可操作选项');
    const root=o.elements.find(e=>e.type==='Menu'),current=models.slice().sort((a,b)=>b.length-a.length).find(name=>root?.name===name||root?.name?.startsWith(name+' '))||'';
    const strength=o.elements.find(e=>e.type==='MenuItem'&&/^推理强度/.test(e.name));
    let efforts=[];
    if(strength?.canExpand){await this.act(m,o,strength,'expand');o=await this.fresh(m,p,o=>o.elements.some(e=>e.type==='MenuItem'&&!models.includes(modelName(e.name))&&!/推理强度/.test(e.name)));efforts=o.elements.filter(e=>e.type==='MenuItem'&&e.canInvoke&&!models.includes(modelName(e.name))&&!/^推理强度/.test(e.name)).map(e=>e.name);}
    return {o,models,efforts,current,currentEffort:strength?.name.replace(/^推理强度\s*/, '')||''};
  }
  async close(m,p,current){
    let o=await this.native.observe(m,p.desktop,{screenshot:false});
    if(o.elements.some(e=>e.type==='Menu')){
      for(let i=0;i<2;i++){const menu=o.elements.find(e=>e.type==='Menu');if(!menu)break;
        try{await this.act(m,o,menu,'dismiss_menu');}catch(error){try{await this.fresh(m,p,o=>!o.elements.some(e=>e.type==='Menu'));return;}catch{throw error;}}
        await pause();o=await this.native.observe(m,p.desktop,{screenshot:false});
      }
      await this.fresh(m,p,o=>!o.elements.some(e=>e.type==='Menu'));return;
    }
    const selected=o.elements.filter(e=>e.type==='MenuItem'&&modelName(e.name)===current&&e.canInvoke);
    if(selected.length===1){await this.act(m,o,selected[0]);await this.fresh(m,p,o=>!o.elements.some(e=>e.type==='Menu'));}
  }
  async run(projectId,memberId,requested){
    const {p,m}=this.guard(projectId,memberId);if(this.busy.has(m.id))throw new DockError('正在读取或应用模型，请稍候','model_settings_busy',409);
    this.busy.add(m.id);m.configurationBusy=true;
    try {
      const menu=await this.readMenu(m,p);
      m.modelCatalog={models:menu.models,efforts:menu.efforts,current:menu.current,currentEffort:menu.currentEffort,source:'official-ui',updatedAt:new Date().toISOString()};
      await this.close(m,p,menu.current);
      if(!requested){this.store.save();return structuredClone(m.modelCatalog);}
      const choice=validateInference(requested),model=choice.model||menu.current;
      if(!menu.models.includes(model))throw new DockError('所选模型不在官方菜单中，未发送任务','model_not_available',409);
      if(choice.effort&&!menu.efforts.includes(choice.effort))throw new DockError('当前官方客户端不支持自动切换该推理程度，未发送任务','effort_not_available',409);
      let o=await this.menu(m,p);await this.act(m,o,o.elements.find(e=>e.type==='MenuItem'&&modelName(e.name)===model&&e.canInvoke));await this.fresh(m,p,o=>!o.elements.some(e=>e.type==='Menu'));
      if(choice.effort){o=await this.menu(m,p);const strength=o.elements.find(e=>e.type==='MenuItem'&&/^推理强度/.test(e.name)&&e.canExpand);await this.act(m,o,strength,'expand');o=await this.fresh(m,p,o=>o.elements.some(e=>e.type==='MenuItem'&&e.name===choice.effort));await this.act(m,o,o.elements.find(e=>e.type==='MenuItem'&&e.name===choice.effort&&e.canInvoke));await this.close(m,p,model);}
      o=await this.fresh(m,p,o=>o.elements.some(e=>e.type==='Button'&&e.name.startsWith(model)));
      const actual=o.elements.find(e=>e.type==='Button'&&e.name.startsWith(model));
      if(choice.effort&&!actual.name.includes(choice.effort))throw new DockError('官方界面未确认推理程度，任务不会按未核实设置发送','inference_unconfirmed',409);
      m.inferenceApplied={...choice,actual:actual.name,appliedAt:new Date().toISOString(),source:'official-ui'};m.modelCatalog.current=model;m.modelCatalog.currentEffort=choice.effort||menu.currentEffort;delete m.inferenceError;this.store.save();return structuredClone(m.inferenceApplied);
    }catch(error){m.inferenceError=error.message;this.store.save();throw error;}
    finally{this.busy.delete(m.id);delete m.configurationBusy;this.store.save();}
  }
  async ensure(projectId,task){if(task.inference?.model||task.inference?.effort){task.inferenceApplied=await this.run(projectId,task.assignee,task.inference);this.store.save();}}
}
