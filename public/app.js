// Only the server owns persistent business state. No account or childcare data is stored in localStorage.
let state={user:null,csrf:null,profile:{},draft:{},appointments:[],favorites:[],slots:[],teachers:[],policy:null};
let daily=null,records=[],recordNext=null,posts=[],postNext=null,currentPost=null,comments=[],commentNext=null;
let agreementIndex=0,signData='',hasSignature=false,agreed=false,requestKey=null;
let generation=0,draftTimer=null,draftFlight=Promise.resolve(),draftDirty=false,returnFocus=null;
const STATUS={pending:'待确认',confirmed:'已确认',completed:'已完成',rejected:'未通过',cancelled:'已取消'};
const fmt=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const staff=()=>state.user&&state.user.role!=='parent';

async function api(path,method='GET',data) {
  const headers={};
  if(method!=='GET'){headers['X-CSRF-Token']=state.csrf||'';if(data!==undefined)headers['Content-Type']='application/json';}
  let response;
  try{response=await fetch('/api'+path,{method,headers,credentials:'same-origin',body:data===undefined?undefined:JSON.stringify(data)});}
  catch{throw new Error('无法连接服务器，请检查网络后重试');}
  const result=await response.json().catch(()=>({error:'服务器响应异常，请稍后重试'}));
  if(!response.ok){
    if(response.status===401&&path!=='/login'){clearSession();go('login');}
    const error=new Error(result.error||'操作失败');error.fields=result.fields;error.status=response.status;throw error;
  }
  return result;
}
async function refresh(){const expected=state.user?.id;const b=await api('/bootstrap');if(state.user?.id===expected)state={...state,...b};}
function queueDraft(){draftDirty=true;clearTimeout(draftTimer);draftTimer=setTimeout(()=>flushDraft().catch(e=>toast(e.message)),650);}
function flushDraft(){
  clearTimeout(draftTimer);
  if(draftDirty&&state.user?.role==='parent'){
    const value={...state.draft},owner=state.user.id;draftDirty=false;
    draftFlight=draftFlight.catch(()=>{}).then(()=>state.user?.id===owner?api('/draft','PUT',value):undefined).catch(error=>{if(state.user?.id===owner)draftDirty=true;throw error;});
  }
  return draftFlight;
}
function resetSignature(){clearJourneySignatures();signData='';hasSignature=false;agreed=false;requestKey=null;agreementIndex=0;}
function clearSession(){clearConsultationState();clearModuleState();clearMorningState();clearImportedPhotos();clearTimeout(draftTimer);draftDirty=false;state={user:null,csrf:null,policy:state.policy,profile:{},draft:{},appointments:[],favorites:[],slots:[],teachers:[]};daily=null;records=[];posts=[];comments=[];currentPost=null;recordNext=postNext=commentNext=null;resetSignature();}
function shell(content,page){
  const active=['profile','booking','agreements','success','growth','morning','personal'].includes(page)?'service':page==='article'?'knowledge':['resource','resources'].includes(page)?'knowledge':page==='post'?'community':page;
  return `<header class="topbar"><div class="navwrap">${brand()}<a href="#/${staff()?'staff':'personal'}" class="account"><span class="avatar">${esc(state.user.name[0])}</span><span>${staff()?'老师工作台':'我的托育'}</span></a></div></header><main class="container">${content}</main><footer class="footer"><span>近邻托育 · 用心陪伴每一步成长</span><span><button class="textbtn" data-action="privacy">隐私与服务协议</button> · <button class="textbtn" data-action="password">修改密码</button> · <button class="textbtn" data-action="logout">退出登录</button></span></footer><nav class="bottom-tabs" aria-label="主要模块">${Object.entries(paths).map(([r,t])=>`<a href="#/${r}" ${active===r?'aria-current="page"':''}>${icon({home:'home',service:'calendar',knowledge:'book',community:'chat',resources:'folder',consultation:'chat'}[r])}<span>${t}</span></a>`).join('')}</nav>`;
}
function login(register=false){return `<main class="login"><div class="login-visual"><img src="assets/childcare.png" alt="托育阅读主题配图">${brand()}<div class="login-copy"><div class="eyebrow" style="color:#F8E8EB">CARE CLOSE TO HOME</div><h1>家门口的<br>科学托育服务</h1><p>让每一份托付，都被温柔接住。</p></div></div><div class="login-panel"><div><span class="iconbox">${icon('heart')}</span><h1>${register?'创建家长账号':'欢迎来到近邻托育'}</h1><p>${register?'注册后填写宝宝档案，开始预约。':'登录你的账号，查看宝宝的每一天。'}</p><form id="auth-form" data-register="${register}" style="margin-top:24px">${register?field('name','显示名称','text',''):''}${field('username','账号','text','')}${field('password','密码','password','')}<p class="tiny">账号为 4–32 位字母、数字或下划线；密码至少 12 位。</p>${register?`<label class="check"><input type="checkbox" id="consent" required>我已阅读并同意隐私协议，了解账户信息的处理方式。</label><button type="button" class="textbtn" data-action="privacy">阅读隐私协议</button>${!state.policy?'<p class="error">机构尚未发布正式协议，暂未开放注册。</p>':''}`:''}<div class="error" id="auth-error" role="alert"></div><button class="btn" ${register&&!state.policy?'disabled':''}>${register?'注册家长账号':'登录'}</button></form><div class="row" style="justify-content:center;margin-top:18px"><a class="textbtn" href="#/${register?'login':'register'}">${register?'已有账号，去登录':'还没有账号？注册'}</a></div><p class="tiny" style="margin-top:18px">忘记密码请联系机构管理员核验身份后重置。${state.policy?`<br>${esc(state.policy.contact)}`:''}</p></div></div></main>`;}
function home(){return institutionHome();}
function selectedDraft(){const s=state.slots.find(s=>s.id===state.draft.slotId);return {...state.profile,...state.draft,date:s?.date||'',time:s?`${s.start}–${s.end}`:''};}
function formPage(booking){if(staff())return head('请使用家长账号填写宝宝资料')+btn('进入工作台','staff');const d=booking?selectedDraft():state.profile;
  const slots=state.slots.filter(s=>s.service_type===d.serviceType&&state.policies?.[s.service_type]&&s.enabled&&s.remaining>0&&Date.parse(`${s.date}T${s.start}:00+08:00`)>Date.now());
  const selected=state.slots.find(s=>s.id===d.slotId);
  return head(booking?'预约托育':'宝宝档案',booking?'选择开放时段，填写宝宝信息并完成协议确认。':'多了解宝宝一点，照护就能更贴心一点。','service')+(booking?steps(0):'')+`<form id="care-form" novalidate data-kind="${booking?'booking':'profile'}"><div class="${booking?'split':''}"><div class="card formcard">${booking?`<h2>选择服务</h2>${serviceTypeSelect('serviceType',d.serviceType)}${d.serviceType==='home'?field('address','入户详细地址','textarea',d.address):''}<h2>预约时间</h2>${!state.policies?.[d.serviceType]?'<p class="error">请选择服务类型；该类型需由机构发布适用协议后才能预约。</p>':''}${!slots.length?'<div class="note">目前没有可预约的时段，请稍后再来或联系机构。</div>':''}<div class="fields"><div class="field"><label for="date">预约日期 *</label><select id="date"><option value="">请选择日期</option>${[...new Set([...slots,...(selected?[selected]:[])].map(s=>s.date))].sort().map(date=>`<option value="${date}" ${date===d.date?'selected':''}>${date}</option>`).join('')}</select></div><div class="field"><label for="slotId">预约时间 *</label><select id="slotId" name="slotId">${slotOptions(d.date,d.slotId)}</select><div class="error" id="error-slotId"></div></div></div><div class="spacer"></div>`:''}<h2>宝宝与家长信息</h2><div class="fields">${fieldDefs.map(([k,l,t,r])=>field(k,l,t,d[k],r!==false)).join('')}</div><div class="form-actions">${btn('返回','service',true)}<button class="btn" ${booking&&(!state.policies?.[d.serviceType]||!slots.length)?'disabled':''}>${booking?'下一步：协议确认':'保存档案'}</button></div><div id="saved-profile"></div></div>${booking?`<aside class="card summary"><h3>本次预约</h3><div id="live-summary">${summary(d)}</div><div class="note">待确认的预约也会占用名额。提交后由机构确认安排。</div></aside>`:''}</div></form>`;
}
function slotOptions(date,id){return '<option value="">请选择时段</option>'+state.slots.filter(s=>s.date===date&&s.service_type===state.draft.serviceType).map(s=>{const available=s.enabled&&s.remaining>0&&Date.parse(`${s.date}T${s.start}:00+08:00`)>Date.now();return `<option value="${s.id}" ${s.id===id?'selected':''} ${available?'':'disabled'}>${s.start}–${s.end} · ${available?`剩余 ${s.remaining} 位`:'不可预约'}</option>`}).join('');}
function validateLocal(d,booking){const errors={};for(const[k,l,,r]of fieldDefs)if(r!==false&&!String(d[k]??'').trim())errors[k]='请填写'+l;
  if(!/^\d{1,2}$/.test(d.age)||Number(d.age)>36)errors.age='请输入 0–36 之间的整数月龄';
  if(!/^1\d{10}$/.test(d.phone))errors.phone='请输入 11 位手机号码';
  if(d.allergy==='有'&&!d.allergyNote?.trim())errors.allergyNote='请填写过敏情况';
  if(booking&&!['home','center'].includes(d.serviceType))errors.serviceType='请选择服务类型';if(booking&&d.serviceType==='home'&&(!d.address?.trim()||d.address.length>300))errors.address='请填写入户详细地址，最多300字';if(booking&&!d.slotId)errors.slotId='请选择预约时间';return errors;
}
function showFields(errors){$$('.error[id^="error-"]').forEach(el=>el.textContent='');$$('.invalid').forEach(el=>el.classList.remove('invalid'));
  for(const[k,t]of Object.entries(errors||{})){if($('#error-'+k))$('#error-'+k).textContent=t;$('#'+k)?.classList.add('invalid');}$('#'+Object.keys(errors||{})[0])?.focus();}
