import fs from 'node:fs';import path from 'node:path';import {CodexRuntime} from '../src/codex-runtime.mjs';
const directory=fs.mkdtempSync(path.resolve('artifacts/codex-runtime-')),runtime=new CodexRuntime(),result={startedAt:new Date().toISOString()};
try{
 await runtime.start();result.accountType=runtime.accountType;
 const models=await runtime.models();result.models=models.map(m=>({id:m.id,model:m.model,supportedReasoningEfforts:m.supportedReasoningEfforts}));
 const model=models.find(m=>m.id==='gpt-6.1-sol'||m.model==='gpt-6.1-sol')||models.find(m=>m.isDefault)||models[0];if(!model)throw Error('No available official model');
 const threadId=await runtime.createThread({cwd:directory,model:model.model||model.id,instructions:'你是共作本地协议验证。不要使用任何工具，不读取或写入文件，只返回指定 JSON。'});result.threadId=threadId;
 const reply=await runtime.run({threadId,model:model.model||model.id,effort:'low',text:'请返回 JSON，ready 为 true，message 为“官方统筹会话已启动”。不要使用任何工具。',schema:{type:'object',properties:{ready:{type:'boolean'},message:{type:'string'}},required:['ready','message'],additionalProperties:false}});
 if(reply.data.ready!==true)throw Error('Invalid model reply');result.passed=true;result.reply=reply;
}catch(error){result.passed=false;result.error=error.message;process.exitCode=1;}finally{runtime.close();result.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
