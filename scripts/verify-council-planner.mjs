import fs from 'node:fs';import path from 'node:path';import {createDock} from '../src/server.mjs';import {CodexRuntime} from '../src/codex-runtime.mjs';
const directory=fs.mkdtempSync(path.resolve('artifacts/council-planner-')),dock=createDock({directory,native:{stop(){}},coordinatorRuntime:new CodexRuntime()});
const result={directory,startedAt:new Date().toISOString(),workerMode:'No official client windows or bindings; worker replies are not simulated.'};
try{
 const p=dock.store.createProject({title:'三方会商界面（测试）',goal:'测试发送目标后自动创建统筹和评议任务',team:[{memberId:'codex',role:'规划与统筹'},{memberId:'trae',role:'代码执行'},{memberId:'doubao',role:'检验与风险'}]});
 dock.store.saveMember({id:'codex',inference:{model:'gpt-6.1-sol',effort:'medium'}});
 await new Promise(resolve=>dock.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${dock.server.address().port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
 const response=await fetch(base+`/api/projects/${p.id}/messages`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({text:'做一个很小的马里奥类横版小游戏，可以用键盘移动和跳跃。',mode:'new',requestId:'actual-council-proof'})});if(!response.ok)throw Error('Message route failed');
 const receipt=await response.json();result.roundId=receipt.roundId;result.projectId=p.id;
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){const round=dock.store.project(p.id).rounds[0];if(round.status==='error')throw Error(round.error);if(round.phase==='consulting'){
   const project=dock.store.project(p.id);if(project.tasks.filter(t=>t.kind==='consultation').length!==2||project.tasks.some(t=>t.kind==='work'))throw Error('Did not enforce consultations before execution');
   if(!project.messages.some(m=>m.author==='codex'&&m.text.length>20))throw Error('Missing actual planner message');
   result.passed=true;result.threadId=round.threadId;result.actualPlannerMessage=project.messages.find(m=>m.author==='codex').text;result.consultations=project.tasks.map(t=>({member:t.assignee,prompt:t.description}));break;
 }await new Promise(resolve=>setTimeout(resolve,500));}
 if(!result.passed)throw Error('No verified planner response before timeout');
 result.base=base;fs.writeFileSync('artifacts/council-ui-latest.json',JSON.stringify({base,directory,projectId:p.id,pid:process.pid}));
 console.log(JSON.stringify(result));fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));
 if(process.argv.includes('--keep-ui')){dock.council.stop();dock.automatic.stop();setTimeout(()=>dock.close().then(()=>process.exit(0)),600000);}else await dock.close();
}catch(error){result.passed=false;result.error=error.message;fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await dock.close();process.exitCode=1;}
