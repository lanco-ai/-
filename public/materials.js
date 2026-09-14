let importedPhotos=[],importedUrls=[];
function clearImportedPhotos(){for(const u of importedUrls)URL.revokeObjectURL(u);importedUrls=[];importedPhotos=[];}
function fillAgreement(template,profile,organization){
  // Agreements are signed before teacher allocation. Never substitute a later assignment into a signed document.
  const values={organization:organization||'',baby:profile.baby,age:profile.age,parent:profile.parent,phone:profile.phone,date:profile.date,address:profile.address,gender:profile.gender,allergy:profile.allergy,allergyNote:profile.allergy==='无'?'无已申报过敏史':(profile.allergyNote||'未填写'),notes:profile.notes||'未填写',emergency:profile.emergency,teacher:'待分配（签署时）'};
  return String(template).replace(/\{\{(organization|baby|age|parent|phone|date|address|gender|allergy|allergyNote|notes|emergency|teacher)\}\}/g,(_,key)=>String(values[key]??'待填写'));
}
function showServiceInfo(){modal('了解普惠托育',`<p class="note">以下为机构提供的托育介绍及服务发展建议，其中提到的监控、医育结合等不代表本平台已提供这些服务；具体以机构实际安排为准。</p><div class="material-reading">${MATERIAL_CONTENT.serviceParagraphs.map(p=>`<p>${esc(p)}</p>`).join('')}</div>`);}
function materialChapters(id){
  const chapters=MATERIAL_CONTENT.chapters.filter(c=>c.resource===Number(id));if(!chapters.length)return '';
  return `<section class="card material-intro"><span class="tag">亲子活动章节</span><h2>在陪伴中，发现小小成长</h2>${chapters.map(c=>`<details class="activity-chapter"><summary>${esc(c.title)}</summary><p>${esc(c.intro)}</p><p>具体练习方案正在由机构审核。请结合宝宝当前能力与意愿，由负责老师提供适合的活动安排。</p>${state.user?.role==='admin'?`<button class="textbtn" data-activity-review="${c.id}">查看完整原稿与核对事项</button>`:''}</details>`).join('')}<div class="note"><b>日常陪伴建议</b><p>在安全地垫上，将玩具放在稍远处，鼓励宝宝以自己会的方式探索；留在身边陪伴，关注宝宝的反应。有发育方面的疑问，与儿科医生交流。</p><a class="textbtn" href="https://www.cdc.gov/act-early/milestones/9-months.html" target="_blank" rel="noopener noreferrer">参考：CDC 9 月龄陪伴建议 ↗</a></div></section>`;
}
async function loadMaterialPolicies(){
  const owner=state.user?.id,form=$('#policy-form');if(!form||$('#policy-type')?.value!=='home')return;const m=await api('/admin/materials');if(owner!==state.user?.id||!form.isConnected||$('#policy-type')?.value!=='home')return;
  m.agreements.forEach((d,i)=>{$('#policy-'+i).value=d.text;});
  if(!$('#organization').value)$('#organization').value='近邻托育';
  $('#policy-reviewed').checked=false;
  $('#policy-review-notes').innerHTML=`<b>候选文本已载入，尚未发布</b><p>协议来源：${esc(m.agreementSource||'机构提供的协议文档')}</p>${m.reviewNotes.map(n=>`<p>${esc(n)}</p>`).join('')}<p>双花括号字段由本次预约自动带入，请勿填入固定宝宝或家长信息。第三份登记表保持原样。</p>`;
  toast('两份候选协议已载入，请编辑核对后发布');
}
async function showActivityReview(id){
  const m=await api('/admin/materials'),a=m.activities.find(a=>a.id===id);if(!a)throw new Error('活动不存在');
  modal(a.title,`<div class="note"><b>机构待审原稿 · 尚未作为家长训练指导发布</b><p>需专业核对：统一 6–9 月龄适用范围、15 分钟时长、每日练习量、饭后等待时间、皮球或卷巾辅助、扶站蹬跳以及障碍高度。CDC 与 AAP 的一般陪伴资料不足以逐项支持这些具体要求；原稿中的发育因果和损伤断言也需核对。</p><a href="https://www.cdc.gov/act-early/milestones/9-months.html" target="_blank" rel="noopener noreferrer">CDC 参考资料</a> · <a href="https://www.healthychildren.org/English/ages-stages/baby/Pages/how-active-is-your-baby.aspx" target="_blank" rel="noopener noreferrer">AAP 参考资料</a></div><div class="material-reading">${a.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}</div>`);
}
function bindPrivateImport(){
  const input=$('#private-pack');if(!input)return;
  input.onchange=async()=>{
    clearImportedPhotos();const target=$('#private-preview'),owner=state.user?.id;target.textContent='';
    try{
      const file=input.files[0];if(!file)return;if(file.size>16*1024*1024)throw new Error('资料包超过 16MB');
      const pack=JSON.parse(await file.text());
      if(state.user?.id!==owner||!input.isConnected)return;
      if(pack.format!=='jinlin-private-materials-v1'||!Array.isArray(pack.photos)||pack.photos.length<1||pack.photos.length>8)throw new Error('资料包格式不正确');
      const files=pack.photos.map((p,i)=>{
        if(!['image/jpeg','image/png','image/webp'].includes(p.mime)||typeof p.base64!=='string'||p.base64.length>14*1024*1024)throw new Error('资料包图片格式或大小不正确');
        const raw=atob(p.base64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
        return new File([bytes],`activity-${i+1}`,{type:p.mime});
      });
      importedPhotos=files;importedUrls=files.map(f=>URL.createObjectURL(f));
      $('#title').value=String(pack.title||'活动观察').slice(0,100);$('#text').value=String(pack.text||'').slice(0,1000);
      $('#appointmentId').value='';$('#occurredAt').value='';$('#media-files').value='';
      target.innerHTML=`<p>已在本机读取 ${files.length} 张活动照片。请选择对应家长的预约并填写真实活动时间，再发布。</p><div class="record-media">${importedUrls.map(u=>`<img src="${u}" alt="待关联的活动照片">`).join('')}</div>`;
    }catch(e){clearImportedPhotos();target.textContent='';input.value='';toast(e.message||'无法读取资料包');}
  };
}

// General reading never receives a booking or personal profile.
function generalAgreementText(template,organization){
  return String(template).replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_,key)=>key==='organization'?(organization||'机构尚未填写'):key==='teacher'?'预约时确认，未分配时显示待分配':'预约时填写');
}
function privacyContent(){
  const actions=!state.user?'<button class="btn" data-privacy-route="login">登录后预约签署</button>':state.user.role==='parent'?'<button class="btn" data-privacy-route="booking">去预约签署</button><button class="btn secondary" data-privacy-route="personal/agreements">查看我的已签协议</button>':'<button class="btn" data-privacy-route="staff">进入工作台</button>';
  return `<p class="note">通用阅读版本，预约时填写资料并签署。发布协议不代表家长已经签署；本窗口不展示个人资料或签名。</p><div class="form-actions">${actions}</div>${state.policy?`<p>${esc(state.policy.organization)} · ${esc(state.policy.contact)}</p>${state.policy.documents.map(d=>`<section class="agreement-body"><h3>${esc(d.title)}</h3><div class="policy-text">${esc(generalAgreementText(d.text,state.policy.organization))}</div></section>`).join('')}`:'<p>机构尚未发布正式协议，请联系管理员。</p>'}`;
}
