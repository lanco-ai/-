let morningRecords=[],morningPack=null;
const MORNING_FIELDS=[['ask','一问','睡眠、饮食、排便与不适情况'],['look','二看','口腔咽喉、面色与精神状态'],['touch','三摸','体温与皮肤观察情况'],['inspect','四查','手足及随身物品检查情况']];
const morningKeys=new Map();
function clearMorningImport(){morningPack=null;}
function clearMorningState(){morningRecords=[];morningPack=null;morningKeys.clear();}
function morningStatus(v){return v.status==='draft'?'草稿':v.confirmedAt?'家长已确认':'待家长确认';}
async function morningWrite(id,action,data){const fingerprint=id+action+JSON.stringify(data);if(!morningKeys.has(fingerprint)){if(morningKeys.size>100)morningKeys.clear();morningKeys.set(fingerprint,crypto.randomUUID());}return api('/morning/'+id+'/'+action,'POST',{...data,requestKey:morningKeys.get(fingerprint)});}
function morningSummary(){return `<section class="card morning-section"><div class="section-head"><h2>晨检记录</h2><span class="tag">入托前的细心观察</span></div>${morningRecords.length?morningRecords.map(v=>`<div class="list-row between"><div><h3>${esc(v.profile.baby)} · ${esc(v.date)}</h3><p>${esc(v.authorName)} · ${morningStatus(v)}${v.correcting?' · 正在更正':''}</p></div><button class="btn secondary" data-morning="${v.appointmentId}">查看晨检表</button></div>`).join(''):empty('老师提交晨检后，可在这里查看并确认。')}</section>`;}
function morningPage(){const eligible=state.appointments.filter(a=>['confirmed','completed'].includes(a.status));return `${state.user.role==='admin'?`<section class="note"><label for="morning-pack">导入原始晨检表（私有资料包）</label><input id="morning-pack" type="file" accept="application/json,.json"><div id="morning-import-preview"></div></section>`:''}${eligible.length?eligible.map(a=>{const v=morningRecords.find(v=>v.appointmentId===a.id);return `<div class="list-row between"><div><h3>${esc(a.baby)} · ${esc(a.date)}</h3><p>${esc(a.parent)} · ${esc(a.time)} · ${v?morningStatus(v):'尚未填写'}</p></div><button class="btn secondary" data-morning="${a.id}">填写 / 查看晨检</button></div>`;}).join(''):empty('暂无已确认或已完成的预约。')}`;}
function morningBody(v){return `<div class="note"><b>${esc(v.profile.baby)}</b> · ${esc(v.profile.gender)} · ${esc(v.profile.age)} 个月 · ${esc(v.date)}<p>填写人：${esc(v.authorName)}　值班保健医生：${esc(v.doctor||'未登记')}</p><p>第 ${v.revision} 版 · ${morningStatus(v)}${v.submittedAt?' · 提交于 '+fmt(v.submittedAt):''}</p></div>${MORNING_FIELDS.map(([k,t])=>`<section class="morning-item"><h3>${t}</h3><p class="preserve">${esc(v[k]||'未填写')}</p></section>`).join('')}${v.sourceImage?`<section class="morning-item"><h3>原表签名图片</h3><p class="tiny">仅为本份历史原表附件，不代表平台已验证签名人身份。</p><img class="morning-source" src="${v.sourceImage}" alt="原表保健医生签名图片"></section>`:''}${v.signature?`<h3>家长确认签名</h3><img class="agreement-image" src="${v.signature}" alt="家长对本版本晨检的确认签名"><p class="tiny">实际确认时间：${fmt(v.confirmedAt)}</p>`:''}`;}
async function openMorning(id,edit=false){
  const owner=state.user?.id,r=await api('/morning/'+id);if(owner!==state.user?.id)return;
  const v=r.versions[0],a=state.appointments.find(a=>a.id===id);
  if(r.canEdit&&(!v||edit)){showMorningEditor(id,r,a);return;}
  modal('晨检记录',`${v?morningBody(v):empty('这次预约尚无已提交的晨检记录。')}${r.correcting?'<p class="note">老师正在更正记录，待新版本提交后再确认。</p>':''}${r.canEdit?`<div class="form-actions"><button class="btn" data-morning-edit="${id}">${v?.status==='submitted'?'更正并创建新版本':'继续填写'}</button></div>`:''}${r.canConfirm?`<form id="morning-confirm"><label class="check"><input id="morning-agree" type="checkbox" required>我已阅读以上完整晨检内容，确认本次记录。</label><div class="between"><h3>家长手写签名</h3><button type="button" class="textbtn" id="morning-clear">清空签名</button></div><div class="signature"><canvas id="morning-canvas" aria-label="晨检家长手写签名板"></canvas></div><p class="tiny">签名仅用于这次晨检的第 ${v.revision} 版，不复用预约签名。</p><div role="alert" class="error"></div><button class="btn" id="morning-confirm-button" disabled>确认并签字</button></form>`:''}${r.versions.length>1?`<div class="spacer"></div><h3>历史版本</h3>${r.versions.slice(1).map(old=>`<details class="activity-chapter"><summary>第 ${old.revision} 版 · ${morningStatus(old)}</summary>${morningBody(old)}</details>`).join('')}`:''}`);
  if(r.canConfirm)bindMorningSignature(id,v);
}
function showMorningEditor(id,r,a){
  const v=r.versions[0];if(!a)throw new Error('预约信息已变化，请刷新后重新打开');
  modal(v?.status==='submitted'?'更正晨检记录':'填写晨检记录',`<div class="note">${esc(a.baby)} · ${esc(a.gender)} · ${esc(a.age)} 个月 · ${esc(a.date)}<p>宝宝信息来自本次预约。${v?.status==='submitted'?'保存会生成新版本，旧内容及家长签字继续保留。':'草稿仅工作人员可见。'}</p></div><form id="morning-editor">${MORNING_FIELDS.map(([k,t,h])=>`<div class="field"><label for="morning-${k}">${t} · ${h}</label><textarea id="morning-${k}" maxlength="2000" rows="3">${esc(v?.[k]||'')}</textarea></div>`).join('')}<div class="field"><label for="morning-doctor">值班保健医生（选填）</label><input id="morning-doctor" maxlength="100" value="${esc(v?.doctor||'')}" placeholder="填写实际姓名，未提供则显示未登记"></div><div class="error" role="alert"></div><div class="form-actions"><button type="button" class="btn secondary" id="morning-save">保存草稿</button><button type="button" class="btn" id="morning-submit">提交给家长</button></div></form>`);
  let busy=false;const save=async publish=>{
    if(busy)return;busy=true;const f=$('#morning-editor'),buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try{
      const data={baseVersion:v?.id||null,lock:v?.lock||0,doctor:$('#morning-doctor').value};for(const[k]of MORNING_FIELDS)data[k]=$('#morning-'+k).value;
      if(publish){for(const[k,t]of MORNING_FIELDS)if(!data[k].trim())throw new Error('请填写'+t);if(a.date>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}))throw new Error('不能提交未来日期晨检');}
      const result=await morningWrite(id,'save',data),saved=result.versions[0];
      if(publish&&saved.status==='draft')await morningWrite(id,'submit',{versionId:saved.id,lock:saved.lock});
      await render();await openMorning(id);toast(publish?'晨检已提交，等待家长确认':'晨检草稿已保存');
    }catch(e){f.querySelector('[role=alert]').textContent=e.message;}finally{busy=false;buttons.forEach(b=>b.disabled=false);}
  };
  $('#morning-editor').onsubmit=e=>e.preventDefault();$('#morning-save').onclick=()=>save(false);$('#morning-submit').onclick=()=>save(true);
}
function bindMorningSignature(id,v){
  const canvas=$('#morning-canvas'),ctx=canvas.getContext('2d');canvas.width=1000;canvas.height=250;ctx.strokeStyle='#294936';ctx.lineWidth=3.5;ctx.lineCap='round';let drawing=false,distance=0,last=null;
  const pos=e=>{const b=canvas.getBoundingClientRect();return[(e.clientX-b.x)*1000/b.width,(e.clientY-b.y)*250/b.height];};
  const update=()=>{$('#morning-confirm-button').disabled=distance<12||!$('#morning-agree').checked;};
  canvas.onpointerdown=e=>{e.preventDefault();drawing=true;last=pos(e);canvas.setPointerCapture(e.pointerId);ctx.beginPath();ctx.moveTo(...last);};
  canvas.onpointermove=e=>{if(!drawing)return;e.preventDefault();const p=pos(e);distance+=Math.hypot(p[0]-last[0],p[1]-last[1]);last=p;ctx.lineTo(...p);ctx.stroke();update();};canvas.onpointerup=canvas.onpointercancel=()=>{drawing=false;};
  $('#morning-agree').onchange=update;$('#morning-clear').onclick=()=>{ctx.clearRect(0,0,1000,250);distance=0;update();};
  handleForm('#morning-confirm',async()=>{await morningWrite(id,'confirm',{versionId:v.id,lock:v.lock,agreed:$('#morning-agree').checked,signature:canvas.toDataURL('image/png')});await render();await openMorning(id);toast('本版本晨检已确认');});
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  try{if(b.dataset.morning)await openMorning(b.dataset.morning);else if(b.dataset.morningEdit)await openMorning(b.dataset.morningEdit,true);}catch(error){toast(error.message);}
});
document.addEventListener('change',async e=>{
  if(e.target.id!=='morning-pack')return;const input=e.target,owner=state.user?.id,target=$('#morning-import-preview');morningPack=null;target.textContent='';
  try{
    const file=input.files[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('晨检包最大 2MB');
    const p=JSON.parse(await file.text());if(owner!==state.user?.id||!input.isConnected)return;
    if(p.format!=='jinlin-morning-v1'||!p.profile||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!p.signature||!['image/png','image/jpeg','image/webp'].includes(p.signature.mime)||typeof p.signature.base64!=='string'||p.signature.base64.length>1500000)throw new Error('晨检资料包格式不正确');
    atob(p.signature.base64);morningPack=p;
    target.innerHTML=`<p>${esc(p.profile.baby)} · ${esc(p.profile.gender)} · ${esc(p.profile.age)} 个月 · ${esc(p.date)}</p>${MORNING_FIELDS.map(([k,t])=>`<p><b>${t}：</b>${esc(p[k])}</p>`).join('')}<p>值班保健医生：${esc(p.doctor||'未登记')}。原表图片不会用于家长确认。</p><img class="morning-source" src="data:${p.signature.mime};base64,${p.signature.base64}" alt="本机预览原表签名图片"><label for="morning-import-appointment">关联真实预约</label><select id="morning-import-appointment"><option value="">请选择对应家长和宝宝的预约</option>${state.appointments.filter(a=>['confirmed','completed'].includes(a.status)).map(a=>`<option value="${a.id}">${esc(a.parent)} / ${esc(a.baby)} · ${a.date}</option>`).join('')}</select><p class="tiny">姓名、性别、月龄、日期必须全部匹配；本次预约已有晨检时不能导入。</p><button type="button" class="btn" id="morning-import-button">核对并导入原表</button><div id="morning-import-error" role="alert" class="error"></div>`;
    $('#morning-import-button').onclick=importMorning;
  }catch(error){morningPack=null;input.value='';target.textContent=error.message;}
});
async function importMorning(){
  const button=$('#morning-import-button');if(button.disabled)return;button.disabled=true;
  try{
    const p=morningPack,id=$('#morning-import-appointment').value,a=state.appointments.find(a=>a.id===id);if(!p||!a)throw new Error('请选择真实预约');
    if(p.profile.baby!==a.baby||p.profile.gender!==a.gender||String(p.profile.age)!==String(a.age)||p.date!==a.date)throw new Error('原表姓名、性别、月龄或日期与预约不匹配');
    if(p.date>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}))throw new Error('不能导入未来日期晨检');
    if((await api('/morning/'+id)).versions.length)throw new Error('本次预约已有晨检，不能覆盖');
    const bytes=Uint8Array.from(atob(p.signature.base64),c=>c.charCodeAt(0));
    const uploaded=await fetch('/api/upload/'+id+'?purpose=morning',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':state.csrf,'Content-Type':p.signature.mime},body:bytes});
    const media=await uploaded.json();if(!uploaded.ok)throw new Error(media.error||'附件上传失败');
    await morningWrite(id,'import',{profile:p.profile,date:p.date,doctor:p.doctor||'',...Object.fromEntries(MORNING_FIELDS.map(([k])=>[k,p[k]])),sourceMediaId:media.id});
    await render();await openMorning(id);toast('原表已导入，等待家长确认');
  }catch(error){if($('#morning-import-error'))$('#morning-import-error').textContent=error.message;else toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
}
