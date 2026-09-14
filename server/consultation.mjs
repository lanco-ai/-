import {randomUUID} from 'node:crypto';
import {writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {check,text,hash} from './security.mjs';
import {stamp,transaction,audit} from './db.mjs';
const categories=['生长发育','入园准备','营养辅食','心理健康'];
export function consultationHandler({db,body,json,identify,requireUser,appointment,dataDir,limiter}){
 const get=(s,...a)=>db.prepare(s).get(...a),all=(s,...a)=>db.prepare(s).all(...a),run=(s,...a)=>db.prepare(s).run(...a);
 const access=(id,u)=>{requireUser(u);const c=get('SELECT * FROM consultations WHERE id=?',id);check(c&&(u.role==='admin'||c.user_id===u.id||c.teacher_id===u.id),404,'咨询不存在');return c;};
 const view=c=>({...c,parentName:get('SELECT name FROM users WHERE id=?',c.user_id).name,teacherName:c.teacher_id?get('SELECT name FROM users WHERE id=?',c.teacher_id)?.name:'',preview:get('SELECT text FROM consultation_messages WHERE consultation_id=? ORDER BY created_at,id LIMIT 1',c.id)?.text||''});
 function pictures(images){check(Array.isArray(images)&&images.length<=4,400,'每条消息最多 4 张图片');return images.map(value=>{
  check(typeof value==='string',400,'图片格式无效');const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);check(m,400,'只支持 PNG、JPEG、WebP 图片');const bytes=Buffer.from(m[2],'base64');check(bytes.length>32&&bytes.length<=10*1024*1024,400,'每张图片最大 10MB');
  check(m[1]==='png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':m[1]==='jpeg'?bytes.subarray(0,3).toString('hex')==='ffd8ff':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP',400,'图片内容不正确');
  const id=randomUUID();return {id,bytes,mime:'image/'+m[1],filename:id+'.'+(m[1]==='jpeg'?'jpg':m[1])};
 });}
 return async(req,res,url,user)=>{
  let m;const path=url.pathname;
  if((m=/^\/api\/appointments\/([\w-]+)\/review$/.exec(path))){
   const b=req.method==='POST'?await body(req,8000):null;user=identify(req);const a=appointment(m[1],user),old=get('SELECT * FROM service_reviews WHERE appointment_id=?',a.id);
   if(req.method==='GET'){json(res,{review:old||null,canReview:user.role==='parent'&&a.service_type==='home'&&a.status==='completed'&&!old});return true;}
   check(req.method==='POST',405,'不支持此操作');requireUser(user,['parent']);check(a.service_type==='home'&&a.status==='completed',409,'入户服务完成后才可评价');check(Number.isInteger(b.rating)&&b.rating>=1&&b.rating<=5,400,'请选择 1–5 星');const comment=text(b.text||'','评价',1000,false);
   if(old){check(old.rating===b.rating&&old.text===comment,409,'评价已经提交，不能修改');json(res,{review:old});return true;}
   run('INSERT INTO service_reviews VALUES(?,?,?,?,?)',a.id,user.id,b.rating,comment,stamp());audit(db,user.id,'service.review',a.id);json(res,{review:get('SELECT * FROM service_reviews WHERE appointment_id=?',a.id)},201);return true;
  }
  if((m=/^\/api\/consultation-media\/([\w-]+)$/.exec(path))&&req.method==='GET'){
   const f=get('SELECT f.*,m.consultation_id FROM consultation_media f JOIN consultation_messages m ON m.id=f.message_id WHERE f.id=?',m[1]);check(f,404,'图片不存在');access(f.consultation_id,user);res.writeHead(200,{'Content-Type':f.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(readFileSync(join(dataDir,'uploads',f.filename)));return true;
  }
  if(!path.startsWith('/api/consultations'))return false;
  requireUser(user);
  if(path==='/api/consultations'&&req.method==='GET'){
   const before=url.searchParams.get('before')||'9999';check(before.length<100,400,'分页无效');
   const rows=user.role==='admin'?all("SELECT * FROM consultations WHERE (created_at||'|'||id)<? ORDER BY created_at DESC,id DESC LIMIT 51",before):all(`SELECT * FROM consultations WHERE ${user.role==='parent'?'user_id':'teacher_id'}=? AND (created_at||'|'||id)<? ORDER BY created_at DESC,id DESC LIMIT 51`,user.id,before);
   json(res,{items:rows.slice(0,50).map(view),next:rows.length>50?rows[49].created_at+'|'+rows[49].id:null});return true;
  }
  const match=/^\/api\/consultations(?:\/([\w-]+)(?:\/(messages|assign|status))?)?$/.exec(path);check(match,404,'接口不存在');const [,id,action]=match;
  if(req.method==='GET'&&id&&!action){const c=access(id,user);const before=url.searchParams.get('before')||'9999';check(before.length<100,400,'分页无效');const messages=all("SELECT m.*,u.name,u.role FROM consultation_messages m JOIN users u ON u.id=m.user_id WHERE consultation_id=? AND (m.created_at||'|'||m.id)<? ORDER BY m.created_at DESC,m.id DESC LIMIT 51",id,before);json(res,{consultation:view(c),messages:messages.slice(0,50).reverse().map(m=>({...m,images:all('SELECT id FROM consultation_media WHERE message_id=?',m.id).map(f=>'/api/consultation-media/'+f.id)})),next:messages.length>50?messages[49].created_at+'|'+messages[49].id:null});return true;}
  check(req.method==='POST',405,'不支持此操作');limiter('consult:'+user.id,30,60000);const b=await body(req,57*1024*1024);user=identify(req);requireUser(user);
  if(action==='assign'||action==='status'){
   const c=access(id,user);check(b.version===c.version,409,'咨询已更新，请重新打开');
   if(action==='assign'){requireUser(user,['admin']);const teacher=b.teacherId||null;check(!teacher||get("SELECT 1 FROM users WHERE id=? AND role='teacher' AND active=1",teacher),400,'请选择有效老师');run("UPDATE consultations SET teacher_id=?,status=CASE WHEN status='closed' THEN status ELSE ? END,version=version+1,updated_at=? WHERE id=?",teacher,teacher?'active':'pending',stamp(),id);}
   else{check(['close','reopen'].includes(b.action),400,'状态无效');check(b.action!=='reopen'||c.user_id===user.id,403,'仅提问家长可重新开启');check(b.action==='close'?c.status!=='closed':c.status==='closed',409,'咨询状态已变化');run('UPDATE consultations SET status=?,version=version+1,updated_at=? WHERE id=?',b.action==='close'?'closed':c.teacher_id?'active':'pending',stamp(),id);}
   audit(db,user.id,'consultation.'+action,id);json(res,{ok:true});return true;
  }
  check(!action||action==='messages',404,'接口不存在');if(!id)requireUser(user,['parent']);else{const c=access(id,user);check(c.status!=='closed',409,'咨询已结束，请先重新开启');check(c.version===b.version,409,'咨询已更新，请重新打开');}
  const key=text(b.requestKey,'请求编号',80);check(/^[\w-]{16,80}$/.test(key),400,'请求编号无效');const digest=hash(JSON.stringify({id:id||null,text:b.text,category:b.category,images:b.images||[]})),old=get('SELECT * FROM consultation_requests WHERE user_id=? AND request_key=?',user.id,key);
  if(old){check(old.payload_hash===digest,409,'请求编号已使用');json(res,JSON.parse(old.response));return true;}
  const message=text(b.text,'问题或回复',2000);if(!id)check(categories.includes(b.category),400,'请选择咨询分类');const files=pictures(b.images||[]),cid=id||randomUUID(),mid=randomUUID(),now=stamp(),written=[];
  try{for(const f of files){writeFileSync(join(dataDir,'uploads',f.filename),f.bytes,{flag:'wx',mode:0o600});written.push(f.filename);}
   transaction(db,()=>{if(!id)run('INSERT INTO consultations(id,user_id,category,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',cid,user.id,b.category,'pending',now,now);
    run('INSERT INTO consultation_messages VALUES(?,?,?,?,?)',mid,cid,user.id,message,now);for(const f of files)run('INSERT INTO consultation_media VALUES(?,?,?,?)',f.id,mid,f.filename,f.mime);
    run('UPDATE consultations SET updated_at=? WHERE id=?',now,cid);run('INSERT INTO consultation_requests VALUES(?,?,?,?)',user.id,key,digest,JSON.stringify({id:cid}));audit(db,user.id,'consultation.message',cid);
   });
  }catch(error){for(const f of written)try{unlinkSync(join(dataDir,'uploads',f));}catch{}throw error;}
  json(res,{id:cid},201);return true;
 };
}
