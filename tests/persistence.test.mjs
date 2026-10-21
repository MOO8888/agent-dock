import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {replaceState} from '../src/persistence.mjs';
test('brief Windows destination locks preserve old state and retry the atomic replacement',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dock-persistence-')),target=path.join(directory,'state.json'),temp=target+'.tmp';fs.writeFileSync(target,'old');fs.writeFileSync(temp,'new');let attempts=0;const waited=[];
 replaceState(temp,target,{rename(a,b){if(++attempts<3){assert.equal(fs.readFileSync(target,'utf8'),'old');throw Object.assign(Error('busy'),{code:'EPERM'});}fs.renameSync(a,b);},wait:ms=>waited.push(ms)});
 assert.equal(fs.readFileSync(target,'utf8'),'new');assert.deepEqual(waited,[5,15]);assert.equal(attempts,3);
});
test('permanent permissions failures stay bounded; unrelated failures never retry',()=>{
 let attempts=0;assert.throws(()=>replaceState('a','b',{rename(){attempts++;throw Object.assign(Error('denied'),{code:'EPERM'});},wait(){}}),{code:'EPERM'});assert.equal(attempts,5);
 attempts=0;assert.throws(()=>replaceState('a','b',{rename(){attempts++;throw Object.assign(Error('missing'),{code:'ENOENT'});},wait(){assert.fail();}}),{code:'ENOENT'});assert.equal(attempts,1);
});
