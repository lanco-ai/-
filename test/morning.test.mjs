import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {passwordHash,chinaDate} from '../server/security.mjs';
import {png} from './helpers.mjs';

test('morning workflow, versioned parent consent and private historical import',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jinlin-morning-')),origin='http://localhost:3000';let app=createApp({dataDir:dir,origin});
  const db=app.db,run=(sql,...args)=>db.prepare(sql).run(...args),now=new Date().toISOString(),today=chinaDate();
  const password=await passwordHash('Morning-test-password-123');
  for(const [id,role]of [['admin','admin'],['teacher','teacher'],['otherteacher','teacher'],['parent','parent'],['otherparent','parent']])run('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)',id,id,id,password,role,now);
  run('INSERT INTO policies(id,organization,contact,documents,hash,created_at,created_by) VALUES(?,?,?,?,?,?,?)','policy','机构','联系',JSON.stringify([]),'hash',now,'admin');
  const profile={baby:'测试宝宝',age:'9',gender:'男',parent:'测试家长',phone:'13800000000'};
  const future=new Date(Date.now()+86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  for(const [id,date,start]of [['daily',today,'09:00'],['imported',today,'12:00'],['future',future,'09:00']]){
    run('INSERT INTO slots(id,date,start,end,capacity) VALUES(?,?,?,?,?)',id,date,start,'14:00',2);
    run("INSERT INTO appointments(id,user_id,slot_id,profile,policy_id,signature,evidence_hash,status,teacher_id,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'confirmed',?,?,?,?)",id,'parent',id,JSON.stringify(profile),'policy','old booking signature','hash','teacher',id,now,now);
  }
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');let base=`http://127.0.0.1:${app.server.address().port}`;const clients={};
  async function call(who,path,method='GET',data,extra={}){
    const c=clients[who]||{},headers={Origin:origin,...(c.cookie?{Cookie:c.cookie}:{}),...(c.csrf?{'X-CSRF-Token':c.csrf}:{}),...extra};
    if(data!==undefined&&!Buffer.isBuffer(data))headers['Content-Type']='application/json';
    const res=await fetch(base+'/api'+path,{method,headers,body:data===undefined?undefined:Buffer.isBuffer(data)?data:JSON.stringify(data)});
    const body=await res.json().catch(()=>null);if(body?.csrf)clients[who]={csrf:body.csrf,cookie:res.headers.get('set-cookie').split(';')[0]};return {status:res.status,body};
  }
  const ok=async(...args)=>{const r=await call(...args);assert.ok(r.status>=200&&r.status<300,JSON.stringify(r));return r.body;};
  const full={ask:'睡眠饮食观察',look:'面色与精神观察',touch:'体温与皮肤观察',inspect:'手足与随身物品检查',doctor:''};
  const signed='data:image/png;base64,'+png().toString('base64');let draft,submitted,confirmed;
  try{
    for(const who of ['admin','teacher','otherteacher','parent','otherparent'])await ok(who,'/login','POST',{username:who,password:'Morning-test-password-123'});
    await t.test('private access, blank drafts, future submission and concurrent editing',async()=>{
      assert.equal((await call('none','/morning')).status,401);assert.equal((await call('otherparent','/morning/daily')).status,404);assert.equal((await call('otherteacher','/morning/daily')).status,404);
      assert.equal((await call('parent','/morning/daily/save','POST',{})).status,404);
      const save={baseVersion:null,lock:0,requestKey:randomUUID()};draft=(await ok('teacher','/morning/daily/save','POST',save)).versions[0];
      assert.equal((await ok('teacher','/morning/daily/save','POST',save)).versions.length,1);
      assert.equal((await ok('parent','/morning/daily')).versions.length,0);assert.equal((await ok('parent','/morning')).records.length,0);
      assert.equal((await call('teacher','/morning/daily/submit','POST',{versionId:draft.id,lock:draft.lock,requestKey:randomUUID()})).status,400);
      const update={...full,baseVersion:draft.id,lock:draft.lock,requestKey:randomUUID()};
      draft=(await ok('teacher','/morning/daily/save','POST',update)).versions[0];
      assert.equal((await call('admin','/morning/daily/save','POST',{...full,baseVersion:draft.id,lock:1,requestKey:randomUUID()})).status,409);
      const newer=(await ok('admin','/morning/daily/save','POST',{...full,ask:'管理员补充观察',baseVersion:draft.id,lock:draft.lock,requestKey:randomUUID()})).versions[0];
      const replay=(await ok('teacher','/morning/daily/save','POST',update)).versions[0];assert.equal(replay.lock,draft.lock);
      assert.equal((await call('teacher','/morning/daily/submit','POST',{versionId:replay.id,lock:replay.lock,requestKey:randomUUID()})).status,409);
      draft=newer;
      const f=(await ok('teacher','/morning/future/save','POST',{...full,baseVersion:null,requestKey:randomUUID()})).versions[0];
      assert.equal((await call('teacher','/morning/future/submit','POST',{versionId:f.id,lock:f.lock,requestKey:randomUUID()})).status,400);
    });
    await t.test('submitted content requires fresh, nonblank parent signature; retries are idempotent',async()=>{
      const b={versionId:draft.id,lock:draft.lock,requestKey:randomUUID()};submitted=(await ok('teacher','/morning/daily/submit','POST',b)).versions[0];
      assert.equal((await ok('teacher','/morning/daily/submit','POST',b)).versions.length,1);
      const visible=await ok('parent','/morning/daily');assert.equal(visible.canConfirm,true);assert.equal(visible.versions[0].signature,null);assert.deepEqual(visible.versions[0].profile,{baby:profile.baby,gender:profile.gender,age:profile.age});
      const sign={versionId:submitted.id,lock:submitted.lock,agreed:true,signature:signed,requestKey:randomUUID()};
      assert.equal((await call('parent','/morning/daily/confirm','POST',{...sign,agreed:false})).status,400);
      assert.equal((await call('parent','/morning/daily/confirm','POST',{...sign,signature:'data:image/png;base64,'+png(true).toString('base64')})).status,400);
      assert.equal((await call('teacher','/morning/daily/confirm','POST',sign)).status,403);
      confirmed=(await ok('parent','/morning/daily/confirm','POST',sign)).versions[0];assert.equal(confirmed.signature,signed);assert.ok(confirmed.confirmedAt);
      assert.equal((await ok('parent','/morning/daily/confirm','POST',sign)).versions[0].confirmedAt,confirmed.confirmedAt);
    });
    await t.test('corrections preserve old signatures and reject stale confirmation',async()=>{
      const correction=(await ok('teacher','/morning/daily/save','POST',{...full,ask:'更正后的睡眠记录',baseVersion:confirmed.id,lock:confirmed.lock,requestKey:randomUUID()})).versions[0];assert.equal(correction.revision,2);
      let r=await ok('parent','/morning/daily');assert.equal(r.correcting,true);assert.equal(r.canConfirm,false);assert.equal(r.versions.length,1);
      const newer=(await ok('teacher','/morning/daily/submit','POST',{versionId:correction.id,lock:correction.lock,requestKey:randomUUID()})).versions[0];
      assert.equal((await call('parent','/morning/daily/confirm','POST',{versionId:submitted.id,lock:submitted.lock,signature:signed,agreed:true,requestKey:randomUUID()})).status,409);
      r=await ok('parent','/morning/daily');assert.equal(r.versions.length,2);assert.equal(r.versions[1].signature,signed);assert.equal(r.versions[0].signature,null);assert.equal(r.canConfirm,true);
      await ok('parent','/morning/daily/confirm','POST',{versionId:newer.id,lock:newer.lock,signature:signed,agreed:true,requestKey:randomUUID()});
    });
    await t.test('original signature attachment remains private and cannot be reused as growth media',async()=>{
      assert.equal((await call('teacher','/upload/imported?purpose=morning','POST',png(),{'Content-Type':'image/png'})).status,403);
      const media=await ok('admin','/upload/imported?purpose=morning','POST',png(),{'Content-Type':'image/png'});
      assert.equal((await call('parent','/media/'+media.id)).status,404);
      const b={...full,profile:{baby:profile.baby,gender:profile.gender,age:profile.age},date:today,sourceMediaId:media.id,requestKey:randomUUID()};
      assert.equal((await call('admin','/morning/imported/import','POST',{...b,profile:{...b.profile,baby:'其他宝宝'}})).status,400);
      assert.equal((await call('admin','/morning/imported/import','POST',{...b,date:future})).status,400);
      let r=await ok('admin','/morning/imported/import','POST',b);assert.equal(r.versions[0].source,'import');assert.equal(r.versions[0].signature,null);
      assert.equal((await ok('admin','/morning/imported/import','POST',b)).versions.length,1);
      assert.equal((await call('admin','/morning/imported/import','POST',{...b,requestKey:randomUUID()})).status,409);
      r=await ok('parent','/morning/imported');assert.equal(r.canConfirm,true);assert.equal((await call('parent','/media/'+media.id)).status,200);
      assert.equal((await call('otherparent','/media/'+media.id)).status,404);assert.equal((await call('none','/media/'+media.id)).status,401);
      assert.equal(db.prepare('SELECT purpose FROM media WHERE id=?').get(media.id).purpose,'morning');
      run("UPDATE slots SET start='00:00',end='23:59' WHERE id='imported'");
      const wrongUse=await call('admin','/growth','POST',{appointmentId:'imported',occurredAt:new Date().toISOString(),title:'不能作为活动照片',text:'原表签名',media:[media.id]});
      assert.equal(wrongUse.status,400);assert.match(wrongUse.body.error,/媒体文件/);
    });
    await t.test('restart retains revisions, parent signatures and private source attachment',async()=>{
      await new Promise(resolve=>app.server.close(resolve));app=createApp({dataDir:dir,origin});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;
      const r=await ok('parent','/morning/daily');assert.equal(r.versions.length,2);assert.ok(r.versions.every(v=>v.signature===signed));
      const old=await ok('parent','/morning/imported');assert.equal(old.versions[0].signature,null);assert.equal((await call('parent',old.versions[0].sourceImage.replace('/api',''))).status,200);
    });
  }finally{await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
