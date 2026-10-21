import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash,randomUUID} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const name=`AgentDock-v${version}-source-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,6)}`;
const output=path.join(root,'release',name),entries=[];
const files=['.gitignore','.gitattributes','LICENSE','NOTICE.md','README.md','CONTRIBUTING.md','SECURITY.md','CHANGELOG.md','package.json','start.cmd'];
const directories=['src','web','native','scripts','tests','skills','docs','.github'];
const allowed=new Set(['.mjs','.js','.css','.html','.svg','.png','.cs','.ps1','.cmd','.md','.yml','.yaml']);
function include(relative){
  const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);
  if(stat.isSymbolicLink())throw Error(`Source links are not allowed: ${relative}`);
  if(stat.isDirectory()){
    for(const child of fs.readdirSync(absolute).sort()){
      if(child==='bin'||child==='node_modules'||child.startsWith('.env'))continue;
      include(path.join(relative,child));
    }return;
  }
  if(!stat.isFile()||(!files.includes(relative)&&!allowed.has(path.extname(relative))))return;
  const bytes=fs.readFileSync(absolute);
  if(path.extname(relative)!=='.png'){
    const source=bytes.toString('utf8');
    // Reject credential material and development-machine references without
    // ever printing their contents. This is a release check, not a complete
    // secret scanner; the source allowlist is the primary data boundary.
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{30,}|C:[\\/]Users[\\/]Administrator[\\/]|wxid_[A-Za-z0-9_]+/.test(source))throw Error(`Private material or machine-specific reference: ${relative}`);
  }
  entries.push({path:relative.split(path.sep).join('/'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),bytes});
}
for(const file of files)include(file);for(const directory of directories)include(directory);
// Validate all entries before writing any part of the export.
fs.mkdirSync(output,{recursive:true});
for(const entry of entries){const target=path.join(output,entry.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,entry.bytes);}
const manifest={name:'AgentDock',version,kind:'source-only',files:entries.map(({bytes,...entry})=>entry)};
fs.writeFileSync(path.join(output,'SOURCE-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({folder:output,archive:output+'.zip',files:entries.length,version}));
