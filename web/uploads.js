export function attachmentComposer({form,getProject,onChange,onError}) {
  const drafts=new Map();let sequence=0;
  const list=id=>{if(!drafts.has(id))drafts.set(id,[]);return drafts.get(id);};
  const chips=document.querySelector('#attachment-drafts'),picker=document.querySelector('#file-upload');
  function render(){const id=getProject()?.id;if(!id)return;chips.replaceChildren();for(const item of list(id)){
    const chip=document.createElement('span');chip.className='attachment-chip '+item.status;
    const text=document.createElement('span');text.textContent=(item.status==='uploading'?'上传中 · ':item.status==='error'?'上传失败 · ':'')+item.name;chip.append(text);
    if(item.status==='ready'){const size=document.createElement('small');size.textContent=`${(item.size/1024).toFixed(1)} KB`;chip.append(size);}
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',`移除 ${item.name}`);remove.disabled=item.status==='uploading';remove.onclick=()=>{drafts.set(id,list(id).filter(file=>file.localId!==item.localId));render();onChange();};chip.append(remove);chips.append(chip);
  }}
  async function add(files){const id=getProject()?.id;if(!id)return;const chosen=[...files];if(list(id).length+chosen.length>20){onError('每条消息最多附加 20 个文件');return;}
    for(const file of chosen){if(file.size>100*1024*1024){onError(`${file.name} 超过单文件 100 MB 限制`);continue;}
      const item={localId:++sequence,name:file.name,status:'uploading'};list(id).push(item);render();onChange();
      try{const response=await fetch(`/api/projects/${id}/attachments`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file});const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');Object.assign(item,result,{status:'ready'});}
      catch(error){item.status='error';onError(`${file.name}：${error.message}`);}finally{render();onChange();}
    }
  }
  document.querySelector('#attach-files').onclick=()=>picker.click();picker.onchange=()=>{add(picker.files);picker.value='';};
  form.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();form.classList.add('drop-target');}});
  form.addEventListener('dragleave',()=>form.classList.remove('drop-target'));
  form.addEventListener('drop',event=>{if(event.dataTransfer.files.length){event.preventDefault();form.classList.remove('drop-target');add(event.dataTransfer.files);}});
  form.addEventListener('paste',event=>{if(event.clipboardData?.files.length){event.preventDefault();add(event.clipboardData.files);}});
  return {render,ids:id=>list(id).filter(i=>i.status==='ready').map(i=>i.id),uploading:id=>list(id).some(i=>i.status==='uploading'),clear(id,ids){drafts.set(id,list(id).filter(item=>!ids.includes(item.id)));render();}};
}
