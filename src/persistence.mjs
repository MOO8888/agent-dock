import fs from 'node:fs';
// Windows indexers/virus scanners can briefly hold an existing destination.
// Keep the old file intact and retry the atomic rename for at most 110 ms.
export function replaceState(temp,target,{rename=fs.renameSync,wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
  const delays=[5,15,30,60];
  for(let attempt=0;;attempt++)try{rename(temp,target);return;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===delays.length)throw error;wait(delays[attempt]);}
}
