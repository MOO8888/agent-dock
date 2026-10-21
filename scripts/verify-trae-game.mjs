import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Runs the reviewed, local single-file game without modifying it. Input uses
// its real key listeners; physics uses its real animation callback. Canvas
// drawing is recorded to inspect visible player coordinates and HUD messages.
if(!process.argv[2]) { console.error('用法：node scripts/verify-trae-game.mjs <本地游戏HTML路径>'); process.exit(2); }
const file = path.resolve(process.argv[2]);
const html = fs.readFileSync(file,'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match=>match[1]).join('\n');
assert.ok(script); assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|require|import)\s*\(/.test(script),'reviewed game has no external calls');
let animation, now=0, text=[], player, curve=[];
const events=new Map();
const ctx = new Proxy({
  createLinearGradient() { return {colors:[], addColorStop(position,color) {this.colors.push(color);}}; },
  beginPath() {curve=[];}, moveTo(x,y) {curve.push([x,y]);}, arcTo(x,y) {curve.push([x,y]);},
  fill() { if(this.fillStyle?.colors?.includes('#ff7d8e')&&curve.length) player={x:curve[0][0]-8,y:curve[0][1]}; },
  fillText(value) {text.push(String(value));}
}, {get(target,key) {return key in target ? target[key] : ()=>{};}});
const context={ document:{hidden:false,addEventListener(type,callback) {events.set(type,callback);},getElementById:()=>({getContext:()=>ctx})}, performance:{now:()=>now}, Math,
  window:{addEventListener(type,callback) {events.set(type,callback);}}, requestAnimationFrame(callback) {animation=callback;} };
vm.runInNewContext(script,context,{timeout:1000,filename:path.basename(file)});
function tick(count=1) { for(let i=0;i<count;i++) {now+=1000/120;text=[];animation(now);} }
function down(code) {events.get('keydown')({code,repeat:false,preventDefault(){}});}
function up(code) {events.get('keyup')({code,preventDefault(){}});}
function tap(code) {down(code);up(code);tick();}
function advance(seconds) {tick(Math.ceil(seconds*120));}
function reset() {up('KeyD');up('KeyA');up('Space');tap('KeyR');advance(.1);}
function moveTo(x,limit=6,finish=false) {
  const direction=player.x<x?'KeyD':'KeyA'; down(direction);
  let count=0;
  while((direction==='KeyD'?player.x<x:player.x>x)&&count++<limit*120) {tick();if(finish&&text.includes('通关成功！'))break;}
  up(direction); advance(.3);
  assert.ok(count<limit*120,`move toward ${x} stopped at ${player.x}`);
  assert.ok(!text.some(s=>s.includes('掉下去了')),`fell while moving toward ${x}`);
}
function leapTo(x,limit=1.7) {
  down('Space');down('KeyD');let count=0;
  while(player.x<x&&count++<limit*120)tick();
  up('KeyD');up('Space');advance(.6);
  assert.ok(count<limit*120,`jump toward ${x} stopped at ${player.x}`);
  assert.ok(!text.some(s=>s.includes('掉下去了')),`fell while jumping toward ${x}`);
}
const checks=[],route=[],metrics={};
process.on('uncaughtException',error=>{
  const failure={passed:false,at:new Date().toISOString(),source:file,error:error.message,checks,metrics,route,player,text};
  fs.mkdirSync('artifacts/trae-integration',{recursive:true});fs.writeFileSync('artifacts/trae-integration/game-behavior.json',JSON.stringify(failure,null,2));
  console.error(JSON.stringify(failure,null,2));process.exitCode=1;
});
tick();assert.ok(text.includes('星核收集'));tap('Space');advance(.1);
const start={...player};down('KeyD');advance(.3);up('KeyD');advance(.2);assert.ok(player.x>start.x+40);checks.push('right movement');
const right={...player};down('KeyA');advance(.2);up('KeyA');advance(.2);assert.ok(player.x<right.x-20);checks.push('left movement');
reset();const ground={...player};down('Space');let minY=ground.y;
for(let i=0;i<96;i++){tick();minY=Math.min(minY,player.y);}
up('Space');metrics.jumpRise=ground.y-minY;assert.ok(metrics.jumpRise>50);assert.ok(Math.abs(player.y-ground.y)<1);checks.push('jump and platform landing');
reset();down('KeyD');advance(3);up('KeyD');assert.ok(text.includes('你掉下去了！'));checks.push('fall failure');tap('KeyR');assert.ok(!text.includes('你掉下去了！'));assert.ok(player.x<70);checks.push('restart after failure');

reset();
function record(label) {route.push({label,player:{...player},hud:text.find(s=>s.startsWith('星核  ')),state:text.find(s=>/掉下去了|通关成功/.test(s))||'playing'});}
moveTo(306);leapTo(420);down('Space');advance(.3);up('Space');advance(.6);record('first collectible');
leapTo(600);moveTo(630);leapTo(735);record('second platform');assert.ok(player.y<400,'second collectible platform cannot be reached by this jump');
down('Space');advance(.3);up('Space');advance(.6);record('second collectible');
moveTo(846);leapTo(1000);down('Space');advance(.3);up('Space');advance(.6);record('third collectible');
moveTo(1060);leapTo(1248);down('Space');advance(.3);up('Space');advance(.6);record('fourth collectible');
moveTo(1308);leapTo(1436);record('bridge platform');
moveTo(1460);leapTo(1655);down('Space');advance(.3);up('Space');advance(.6);record('fifth collectible');
moveTo(1700);leapTo(1900);record('last gap');
moveTo(2090);leapTo(2190);moveTo(2465,6,true);record('goal');
assert.ok(text.includes('通关成功！'),'goal triggers victory');assert.ok(text.includes('星核收集：5 / 5'),'all five collectibles can be reached');
checks.push('collect five items through actual movement and jumps','reach goal and win');
tap('KeyR');assert.ok(player.x<70&&!text.includes('通关成功！'));checks.push('restart after victory');
down('KeyD');advance(.2);events.get('blur')();advance(.6);const stopped={...player};advance(.3);assert.ok(Math.abs(player.x-stopped.x)<1);checks.push('blur clears held movement');
down('KeyD');advance(.2);context.document.hidden=true;events.get('visibilitychange')();advance(.6);const hiddenStop={...player};advance(.3);assert.ok(Math.abs(player.x-hiddenStop.x)<1);checks.push('hidden document clears held movement');
const result={passed:true,at:new Date().toISOString(),source:file,checks,metrics,route,limitations:['Canvas behavior harness passed; visual browser inspection is separate.','No arbitrary game-state mutation or production-code changes were used.']};
const report=path.resolve('artifacts/trae-integration/game-behavior.json');fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
