import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.mjs';
import {passwordHash} from '../server/security.mjs';
import {png} from './helpers.mjs';

test('typed bookings, separate signatures, private reviews and assigned consultations',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinlin-journeys-')),origin='http://localhost:3000';let app=createApp({dataDir:dir,origin});
 const run=(q,...a)=>app.db.prepare(q).run(...a),get=(q,...a)=>app.db.prepare(q).get(...a),pw='Journey-test-password-123',pass=await passwordHash(pw),now=new Date().toISOString();
 for(const [id,role]of [['admin','admin'],['parent','parent'],['otherparent','parent'],['teacher','teacher'],['otherteacher','teacher']])run('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)',id,id,id,pass,role,now);
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');let base='http://127.0.0.1:'+app.server.address().port;const clients={};
 async function call(who,path,method='GET',data){const c=clients[who]||{},r=await fetch(base+'/api'+path,{method,headers:{Origin:origin,...(c.cookie?{Cookie:c.cookie,'X-CSRF-Token':c.csrf}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});const body=await r.json().catch(()=>null);if(body?.csrf)clients[who]={cookie:r.headers.get('set-cookie').split(';')[0],csrf:body.csrf};return {status:r.status,body};}
 const ok=async(...a)=>{const r=await call(...a);assert.ok(r.status>=200&&r.status<300,JSON.stringify(r));return r.body;};
 const sig='data:image/png;base64,'+png().toString('base64'),blank='data:image/png;base64,'+png(true).toString('base64');
 const docs=[0,1,2].map(i=>({text:`机构审核测试文件第${i+1}份，包含服务安排、健康信息和数据保密责任的完整测试说明。宝宝{{baby}}，家长{{parent}}，老师{{teacher}}。`}));
 const profile={baby:'测试宝宝',age:'9',gender:'男',allergy:'无',allergyNote:'',notes:'',parent:'测试家长',phone:'13800000000',emergency:'紧急联系 13900000000'};
 const date=new Date(Date.now()+86400000*2).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});let homePolicy,centerPolicy,homeSlot,centerSlot,a,centerBooking,c,mediaUrl;
 const booking=(type,slot,policy)=>({serviceType:type,address:type==='home'?'测试社区一号楼':'' ,profile,slotId:slot,policyId:policy,agreed:true,signatures:[{agreed:true,signature:sig},{agreed:true,signature:sig}],requestKey:randomUUID()});
 try{
  for(const id of ['admin','parent','otherparent','teacher','otherteacher'])await ok(id,'/login','POST',{username:id,password:pw});
  await t.test('explicit policy types and slots, untyped legacy slots cannot accept new bookings',async()=>{
   assert.equal((await call('admin','/admin/policies','POST',{organization:'机构',contact:'联系',documents:docs})).status,400);
   homePolicy=(await ok('admin','/admin/policies','POST',{serviceType:'home',organization:'机构',contact:'联系',documents:docs,reviewAcknowledged:true})).id;
   centerPolicy=(await ok('admin','/admin/policies','POST',{serviceType:'center',organization:'机构',contact:'联系',documents:docs,reviewAcknowledged:true})).id;
   homeSlot=(await ok('admin','/admin/slots','POST',{serviceType:'home',date,start:'09:00',end:'10:00',capacity:5})).id;
   centerSlot=(await ok('admin','/admin/slots','POST',{serviceType:'center',date,start:'11:00',end:'12:00',capacity:5})).id;
   run('INSERT INTO slots(id,date,start,end,capacity) VALUES(?,?,?,?,?)','legacy',date,'13:00','14:00',2);
   assert.equal((await call('parent','/appointments','POST',booking('home','legacy',homePolicy))).status,409);
   await ok('admin','/admin/slots/legacy','PATCH',{enabled:true,capacity:2,serviceType:'home'});
   assert.equal(get('SELECT service_type FROM slots WHERE id=?','legacy').service_type,'home');
  });
  await t.test('two independent signatures and matching type/address/policy are required',async()=>{
   const b=booking('home',homeSlot,homePolicy);
   assert.equal((await call('parent','/appointments','POST',{...b,address:''})).status,400);
   assert.equal((await call('parent','/appointments','POST',{...b,signatures:[b.signatures[0]]})).status,400);
   assert.equal((await call('parent','/appointments','POST',{...b,signatures:[b.signatures[0],{agreed:true,signature:blank}]})).status,400);
   assert.equal((await call('parent','/appointments','POST',{...b,policyId:centerPolicy})).status,409);
   assert.equal((await call('parent','/appointments','POST',{...b,slotId:centerSlot})).status,409);
   a=(await ok('parent','/appointments','POST',b)).appointment;
   assert.equal((await ok('parent','/appointments','POST',b)).appointment.id,a.id);
   const signed=await ok('parent','/appointments/'+a.id+'/agreement');assert.equal(signed.signatures.length,2);assert.equal(signed.appointment.address,b.address);assert.match(signed.documents[0].text,/待分配/);
   await ok('admin','/admin/policies','POST',{serviceType:'home',organization:'更新机构',contact:'联系',documents:docs,reviewAcknowledged:true});
   assert.equal((await ok('parent','/appointments/'+a.id+'/agreement')).policyId,homePolicy);
   assert.equal((await call('otherparent','/appointments/'+a.id+'/agreement')).status,404);
   centerBooking=(await ok('parent','/appointments','POST',booking('center',centerSlot,centerPolicy))).appointment;assert.equal(centerBooking.address,'');
  });
  await t.test('review only after real service end, one immutable private review per home appointment',async()=>{
   assert.equal((await call('parent','/appointments/'+a.id+'/review','POST',{rating:5})).status,409);
   await ok('admin','/appointments/'+a.id,'PATCH',{teacherId:'teacher',status:'confirmed'});
   assert.equal((await call('teacher','/appointments/'+a.id,'PATCH',{status:'completed'})).status,409);
   run("UPDATE slots SET date='2026-01-01' WHERE id=?",homeSlot);await ok('teacher','/appointments/'+a.id,'PATCH',{status:'completed'});
   assert.equal((await call('parent','/appointments/'+a.id+'/review','POST',{rating:6})).status,400);
   const review=await ok('parent','/appointments/'+a.id+'/review','POST',{rating:5,text:'细心耐心'});assert.equal(review.review.rating,5);
   await ok('parent','/appointments/'+a.id+'/review','POST',{rating:5,text:'细心耐心'});
   assert.equal((await call('parent','/appointments/'+a.id+'/review','POST',{rating:4})).status,409);
   assert.equal((await call('teacher','/appointments/'+a.id+'/review','POST',{rating:4})).status,403);
   assert.equal((await ok('teacher','/appointments/'+a.id+'/review')).review.text,'细心耐心');
   assert.equal((await call('otherteacher','/appointments/'+a.id+'/review')).status,404);
   assert.equal((await call('otherparent','/appointments/'+a.id+'/review')).status,404);
   run("UPDATE appointments SET status='completed' WHERE id=?",centerBooking.id);assert.equal((await call('parent','/appointments/'+centerBooking.id+'/review','POST',{rating:5})).status,409);
  });
  await t.test('consultation create is private and idempotent, image validation is atomic',async()=>{
   const data={category:'生长发育',text:'宝宝最近的游戏兴趣',images:[sig],requestKey:randomUUID()};
   assert.equal((await call('parent','/consultations','POST',{...data,images:[sig,sig,sig,sig,sig]})).status,400);
   assert.equal((await call('parent','/consultations','POST',{...data,images:['data:image/svg+xml;base64,YQ==']})).status,400);
   assert.equal(get('SELECT count(*) n FROM consultations').n,0);
   c=(await ok('parent','/consultations','POST',data)).id;assert.equal((await ok('parent','/consultations','POST',data)).id,c);
   const detail=await ok('parent','/consultations/'+c);assert.equal(detail.consultation.status,'pending');assert.equal(detail.messages.length,1);mediaUrl=detail.messages[0].images[0];
   assert.equal((await call('teacher','/consultations/'+c)).status,404);assert.equal((await call('otherparent','/consultations/'+c)).status,404);
   assert.equal((await fetch(base+mediaUrl)).status,401);
   assert.equal((await fetch(base+mediaUrl,{headers:{Cookie:clients.otherparent.cookie}})).status,404);
  });
  await t.test('assignment, reply, transfer revocation, closing and parent reopen',async()=>{
   await ok('admin','/consultations/'+c+'/assign','POST',{teacherId:'teacher',version:1});
   assert.equal((await call('admin','/consultations/'+c+'/assign','POST',{teacherId:'otherteacher',version:1})).status,409);
   assert.equal((await fetch(base+mediaUrl,{headers:{Cookie:clients.teacher.cookie}})).status,200);
   const message={text:'请补充你观察到的日常情况',images:[],requestKey:randomUUID(),version:2};await ok('teacher','/consultations/'+c+'/messages','POST',message);await ok('teacher','/consultations/'+c+'/messages','POST',message);
   assert.equal((await ok('parent','/consultations/'+c)).messages.length,2);
   await ok('admin','/consultations/'+c+'/assign','POST',{teacherId:'otherteacher',version:2});
   assert.equal((await fetch(base+mediaUrl,{headers:{Cookie:clients.teacher.cookie}})).status,404);assert.equal((await call('teacher','/consultations/'+c+'/messages','POST',{...message,requestKey:randomUUID(),version:3})).status,404);
   await ok('otherteacher','/consultations/'+c+'/status','POST',{action:'close',version:3});
   assert.equal((await call('parent','/consultations/'+c+'/messages','POST',{...message,requestKey:randomUUID(),version:4})).status,409);
   assert.equal((await call('otherteacher','/consultations/'+c+'/status','POST',{action:'reopen',version:4})).status,403);
   await ok('parent','/consultations/'+c+'/status','POST',{action:'reopen',version:4});assert.equal((await ok('parent','/consultations/'+c)).consultation.status,'active');
   await ok('admin','/consultations/'+c+'/assign','POST',{teacherId:'',version:5});assert.equal((await call('otherteacher','/consultations/'+c)).status,404);
  });
  await t.test('backup contains consultation files and records persist across restart',async()=>{
   const backups=await mkdtemp(join(tmpdir(),'jinlin-journeys-backup-'));
   try{const result=await promisify(execFile)(process.execPath,['scripts/backup.mjs',backups],{env:{...process.env,DATA_DIR:dir},cwd:new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});const target=result.stdout.trim().split('备份完成：')[1];const snapshot=new DatabaseSync(join(target,'jinlin.sqlite'),{readOnly:true});const f=snapshot.prepare('SELECT filename FROM consultation_media').get();assert.ok((await readFile(join(target,'uploads',f.filename))).length>0);snapshot.close();}finally{await rm(backups,{recursive:true,force:true});}
   await new Promise(r=>app.server.close(r));app=createApp({dataDir:dir,origin});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base='http://127.0.0.1:'+app.server.address().port;
   assert.equal((await ok('parent','/consultations/'+c)).messages.length,2);assert.equal((await ok('parent','/appointments/'+a.id+'/review')).review.rating,5);
  });
  await t.test('consultation pagination retains messages and questions with identical timestamps',async()=>{
   const when='2026-01-01T00:00:00.000Z';
   for(let i=0;i<55;i++)run('INSERT INTO consultation_messages VALUES(?,?,?,?,?)',randomUUID(),c,'parent','分页测试 '+i,when);
   const first=await ok('parent','/consultations/'+c);assert.equal(first.messages.length,50);assert.ok(first.next);
   const second=await ok('parent','/consultations/'+c+'?before='+encodeURIComponent(first.next));assert.equal(second.messages.length,7);
   assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,57);
   for(let i=0;i<55;i++)run('INSERT INTO consultations(id,user_id,category,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',randomUUID(),'parent','营养辅食','pending',when,when);
   const list=await ok('admin','/consultations'),next=await ok('admin','/consultations?before='+encodeURIComponent(list.next));assert.equal(new Set([...list.items,...next.items].map(v=>v.id)).size,56);
  });
 }finally{await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});}
});