function agreementBody(i,d,documents=state.policy?.documents,organization=state.policy?.organization,resolved=false){const doc=documents?.[i];if(!doc)return '<p>机构尚未发布此协议。</p>';
  return `<h2>${esc(doc.title)}</h2><div class="policy-text">${esc(resolved?doc.text:fillAgreement(doc.text,d,organization))}</div>${i===2?`<div class="summary">${summary(d)}</div>${fieldDefs.filter(([k])=>!['baby','age','parent','phone'].includes(k)).map(([k,l])=>`<p><strong>${l}：</strong>${esc(d[k]||'未填写')}</p>`).join('')}`:''}`;
}
function bindSignature(){const c=$('#signature'),ctx=c.getContext('2d');c.width=1000;c.height=250;ctx.strokeStyle='#294936';ctx.lineWidth=3.5;ctx.lineCap='round';let drawing=false,last=null,distance=0;
  if(signData){const im=new Image();im.onload=()=>ctx.drawImage(im,0,0,c.width,c.height);im.src=signData;}
  const pos=e=>{const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height];};
  c.onpointerdown=e=>{e.preventDefault();if(!hasSignature)distance=0;drawing=true;c.setPointerCapture(e.pointerId);last=pos(e);ctx.beginPath();ctx.moveTo(...last);};
  c.onpointermove=e=>{if(!drawing)return;e.preventDefault();const p=pos(e);distance+=Math.hypot(p[0]-last[0],p[1]-last[1]);last=p;ctx.lineTo(...p);ctx.stroke();if(distance>12){hasSignature=true;$('.signature .hint').hidden=true;$('#submit-appointment').disabled=!agreed;}};
  const finish=()=>{drawing=false;if(hasSignature)signData=c.toDataURL('image/png');};c.onpointerup=finish;c.onpointercancel=finish;
  $('#agree').onchange=e=>{agreed=e.target.checked;$('#submit-appointment').disabled=!agreed||!hasSignature;};
}
function success(){const d=state.appointments[0];if(!d)return head('暂无已提交的预约')+btn('去预约','booking');return steps(2)+`<section class="card success"><div class="success-symbol">✓</div><h1>预约提交成功</h1><p>请等待机构确认具体安排。<br>预约和协议已保存至“我的托育”。</p><div class="summary">${summary(d)}</div><div class="row">${btn('查看我的预约','personal/appointments')}${btn('查看宝宝成长记录','growth',true)}</div><a class="textbtn" href="#/home" style="display:inline-block;margin-top:20px">返回首页</a></section>`;}
function growthCard(r){return `<div class="timeline-item"><time>${fmt(r.occurred_at)} · ${esc(r.baby)}</time><h3>${esc(r.title)}</h3><p class="preserve">${esc(r.text)}</p><div class="record-media">${r.media.map(m=>m.mime.startsWith('video/')?`<video controls preload="metadata" src="${m.url}" aria-label="宝宝活动视频"></video>`:`<button class="record-photo" data-photo="${m.id}" aria-label="查看宝宝活动照片"><img src="${m.url}" alt="宝宝活动照片" loading="lazy"></button>`).join('')}</div><div class="teacher-reply"><b>${esc(r.teacher_name)} · 老师记录</b>${r.game_activity?`<div class="game-activity preserve"><b>游戏活动</b><p>${esc(r.game_activity)}</p></div>`:''}${r.diet?`<p>饮食：${esc(r.diet)}</p>`:''}${r.nap?`<p>午睡：${esc(r.nap)}</p>`:''}${r.mood?`<p>情绪：${esc(r.mood)}</p>`:''}</div></div>`;}
function growth(){const r=daily;return head('成长的每一刻','真实的照护日常，由负责宝宝的老师记录。','service')+`<div class="split"><section class="card"><div id="growth-list">${records.length?records.map(growthCard).join(''):empty('成长的小小瞬间，值得慢慢珍藏。老师发布记录后，就能在这里查看。')}</div>${recordNext?'<button class="btn secondary" data-action="more-growth">查看更多记录</button>':''}</section><aside class="growth-summary">${[['smile','今日游戏活动',r?.game_activity],['heart','今日饮食',r?.diet],['clock','今日午睡',r?.nap],['smile','今日情绪',r?.mood]].map(([i,t,v])=>`<div class="card stat"><h3>${icon(i)} ${t}</h3><p>${esc(v||'暂无记录')}</p>${r?`<p class="tiny">${fmt(r.occurred_at)}</p>`:''}</div>`).join('')}</aside></div>`;}
function appointmentList(arr){return arr.length?arr.map(a=>`<div class="list-row between"><div><h3>${esc(a.baby)}的${serviceTypeLabel(a.serviceType)}预约 <span class="tag">${STATUS[a.status]}</span></h3><p>${esc(a.date)}　${esc(a.time)}</p><span class="tiny">${a.teacherName?'照护老师：'+esc(a.teacherName):'等待安排老师'}</span></div><div class="form-actions"><button class="btn secondary" data-appointment="${a.id}">查看预约</button>${a.serviceType==='home'&&a.status==='completed'?`<button class="textbtn" data-service-review="${a.id}">${staff()?'查看评价':'评价 / 查看评价'}</button>`:''}</div></div>`).join(''):empty('还没有预约记录。',staff()?'staff':'booking',staff()?'进入工作台':'去预约托育');}
function postCard(p){return `<article class="card post"><div class="post-top"><span class="avatar">${esc(p.name[0])}</span><div><b>${esc(p.name)}</b>${p.role!=='parent'?'<span class="teacher">官方老师</span>':''}<p class="tiny">${fmt(p.time)}</p></div></div><p class="preserve">${esc(p.text)}</p>${p.tag?`<div class="post-tag"># ${esc(p.tag)}</div>`:''}${p.officialReply?`<div class="teacher-reply"><b>${esc(p.officialReply.name)}</b><span class="teacher">官方老师</span><p>${esc(p.officialReply.text)}</p></div>`:''}${p.moderation!=='approved'?`<div class="note">${p.moderation==='pending'?'等待老师审核':'未通过审核'}${p.reviewNote?'：'+esc(p.reviewNote):''}</div>`:''}<div class="post-actions"><button ${p.moderation!=='approved'?'disabled':''} data-like="${p.id}" data-active="${!p.liked}" class="${p.liked?'liked':''}">${icon('heart')} ${p.liked?'已点赞':'点赞'} ${p.likes}</button><button data-post="${p.id}">${icon('chat')} 评论 ${p.commentCount}</button>${p.mine||state.user.role==='admin'?`<button data-hide-post="${p.id}">删除</button>`:''}</div></article>`;}
function community(){return head('育儿路上，我们一起','分享小小日常，让陪伴多一份力量。')+`<div class="split"><section><div class="card between" style="margin-bottom:22px"><div><h3>今天，想分享些什么？</h3><p class="tiny">一个成长瞬间，一点育儿心得。</p></div><button class="btn" data-action="new-post">发布留言 / 动态</button></div><div id="post-list">${posts.length?posts.map(postCard).join(''):empty('还没有分享，记录第一个成长瞬间吧。')}</div>${postNext?'<button class="btn secondary" data-action="more-posts">查看更多留言</button>':''}</section><aside class="card community-side summary"><span class="iconbox pink">${icon('chat')}</span><h3 style="margin-top:20px">让交流温暖一点</h3><p>分享经验，也尊重不同的选择。家长帖子经老师审核后展示。</p><a class="textbtn" href="#/personal/posts">我的帖子与审核状态 →</a><p>机构老师的回复带有“官方老师”标识。</p><div class="note">不要在交流区发布宝宝真实姓名、电话、健康档案或其他隐私信息。</div></aside></div>`;}
function commentCard(c){return `<div class="list-row"><b>${esc(c.name)}</b>${c.role!=='parent'?'<span class="teacher">官方老师</span>':''}<span class="tiny">　${fmt(c.time)}</span><p class="preserve" style="margin-top:8px">${esc(c.text)}</p></div>`;}
function postDetail(){return `<div class="article">${head('家长的分享','','community')}${postCard(currentPost)}<section class="card"><h2>评论 · ${currentPost.commentCount}</h2><div id="comment-list">${comments.length?comments.map(commentCard).join(''):'<p class="tiny" style="margin:20px 0">还没有评论，来说说你的想法吧。</p>'}</div>${commentNext?'<button class="textbtn" data-action="more-comments">查看更早评论</button>':''}${currentPost.moderation==='approved'?`<form id="comment-form" style="margin-top:24px"><label for="comment">写下你的回应</label><textarea class="comment" id="comment" required maxlength="1000" rows="3" placeholder="温暖的交流，从一句回应开始"></textarea><div class="form-actions"><button class="btn">发表评论</button></div></form>`:'<p class="note">帖子通过审核后可以评论交流。</p>'}</section></div>`;}
function personal(tab='profile'){const tabs={profile:'宝宝档案',appointments:'我的预约',agreements:'我的协议',growth:'成长记录',favorites:'我的收藏',posts:'我的留言'};let body='';
  if(tab==='profile')body=state.profile.baby?`<div class="record-head"><span class="avatar">${esc(state.profile.baby[0])}</span><div><h2>${esc(state.profile.baby)}</h2><p>${esc(state.profile.age)} 个月 · ${esc(state.profile.gender)}</p></div></div>${fieldDefs.slice(3).map(([k,l])=>`<div class="list-row"><span class="tiny">${l}</span><p class="preserve">${esc(state.profile[k]||'未填写')}</p></div>`).join('')}<div class="spacer"></div>${btn('查看 / 编辑宝宝档案','profile')}`:empty('先建立宝宝档案，让照护更了解宝宝。','profile','填写宝宝档案');
  else if(tab==='appointments')body=appointmentList(state.appointments);
  else if(tab==='agreements')body=state.appointments.length?state.appointments.map(a=>`<div class="list-row"><h3>${esc(a.baby)} · ${esc(a.date)}</h3><p class="tiny">已保存三份协议、健康信息和家长签名</p><button class="textbtn" data-signed="${a.id}">查看已签署文件 →</button></div>`).join(''):empty('提交预约后，可以在这里查看对应的协议。','booking','去预约托育');
  else if(tab==='growth')body=`<h3>宝宝成长记录</h3><p style="margin:12px 0 22px">查看负责宝宝的老师发布的照片、视频和照护记录。</p>${btn('查看成长记录','growth')}`;
  else if(tab==='favorites')body=state.favorites.length?state.favorites.map(key=>{const[t,i]=key.split(':');const obj=t==='article'?ARTICLES[i]:RESOURCES[i];return obj?`<div class="list-row between"><div><span class="tag">${t==='article'?'育儿知识':'工具资料'}</span><h3 style="margin-top:10px">${obj.title}</h3></div>${btn('查看',t+'/'+i,true)}</div>`:''}).join(''):empty('还没有收藏，在文章或资源详情页收藏喜欢的内容。','knowledge','去看育儿知识');
  else if(tab==='posts')body=`<div id="post-list">${posts.length?posts.map(postCard).join(''):empty('你的分享，会被保存在这里。','community','去家长社区')}</div>${postNext?'<button class="btn secondary" data-action="more-posts" data-mine="1">查看更多留言</button>':''}`;
  else return notFound();return head('我的托育','宝宝的档案、预约和成长，都在这里。')+`<div class="personal"><aside class="card side">${Object.entries(tabs).map(([r,t])=>`<button data-personal="${r}" class="${r===tab?'active':''}">${t}</button>`).join('')}</aside><section class="card"><h2 style="margin-bottom:24px">${tabs[tab]}</h2>${body}</section></div>`;
}

function staffPage(tab='appointments'){
  if(!staff())return notFound();const admin=state.user.role==='admin';
  const tabs=admin?{appointments:'预约管理',slots:'时段与名额',morning:'晨检记录',growth:'发布成长记录',teachers:'老师账号',policies:'正式协议',institution:'机构展示',games:'游戏封面',moderation:'帖子审核',consultation:'育儿咨询'}:{appointments:'负责的预约',morning:'晨检记录',growth:'发布成长记录',moderation:'帖子审核',consultation:'育儿咨询'};
  let content='';
  if(tab==='appointments')content=appointmentList(state.appointments);
  else if(tab==='growth'){
    const eligible=state.appointments.filter(a=>['confirmed','completed'].includes(a.status));
    content=eligible.length?`<form id="growth-form"><div class="note"><label for="private-pack">导入私有活动资料包（仅本机预览，发布前不会上传）</label><input id="private-pack" type="file" accept="application/json,.json"><div id="private-preview"></div></div><div class="field"><label for="appointmentId">对应预约 *</label><select id="appointmentId" required><option value="">请选择对应家长和预约</option>${eligible.map(a=>`<option value="${a.id}">${esc(a.parent)} / ${esc(a.baby)} · ${a.date} ${a.time}</option>`).join('')}</select></div><div class="fields">${field('occurredAt','记录时间（北京时间）','datetime-local','')}${field('title','动态标题','text','')}${field('text','老师记录','textarea','')}${field('gameActivity','游戏活动（选填，最多1000字）','textarea','',false)}${field('diet','今日饮食','textarea','',false)}${field('nap','午睡情况','textarea','',false)}${field('mood','情绪情况','textarea','',false)}</div><div class="field"><label for="media-files">活动照片 / 视频（最多 8 个文件）</label><input id="media-files" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" multiple><p class="tiny">图片最大 10MB，视频最大 50MB。媒体仅对对应家长、负责老师和管理员开放。</p></div><div class="error" id="growth-error"></div><div class="tiny" id="upload-progress" role="status"></div><div class="form-actions"><button class="btn">发布成长记录</button></div></form>`:empty('尚无已确认的预约，请先确认预约并分配老师。');
  }else if(tab==='consultation')content=consultationPage();
  else if(tab==='morning')content=morningPage();
  else if(tab==='games'&&admin)content=gameCoverEditor();
  else if(tab==='institution'&&admin)content=institutionEditor();
  else if(tab==='moderation')content=moderationPage();
  else if(tab==='slots'&&admin)content=`<form id="slot-form" class="fields">${serviceTypeSelect('slot-type','')}${field('slot-date','日期','date','')}${field('slot-start','开始时间','time','09:00')}${field('slot-end','结束时间','time','12:00')}${field('slot-capacity','名额','number','5')}<div class="full"><p class="tiny">同一天的时段不重叠；已预约的日期和时间不可修改。</p><button class="btn">开放时段</button></div></form><div class="spacer"></div>${state.slots.map(s=>`<div class="list-row between"><div><h3>${s.date} ${s.start}–${s.end}</h3><p>${serviceTypeLabel(s.service_type)} · 总名额 ${s.capacity} · 剩余 ${s.remaining} · ${s.enabled?'开放中':'已关闭'}</p></div><button class="btn secondary" data-slot-edit="${s.id}">调整名额 / 状态</button></div>`).join('')||'<p>尚未设置时段。</p>'}`;
  else if(tab==='teachers'&&admin)content=`<form id="teacher-form" class="fields">${field('teacher-name','老师姓名','text','')}${field('teacher-username','账号','text','')}${field('teacher-password','初始密码','password','')}<div class="full"><p class="tiny">初始密码至少 12 位。请通过安全方式交给老师，老师登录后可修改密码。</p><button class="btn">创建老师账号</button></div></form><div class="spacer"></div>${state.teachers.map(t=>`<div class="list-row between"><div><h3>${esc(t.name)}</h3><p>${esc(t.username)} · ${t.active?'正常':'已停用'}</p></div><button class="btn secondary" data-teacher-toggle="${t.id}" data-active="${!t.active}">${t.active?'停用':'启用'}</button></div>`).join('')}`;
  else if(tab==='policies'&&admin)content=policyEditor();
  else return notFound();
  return head(admin?'机构管理工作台':'老师工作台',`你好，${esc(state.user.name)}。${admin?'安排时段、老师和正式服务内容。':'查看负责的预约，发布照护记录。'}`)+`<div class="personal"><aside class="card side">${Object.entries(tabs).map(([key,name])=>`<button data-staff="${key}" class="${key===tab?'active':''}">${name}</button>`).join('')}<a class="textbtn" href="#/community">进入家长社区 →</a></aside><section class="card"><h2 style="margin-bottom:24px">${tabs[tab]}</h2>${content}</section></div>`;
}

function modal(title,html){returnFocus=document.activeElement;$('#modal').innerHTML=`<button class="close" data-action="close" aria-label="关闭弹窗">×</button><h2>${title}</h2>${html}`;if(!$('#modal').open)$('#modal').showModal();}
$('#modal').addEventListener('close',()=>{$$('#modal video').forEach(v=>v.pause());returnFocus?.focus();});
function privacy(){modal('隐私与服务协议',state.policy?`<p>${esc(state.policy.organization)} · ${esc(state.policy.contact)}</p>${state.policy.documents.map(d=>`<section class="agreement-body"><h3>${esc(d.title)}</h3><div class="policy-text">${esc(d.text)}</div></section>`).join('')}`:'<p>机构尚未发布正式协议，请联系管理员。</p>');}
async function render(){
  clearImportedPhotos();clearMorningImport();const seq=++generation;let parts=location.hash.replace(/^#\/?/,'').split('/'),page=parts[0]||(state.user?'home':'login');
  if(!state.user&&!['login','register'].includes(page)){go('login');return;}
  if(state.user&&['login','register'].includes(page)){go(staff()?'staff':'home');return;}
  if($('#modal').open)$('#modal').close();
  try{
    if(!['login','register'].includes(page)){
      if(['service','personal','staff','growth','morning','booking','agreements','consultation'].includes(page))await refresh();
      if(page==='growth'){const b=await api('/growth');if(seq!==generation)return;records=b.records;daily=b.daily;recordNext=b.next;}
      if(page==='morning'||page==='staff'&&parts[1]==='morning'){const m=await api('/morning');if(seq!==generation)return;morningRecords=m.records;}
      if(page==='knowledge'||page==='staff'&&parts[1]==='games'){const covers=await api('/game-covers');if(seq!==generation)return;gameCovers=covers;}
      if(page==='home'||page==='staff'&&parts[1]==='institution'){const site=await api('/institution');if(seq!==generation)return;institution=site;}
      if(page==='staff'&&parts[1]==='moderation'){const list=await api('/staff/posts?status='+reviewFilter);if(seq!==generation)return;reviewPosts=list.posts;reviewNext=list.next;}
      if(page==='consultation'||page==='staff'&&parts[1]==='consultation'){await loadConsultations(parts[0]==='consultation'?parts[1]:null);if(seq!==generation)return;}
      if(page==='community'||(page==='personal'&&parts[1]==='posts')){const b=await api('/posts'+(page==='personal'?'?mine=1':''));if(seq!==generation)return;posts=b.posts;postNext=b.next;}
      if(page==='post'){const b=await api('/posts/'+parts[1]);if(seq!==generation)return;currentPost=b.post;comments=b.comments;commentNext=b.next;}
    }
    if(seq!==generation)return;
    if(['login','register'].includes(page))$('#app').innerHTML=login(page==='register');
    else{const routes={home,service,profile:()=>formPage(false),booking:()=>formPage(true),agreements,success,growth,morning:()=>head('晨检记录','每天的细心观察，单独阅读与确认。','service')+morningSummary(),consultation:()=>consultationPage(parts[1]),knowledge:()=>academy(parts[1]),
      article:()=>article(parts[1]),resources,resource:()=>resource(parts[1],parts[2]),community,post:postDetail,
      personal:()=>personal(parts[1]),staff:()=>staffPage(parts[1])};$('#app').innerHTML=shell((routes[page]||notFound)(),page);}
    document.title='近邻托育 · '+(({home:'首页',staff:'工作台',booking:'预约托育',growth:'成长记录',community:'家长社区'})[page]||'家门口的科学托育服务');
    window.scrollTo(0,0);bindForms();bindJourneys();if($('#signature'))bindSignature();
  }catch(error){if(seq!==generation)return;$('#app').innerHTML=`<main class="container">${head('暂时无法加载',esc(error.message))}<button class="btn" data-action="retry">重新加载</button></main>`;}
}
function handleForm(selector,handler){const f=$(selector);if(!f)return;f.onsubmit=async e=>{e.preventDefault();const b=f.querySelector('button:not([type="button"])');if(b?.disabled)return;if(b)b.disabled=true;
  try{await handler(f);}catch(error){showFields(error.fields);const local=f.querySelector('[role="alert"],#growth-error');if(local)local.textContent=error.message;else toast(error.message);}finally{if(b?.isConnected)b.disabled=false;}};}
function bindForms(){
  handleForm('#auth-form',async f=>{const register=f.dataset.register==='true';const b=await api(register?'/register':'/login','POST',{username:$('#username').value,password:$('#password').value,...(register?{name:$('#name').value,consent:$('#consent').checked,policyId:state.policy?.id}:{})});state={...state,...b};await refresh();go(staff()?'staff':'home');});
  const care=$('#care-form');if(care){
    const read=()=>Object.fromEntries([...new FormData(care)].map(([k,v])=>[k,v.trim()]));
    if($('#serviceType'))$('#serviceType').onchange=async()=>{state.draft={...read(),slotId:''};resetSignature();queueDraft();await flushDraft();await render();};
    if($('#date'))$('#date').onchange=e=>{$('#slotId').innerHTML=slotOptions(e.target.value);state.draft={...read(),slotId:''};resetSignature();queueDraft();$('#live-summary').innerHTML=summary(selectedDraft());};
    care.oninput=()=>{if(care.dataset.kind==='booking'){state.draft=read();resetSignature();queueDraft();$('#live-summary').innerHTML=summary(selectedDraft());}};
    handleForm('#care-form',async()=>{const d=read(),booking=care.dataset.kind==='booking';const errors=validateLocal(d,booking);showFields(errors);if(Object.keys(errors).length)return;
      if(booking){state.draft=d;draftDirty=true;await flushDraft();go('agreements');}
      else{const b=await api('/profile','PUT',d);state.profile=b.profile;toast('宝宝档案已保存');$('#saved-profile').innerHTML=`<div class="note between"><span>宝宝档案已保存。</span>${btn('去预约托育','booking')}</div>`;}});
  }
  handleForm('#comment-form',async()=>{await api('/posts/'+currentPost.id+'/comments','POST',{text:$('#comment').value});await render();toast('评论已发布');});
  handleForm('#teacher-form',async()=>{await api('/admin/teachers','POST',{name:$('#teacher-name').value,username:$('#teacher-username').value,password:$('#teacher-password').value});await render();toast('老师账号已创建');});
  handleForm('#slot-form',async()=>{await api('/admin/slots','POST',{serviceType:$('#slot-type').value,date:$('#slot-date').value,start:$('#slot-start').value,end:$('#slot-end').value,capacity:Number($('#slot-capacity').value)});await render();toast('预约时段已开放');});
  handleForm('#policy-form',async()=>{await api('/admin/policies','POST',{serviceType:$('#policy-type').value,organization:$('#organization').value,contact:$('#contact').value,reviewAcknowledged:$('#policy-reviewed').checked,documents:AGREEMENT_NAMES.map((_,i)=>({text:$('#policy-'+i).value}))});await render();toast('正式协议新版本已发布');});
  if($('#growth-form')){
    $('#appointmentId').onchange=()=>{$('#occurredAt').value='';};bindPrivateImport();
    handleForm('#growth-form',async()=>{
      const files=[...(importedPhotos||[]),...$('#media-files').files];if(files.length>8)throw new Error('最多上传 8 个媒体文件');
      const data={appointmentId:$('#appointmentId').value,occurredAt:new Date($('#occurredAt').value+'+08:00').toISOString(),title:$('#title').value,text:$('#text').value,gameActivity:$('#gameActivity').value,diet:$('#diet').value,nap:$('#nap').value,mood:$('#mood').value,media:[]};
      const selected=state.appointments.find(a=>a.id===data.appointmentId);if(!selected)throw new Error('请选择对应家长和预约');if(Date.parse(data.occurredAt)<Date.parse(selected.date+'T'+selected.time.slice(0,5)+':00+08:00')||Date.parse(data.occurredAt)>Date.parse(selected.date+'T'+selected.time.slice(-5)+':00+08:00'))throw new Error('请填写本次预约服务时段内的真实活动时间');
      if(Date.parse(data.occurredAt)>Date.now()+60000)throw new Error('记录时间不能晚于当前时间');
      const allowed=['image/png','image/jpeg','image/webp','video/mp4','video/webm'];
      for(const f of files){if(!allowed.includes(f.type))throw new Error('不支持此文件格式');if(f.size>(f.type.startsWith('image/')?10:50)*1024*1024)throw new Error('图片最大 10MB，视频最大 50MB');}
      for(let i=0;i<files.length;i++){
        $('#upload-progress').textContent=`正在上传 ${i+1} / ${files.length}，请勿关闭页面…`;
        const response=await fetch('/api/upload/'+data.appointmentId,{method:'POST',credentials:'same-origin',headers:{'Content-Type':files[i].type,'X-CSRF-Token':state.csrf},body:files[i]});
        const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');data.media.push(result.id);
      }
      $('#upload-progress').textContent='正在发布记录…';await api('/growth','POST',data);await render();toast('成长记录已发布，对应家长现在可以查看');
    });
  }
}

async function appointmentModal(id){const a=state.appointments.find(a=>a.id===id);if(!a)throw new Error('预约不存在，请刷新');
  modal('预约详情',`<div class="summary">${summary(a)}</div><div class="note">状态：${STATUS[a.status]}${a.teacherName?' · 老师：'+esc(a.teacherName):''}${a.staffNote?`<p>${esc(a.staffNote)}</p>`:''}</div><button class="textbtn" data-signed="${a.id}">查看签署文件与健康信息</button> <button class="btn secondary" data-morning="${a.id}">查看晨检记录</button>${a.serviceType==='home'&&a.status==='completed'?` <button class="btn secondary" data-service-review="${a.id}">${staff()?'查看服务评价':'评价 / 查看评价'}</button>`:''}${staff()?`<form id="appointment-form" style="margin-top:20px">${state.user.role==='admin'&&['pending','confirmed'].includes(a.status)?`<div class="field"><label for="assign-teacher">照护老师</label><select id="assign-teacher"><option value="">请选择老师</option>${state.teachers.filter(t=>t.active).map(t=>`<option value="${t.id}" ${t.id===a.teacherId?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div>`:''}<div class="field"><label for="appointment-status">预约状态</label><select id="appointment-status"><option value="">保持当前状态</option>${({pending:['confirmed','rejected'],confirmed:['completed','cancelled'],completed:[],cancelled:[],rejected:[]})[a.status].map(s=>`<option value="${s}">${STATUS[s]}</option>`).join('')}</select></div>${field('staff-note','处理说明','textarea',a.staffNote,false)}<div class="form-actions"><button class="btn">保存处理结果</button></div></form>`:['pending','confirmed'].includes(a.status)?`<div class="form-actions"><button class="btn secondary" data-cancel-appointment="${a.id}">取消预约</button></div>`:''}`);
  handleForm('#appointment-form',async()=>{const data={note:$('#staff-note').value};if($('#assign-teacher')?.value)data.teacherId=$('#assign-teacher').value;if($('#appointment-status').value)data.status=$('#appointment-status').value;await api('/appointments/'+a.id,'PATCH',data);$('#modal').close();await render();toast('预约已更新');});
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||b.type==='submit'&&b.closest('form'))return;const d=b.dataset;
  try{
    if(d.action==='menu'){$('.nav').classList.toggle('open');b.setAttribute('aria-expanded',$('.nav').classList.contains('open'));}
    else if(d.action==='retry')await boot();
    else if(d.action==='privacy')privacy();
    else if(d.action==='close')$('#modal').close();
    else if(d.action==='logout'){await flushDraft();await api('/logout','POST',{});clearSession();go('login');}
    else if(d.action==='service-info'){showServiceInfo();}
    else if(d.action==='load-health-template'){if(state.user?.role==='admin'&&$('#policy-2')){$('#policy-2').value=HEALTH_REGISTRATION_TEMPLATE;$('#policy-reviewed').checked=false;toast('登记表模板已载入，仅替换第三份正文，请核对后发布');}}
    else if(d.action==='load-material-policies'){await loadMaterialPolicies();}
    else if(d.activityReview!==undefined){await showActivityReview(Number(d.activityReview));}
    else if(d.action==='password'){modal('修改密码',`<form id="password-form">${field('oldPassword','原密码','password','')}${field('newPassword','新密码','password','')}<p class="tiny">修改后所有设备均需重新登录。新密码至少 12 位。</p><div class="form-actions"><button class="btn">保存新密码</button></div></form>`);handleForm('#password-form',async()=>{await api('/password','POST',{oldPassword:$('#oldPassword').value,password:$('#newPassword').value});$('#modal').close();clearSession();go('login');toast('密码已修改，请重新登录');});}
    else if(d.agreement!==undefined){agreementIndex=Number(d.agreement);$('#agreement-body').innerHTML=agreementBody(agreementIndex,selectedDraft());$$('[data-agreement]').forEach(x=>x.classList.toggle('active',x===b));}
    else if(d.action==='clear-sign'){signData='';hasSignature=false;bindSignature();$('.signature .hint').hidden=false;$('#submit-appointment').disabled=true;}
    else if(d.favorite){b.disabled=true;const active=!state.favorites.includes(d.favorite);await api('/favorites/'+d.favorite,'PUT',{active});if(active)state.favorites.push(d.favorite);else state.favorites=state.favorites.filter(x=>x!==d.favorite);await render();toast(active?'已加入我的收藏':'已取消收藏');}
    else if(d.resource)go('resource/'+d.resource);
    else if(d.zoom)modal('资料预览',`<img src="assets/resource-${d.zoom}.png" alt="育儿工具资料放大预览">`);
    else if(d.photo)modal('宝宝活动照片',`<img src="/api/media/${d.photo}" alt="宝宝活动照片">`);
    else if(d.like){b.disabled=true;await api('/posts/'+d.like+'/like','PUT',{active:d.active==='true'});await render();}
    else if(d.post)go('post/'+d.post);
    else if(d.personal)go('personal/'+d.personal);
    else if(d.staff)go('staff/'+d.staff);
    else if(d.appointment)await appointmentModal(d.appointment);
    else if(d.signed){const a=await api('/appointments/'+d.signed+'/agreement');modal('已签署文件',`<p>${esc(a.organization)} · ${fmt(a.confirmedAt)}</p><p class="tiny">当前照护安排：${esc(a.appointment.teacherName||'待分配')}（不改变签署时文本）</p>${a.documents.map((_,i)=>`<section class="agreement-body">${agreementBody(i,a.appointment,a.documents,a.organization,true)}</section>`).join('')}${a.signatures?a.signatures.map((v,i)=>`<h3>${esc(a.documents[i].title)} · 家长签名</h3><img class="agreement-image" src="${v.signature}" alt="第${i+1}份协议签名"><p>${fmt(v.confirmedAt)}</p>`).join(''):`<h3>历史统一签名</h3><img class="agreement-image" src="${a.signature}" alt="历史预约统一签名">`}<p class="tiny break">文件校验摘要：${esc(a.evidenceHash)}</p>`);}
    else if(d.cancelAppointment){modal('取消本次预约',`<p>取消后会释放本次名额。确认取消吗？</p><div class="form-actions"><button class="btn secondary" data-action="close">保留预约</button><button class="btn" data-confirm-cancel="${d.cancelAppointment}">确认取消</button></div>`);}
    else if(d.confirmCancel){b.disabled=true;await api('/appointments/'+d.confirmCancel,'PATCH',{status:'cancelled'});$('#modal').close();await render();toast('预约已取消');}
    else if(d.hidePost){modal('删除留言',`<p>删除后，其他家长将无法再查看此留言及评论。</p><div class="form-actions"><button class="btn secondary" data-action="close">保留</button><button class="btn" data-confirm-hide="${d.hidePost}">确认删除</button></div>`);}
    else if(d.confirmHide){await api('/posts/'+d.confirmHide,'DELETE',{});$('#modal').close();go('community');await render();}
    else if(d.action==='new-post'){modal('分享一个成长瞬间',`<form id="post-form">${field('post-text','留言 / 动态','textarea','')}<div class="field"><label for="post-tag">话题标签</label><select id="post-tag"><option>成长日常</option><option>自主进食</option><option>亲子阅读</option><option>托育日常</option></select></div><div class="form-actions"><button type="button" class="btn secondary" data-action="close">取消</button><button class="btn">发布</button></div></form>`);handleForm('#post-form',async()=>{await api('/posts','POST',{text:$('#post-text').value,tag:$('#post-tag').value});$('#modal').close();go('personal/posts');await render();toast(staff()?'分享已发布':'已提交，等待老师审核');});}
    else if(d.action==='more-posts'){b.disabled=true;const r=await api('/posts?before='+postNext+(d.mine?'&mine=1':''));posts.push(...r.posts);postNext=r.next;$('#post-list').insertAdjacentHTML('beforeend',r.posts.map(postCard).join(''));if(!postNext)b.remove();}
    else if(d.action==='more-growth'){b.disabled=true;const r=await api('/growth?before='+recordNext);records.push(...r.records);recordNext=r.next;$('#growth-list').insertAdjacentHTML('beforeend',r.records.map(growthCard).join(''));if(!recordNext)b.remove();}
    else if(d.action==='more-comments'){b.disabled=true;const r=await api('/posts/'+currentPost.id+'?before='+commentNext);comments.push(...r.comments);commentNext=r.next;$('#comment-list').insertAdjacentHTML('beforeend',r.comments.map(commentCard).join(''));if(!commentNext)b.remove();}
    else if(d.slotEdit){const s=state.slots.find(s=>s.id===d.slotEdit);modal('调整时段',`<p>${s.date} ${s.start}–${s.end}</p><form id="edit-slot-form">${serviceTypeSelect('edit-service-type',s.service_type)}${field('edit-capacity','总名额','number',s.capacity)}<label class="check"><input type="checkbox" id="edit-enabled" ${s.enabled?'checked':''}>开放预约</label><div class="form-actions"><button class="btn">保存</button></div></form>`);handleForm('#edit-slot-form',async()=>{await api('/admin/slots/'+s.id,'PATCH',{serviceType:$('#edit-service-type').value,capacity:Number($('#edit-capacity').value),enabled:$('#edit-enabled').checked});$('#modal').close();await render();toast('时段已更新');});}
    else if(d.teacherToggle){await api('/admin/teachers/'+d.teacherToggle,'PATCH',{active:d.active==='true'});await render();toast('老师账号状态已更新');}
  }catch(error){toast(error.message);}finally{if(b.isConnected&&d.action!=='submit-appointment')b.disabled=false;}
});
async function boot(){try{const b=await api('/session');state={...state,...b};await render();}catch(e){$('#app').innerHTML=`<main class="container">${head('无法连接服务',esc(e.message))}<button class="btn" data-action="retry">重新连接</button></main>`;}}
window.addEventListener('hashchange',async()=>{if(draftDirty)try{await flushDraft();}catch(e){toast(e.message);}render();});
window.addEventListener('beforeunload',e=>{if(draftDirty){e.preventDefault();e.returnValue='';}});
boot();
