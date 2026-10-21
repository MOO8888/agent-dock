import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store, DockError } from './store.mjs';
import { NativeBridge } from './native.mjs';
import { definitions, executeTool } from './tools.mjs';
import { syncTakeovers } from './takeover.mjs';
import { ClientConnections } from './connections.mjs';
import { AutomaticExecution } from './automatic.mjs';
import {receiveUpload} from './uploads.mjs';
import {ClientPreferences} from './preferences.mjs';
import {CodexRuntime} from './codex-runtime.mjs';
import {Council} from './council.mjs';
import {ClientSessions} from './client-sessions.mjs';
import {diagnostics,coordinatorState} from './diagnostics.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 2_000_000) throw new DockError('请求内容过大', 'body_too_large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new DockError('请求格式不正确', 'invalid_json'); }
}
function equal(a, b) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

export function createDock({ directory = process.env.AGENT_DOCK_DATA || path.join(root, '.data'), native = new NativeBridge(), token, coordinatorRuntime = native instanceof NativeBridge ? new CodexRuntime() : null } = {}) {
  const store = new Store(directory);
  const clients = new ClientConnections(store,native);
  const preferences=new ClientPreferences(store,native);
  native.ensureInference=(projectId,task)=>preferences.ensure(projectId,task);
  const sessions=new ClientSessions(store,native);native.ensureSession=(p,t,m)=>sessions.ensure(p,t,m);
  const automatic = new AutomaticExecution(store,native);
  const council=new Council(store,coordinatorRuntime);
  const tokenFile = path.join(store.directory, 'bridge-token');
  token ||= fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const streams = new Set();
  const runtimeChanged=()=>{for(const res of streams)res.write('event: change\ndata: {}\n\n');};
  coordinatorRuntime?.on?.('state',runtimeChanged);
  store.on('change', revision => { for (const res of streams) res.write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`); });
  store.activity.on('change', () => { const data = JSON.stringify({ activities: store.activity.snapshot() }); for (const res of streams) res.write(`event: activity\ndata: ${data}\n\n`); });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = req.headers.host?.split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return json(res, { error: '仅允许本机访问', code: 'host_denied' }, 403);
    if (req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { return json(res, { error: '来源不匹配', code: 'origin_denied' }, 403); }
      if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.port !== String(server.address()?.port)) return json(res, { error: '来源不匹配', code: 'origin_denied' }, 403);
    }
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, { ok: true, name: 'AgentDock', version: '0.1.0' });
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=')));
      const authenticated = equal(req.headers.authorization?.replace(/^Bearer /, ''), token) || equal(cookies.dock_session, token);
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Set-Cookie', `dock_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': mime['.html'], 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(root, 'web', 'index.html')));
      }
      if (url.pathname.startsWith('/api/') && !authenticated) return json(res, { error: '需要本地会话', code: 'unauthorized' }, 401);
      if (req.method === 'GET' && url.pathname === '/api/state') {
        await syncTakeovers(store,native);
        const state = store.snapshot(),status=coordinatorState(state,coordinatorRuntime,council.busy); state.clientConnection=clients.status;state.coordinator=status.coordinator;state.coordinatorRuntime=status.runtime;
        state.issues=diagnostics(state,status.runtime);
        return json(res, state);
      }
      if(req.method==='POST'&&url.pathname==='/api/coordinator/check'){
        if(!coordinatorRuntime)throw new DockError('当前使用手动统筹，请在专用任务检查连接','manual_coordinator',409);
        // Account/protocol health only: no inference, task replay or worker UI.
        return json(res,await coordinatorRuntime.check());
      }
      if (req.method === 'GET' && url.pathname === '/api/verification') {
        const file = path.join(root, 'artifacts', 'native-verification', 'result.json');
        return json(res, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { passed: false, error: '尚未运行本地验证' });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: connected\ndata: ${JSON.stringify({ revision: store.state.revision })}\n\n`); streams.add(res);
        const timer = setInterval(() => res.write(': keepalive\n\n'), 15000);
        req.on('close', () => { streams.delete(res); clearInterval(timer); }); return;
      }
      const uploadRoute=url.pathname.match(/^\/api\/projects\/([^/]+)\/attachments(?:\/([^/]+))?$/);
      if(uploadRoute){
        const [,projectId,inputId]=uploadRoute;const p=store.project(projectId);
        if(req.method==='POST'&&!inputId)return json(res,await receiveUpload(req,store,projectId),201);
        if(req.method==='GET'&&inputId){const input=store.inputs(projectId,[inputId])[0];res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':input.size,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(input.name).replaceAll("'",'%27')}`,'Content-Security-Policy':"sandbox allow-downloads; default-src 'none'"});return fs.createReadStream(store.safePath(p,input.relative)).pipe(res);}
      }
      if (req.method === 'POST' && url.pathname === '/api/tools/call') {
        const input = await body(req);
        if (!definitions().some(t => t.name === input.name)) throw new DockError('未知工具', 'tool_not_found', 404);
        return json(res, await executeTool(input.name, input.arguments || {}, store, native));
      }
      if (req.method === 'GET' && url.pathname === '/api/tools') return json(res, definitions());
      if (req.method === 'POST' && url.pathname === '/api/projects') return json(res, store.createProject(await body(req)), 201);
      if (req.method === 'POST' && url.pathname === '/api/members') {const input=await body(req);const result=store.saveMember(input);if(input.connection)clients.launched.delete(result.id);if(result.coordinator&&input.inference&&coordinatorRuntime){for(const request of store.state.coordinatorRequests||[])if(request.status==='pending')request.status='managed';store.save();}return json(res,result);}
      const preferenceRoute=url.pathname.match(/^\/api\/projects\/([^/]+)\/members\/([^/]+)\/(model-options|apply-model)$/);
      if(req.method==='POST'&&preferenceRoute){const [,projectId,memberId,action]=preferenceRoute;await syncTakeovers(store,native);const input=await body(req);const member=store.member(memberId);if(member.coordinator&&action==='model-options'&&coordinatorRuntime){const models=await coordinatorRuntime.models();member.modelCatalog={models:models.map(m=>m.model||m.id),effortsByModel:Object.fromEntries(models.map(m=>[m.model||m.id,(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort)])),source:'official-codex-app-server',updatedAt:new Date().toISOString()};store.save();return json(res,member.modelCatalog);}return json(res,await preferences.run(projectId,memberId,action==='apply-model'?(input.inference||member.inference||{}):null));}
      if(req.method==='POST'&&url.pathname==='/api/clients/connect') {await syncTakeovers(store,native);clients.available();const input=await body(req);if(input.projectId)store.project(input.projectId);return json(res,clients.start(input.projectId),202);}
      if (req.method === 'GET' && url.pathname === '/api/windows') return json(res, await native.call('windows', { desktop: url.searchParams.get('desktop') || 'default' }));
      if (req.method === 'GET' && url.pathname === '/api/capabilities') {
        try { return json(res, await native.call('capabilities')); } catch (e) { return json(res, { platform: process.platform, backend: 'unavailable', error: e.message, physicalInput: false }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/desktops') { const result=await native.call('desktops'); result.items=[...new Set([...result.items,...store.state.projects.map(p=>p.desktop).filter(name=>name.startsWith('AgentDock_'))])]; return json(res,result); }
      if (req.method === 'POST' && url.pathname === '/api/desktops') return json(res, await native.call('create_desktop'));
      if (req.method === 'POST' && url.pathname === '/api/desktop/launch') {
        const input = await body(req); const p = store.project(input.projectId);
        if(input.memberId) {clients.available();const member=store.member(input.memberId);if(member.coordinator)throw new DockError('统筹者通过本地工具连接');store.saveMember({id:member.id,connection:{autoBind:true,autoLaunch:true,desktop:p.desktop,executable:input.executable,arguments:input.arguments||''}});clients.launched.delete(member.id);return json(res,{queued:true,connection:clients.start(p.id)},202);}
        return json(res, await native.call('launch', { desktop: p.desktop, executable: input.executable, arguments: input.arguments || '', cwd: p.workspace }));
      }
      const takeoverRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/takeover$/);
      if (req.method === 'POST' && takeoverRoute) {
        // The screen-switch command is deliberately absent from the MCP tools.
        if (!equal(cookies.dock_session,token) || req.headers['sec-fetch-site']!=='same-origin') throw new DockError('人工接管需要由工作台页面发起', 'human_control_required', 403);
        const project=store.project(takeoverRoute[1]);
        if(project.desktop==='default') throw new DockError('当前桌面无需切换，请直接在官方客户端操作', 'default_desktop', 409);
        if(store.state.projects.some(p=>p.takeover?.active)) throw new DockError('已有正在进行的人工接管', 'human_takeover_active', 409);
        store.pauseProject(project.id, '用户进入工作桌面，后台操作与观察已暂停。');
        native.observations?.clear();
        const control=await native.call('takeover', { desktop: project.desktop });
        project.takeover={active:true,pid:control.pid,startedAt:new Date().toISOString()}; store.save();
        return json(res, { active:true,desktop:project.desktop,returnInstruction:'点击工作桌面左上角的“返回我的桌面”' });
      }
      if (req.method === 'GET' && url.pathname === '/api/integration') return json(res, {
        skillPath: path.join(root, 'skills', 'coordinate-project'),
        command: 'node', args: [path.join(root, 'src', 'mcp.mjs')],
        config: `[mcp_servers.agent_dock]\ncommand = "node"\nargs = [${JSON.stringify(path.join(root, 'src', 'mcp.mjs').replaceAll('\\', '/'))}]\n`,
        instructions: '将统筹 Skill 复制到 Codex 的 skills 目录，并添加这段本地 MCP 配置。重新打开支持本地工具的 Codex 会话后调用 $coordinate-project。工作台必须保持运行。'
      });
      const projectRoute = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(run|pause|messages|tasks|artifacts|export|restore))?$/);
      if (projectRoute) {
        const [, projectId, action] = projectRoute;
        if (req.method === 'PATCH' && !action) return json(res, store.updateProject(projectId, await body(req)));
        if (req.method === 'DELETE' && !action) { await syncTakeovers(store,native); return json(res, store.deleteProject(projectId)); }
        if (req.method === 'POST' && action === 'restore') { await syncTakeovers(store,native); return json(res, store.restoreProject(projectId)); }
        if (req.method === 'POST' && action === 'run') { await syncTakeovers(store,native); const result = store.runProject(projectId); if(coordinatorRuntime)council.activate(projectId);clients.start(projectId,{runningOnly:true});automatic.wake(projectId); return json(res, result); }
        if (req.method === 'POST' && action === 'pause') return json(res, store.pauseProject(projectId));
        if (req.method === 'POST' && action === 'messages') { await syncTakeovers(store,native); const input = await body(req);if(input.mode&&!['new','continue'].includes(input.mode))throw new DockError('消息模式不正确');const message = store.postUser(projectId, input.text, input.requestId,input.attachmentIds);const round=coordinatorRuntime?council.enqueue(projectId,message,{mode:input.mode||'new'}):null;clients.start(projectId,{runningOnly:true});automatic.wake(projectId); return json(res, {...message,...(round?{roundId:round.id}:{})}); }
        if (req.method === 'POST' && action === 'tasks') return json(res, store.createTask(projectId, await body(req)));
        if (req.method === 'GET' && action === 'export') {
          const p = store.project(projectId); res.setHeader('Content-Disposition', `attachment; filename="agentdock-${p.id}.json"`); return json(res, p);
        }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/artifact/')) {
        const [, , , projectId, artifactId] = url.pathname.split('/'); const p = store.project(projectId), artifact = p.artifacts.find(a => a.id === artifactId);
        if (!artifact) throw new DockError('成果不存在', 'not_found', 404);
        const file = store.safePath(p, artifact.relative);
        if (url.searchParams.get('download') === '1') {
          res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
          res.setHeader('Content-Security-Policy', "sandbox allow-downloads; default-src 'none'");
        } else {
          // Generated HTML is a separate, sandboxed origin and cannot control the workbench.
          res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'");
        }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' }); return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && ['/app.js', '/layout.js', '/activity.js', '/workflow.js','/uploads.js','/problems.js', '/styles.css', '/logo.svg','/agents/codex.png','/agents/trae.png','/agents/doubao.png','/agents/doubao-work.png'].includes(url.pathname)) {
        const file = path.join(root, 'web', url.pathname.slice(1)); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] }); return res.end(fs.readFileSync(file));
      }
      return json(res, { error: '页面不存在', code: 'not_found' }, 404);
    } catch (e) { json(res, { error: e.message, code: e.code || 'server_error' }, e.status || 500); }
  });
  // Restored tabs, MCP discovery and server startup are not project activity.
  // Only an explicitly running project can keep its selected clients connected.
  const reconnect=setInterval(()=>clients.reconnect(),30000);reconnect.unref();
  return { server, store, native, clients, automatic, council, token, async close() { clearInterval(reconnect);coordinatorRuntime?.off?.('state',runtimeChanged);council.stop();automatic.stop();clients.stop();for (const res of streams) res.end(); native.stop(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dock = createDock(); const port = Number(process.env.AGENT_DOCK_PORT || 4318);
  dock.server.on('error', e => { console.error(`工作台未启动：${e.message}`); process.exitCode = 1; });
  dock.server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(path.join(dock.store.directory, 'run.json'), JSON.stringify({ pid: process.pid, port: dock.server.address().port, startedAt: new Date().toISOString() }));
    console.log(`AgentDock 已启动：http://127.0.0.1:${dock.server.address().port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await dock.close(); process.exit(0); });
}
