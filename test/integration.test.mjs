import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { passwordHash } from '../server/security.mjs';

// Generate a valid 1000x250 PNG with a visible signature-like stroke, without browser dependencies.
function png(blank=false){
  function crc(buf){let n=0xffffffff;for(const b of buf){n^=b;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
  function chunk(name,data){const type=Buffer.from(name),len=Buffer.alloc(4),c=Buffer.alloc(4);len.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([len,type,data,c]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(1000);header.writeUInt32BE(250,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc((1000*4+1)*250,255);for(let y=0;y<250;y++){pixels[y*4001]=0;for(let x=0;x<1000;x++)if(!blank&&x>50&&x<400&&Math.abs(y-(50+x/4))<3){const p=y*4001+1+x*4;pixels[p]=40;pixels[p+1]=70;pixels[p+2]=45;}}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
test('real multi-user workflow, authorization, persistence and operational boundaries',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jinlin-test-'));
  const origin='http://localhost:3000';let app=createApp({dataDir:dir,origin});
  app.db.prepare('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run('admin','admin','管理员',await passwordHash('A-strong-test-password-1'),'admin',new Date().toISOString());
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');let base=`http://127.0.0.1:${app.server.address().port}`;
  const clients={};
  async function call(who,path,method='GET',data,extra={}){
    const c=clients[who]||{},headers={Origin:origin,...(c.cookie?{Cookie:c.cookie}:{}),...(c.csrf?{'X-CSRF-Token':c.csrf}:{}),...extra};
    if(data!==undefined&&!(data instanceof Buffer))headers['Content-Type']='application/json';
    const r=await fetch(base+'/api'+path,{method,headers,body:data===undefined?undefined:data instanceof Buffer?data:JSON.stringify(data)});
    const set=r.headers.get('set-cookie');if(set){clients[who]??={};clients[who].cookie=set.split(';')[0];}
    const body=await r.json().catch(()=>null);if(body?.csrf){clients[who]??={};clients[who].csrf=body.csrf;}
    return {status:r.status,body,headers:r.headers};
  }
  const ok=async(...args)=>{const r=await call(...args);assert.ok(r.status>=200&&r.status<300,JSON.stringify(r.body));return r.body;};
  try{
    await t.test('bootstrap requires authentication; no demo records',async()=>{assert.equal((await call('none','/bootstrap')).status,401);assert.equal((await call('none','/register','POST',{username:'parent1',password:'long-password-123',name:'家长'})).status,409);});
    await ok('admin','/login','POST',{username:'admin',password:'A-strong-test-password-1'});
    let policy;
    await t.test('admin publishes versioned policies; CSRF and origin enforced',async()=>{
      assert.equal((await call('admin','/admin/policies','POST',{}, {'X-CSRF-Token':'bad'})).status,403);
      assert.equal((await call('admin','/admin/policies','POST',{}, {Origin:'https://evil.invalid'})).status,403);
      policy=await ok('admin','/admin/policies','POST',{organization:'测试机构',contact:'服务电话 010-12345678',documents:[0,1,2].map(i=>({text:`协议 ${i}：本文件用于自动化测试，包含机构确认的服务安排、信息处理和健康登记说明，家长确认后提交预约。`}))});
    });
    for(const [who,name]of [['parent1','家长一'],['parent2','家长二']])await ok(who,'/register','POST',{username:who,password:'Parent-test-password-123',name,policyId:policy.id,consent:true});
    const teacher=await ok('admin','/admin/teachers','POST',{username:'teacher1',password:'Teacher-test-password-123',name:'老师一'});
    await ok('admin','/admin/teachers','POST',{username:'teacher2',password:'Teacher-test-password-123',name:'老师二'});
    for(const who of ['teacher1','teacher2'])await ok(who,'/login','POST',{username:who,password:'Teacher-test-password-123'});
    const profile={baby:'宝宝甲',age:'24',gender:'女',allergy:'有',allergyNote:'鸡蛋',notes:'',parent:'家长一',phone:'13800000000',emergency:'李先生 13900000000'};
    await t.test('server validates profile and isolates profiles',async()=>{
      assert.equal((await call('parent1','/profile','PUT',{...profile,age:'-1'})).status,400);
      assert.equal((await call('parent1','/profile','PUT',{...profile,allergyNote:''})).status,400);
      await ok('parent1','/profile','PUT',profile);assert.deepEqual((await ok('parent2','/bootstrap')).profile,{});
      assert.equal((await call('parent1','/admin/teachers','POST',{username:'evil'})).status,403);
    });
    const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
    const slot=await ok('admin','/admin/slots','POST',{date:tomorrow,start:'09:00',end:'12:00',capacity:1});
    let appointment;
    const booking={profile,slotId:slot.id,signature:'data:image/png;base64,'+png().toString('base64'),policyId:policy.id,agreed:true,requestKey:'test-request-key-0000001'};
    await t.test('atomic capacity, idempotency, signature and cancellation',async()=>{
      assert.equal((await call('parent1','/appointments','POST',{...booking,signature:''})).status,400);
      assert.equal((await call('parent1','/appointments','POST',{...booking,signature:'data:image/png;base64,'+png(true).toString('base64')})).status,400);
      assert.equal((await call('parent1','/appointments','POST',{...booking,agreed:false})).status,409);
      await ok('parent1','/draft','PUT',{...profile,slotId:slot.id});
      const results=await Promise.all([call('parent1','/appointments','POST',booking),call('parent2','/appointments','POST',{...booking,requestKey:'test-request-key-0000002'})]);
      assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
      const winner=results[0].status===201?'parent1':'parent2';
      if(winner==='parent2'){const a=results[1].body.appointment;await ok('parent2','/appointments/'+a.id,'PATCH',{status:'cancelled'});appointment=(await ok('parent1','/appointments','POST',booking)).appointment;}
      else appointment=results[0].body.appointment;
      assert.equal((await ok('parent1','/appointments','POST',booking)).appointment.id,appointment.id);
      assert.equal((await ok('parent1','/bootstrap')).appointments.length,1);
      assert.deepEqual((await ok('parent1','/bootstrap')).draft,{});
      assert.equal((await call('parent2','/appointments/'+appointment.id+'/agreement')).status,404);
      assert.equal((await call('teacher2','/appointments/'+appointment.id+'/agreement')).status,404);
    });
    await t.test('only assigned teacher sees private appointment; immutable signed version',async()=>{
      await ok('admin','/appointments/'+appointment.id,'PATCH',{teacherId:teacher.id,status:'confirmed'});
      assert.equal((await ok('teacher1','/bootstrap')).appointments.length,1);
      assert.equal((await ok('teacher2','/bootstrap')).appointments.length,0);
      await ok('admin','/admin/policies','POST',{organization:'测试机构',contact:'服务电话 010-12345678',documents:[0,1,2].map(i=>({text:`新版 ${i}：本文件是后续发布的新协议，更新了机构确认的服务安排、信息处理和健康登记说明。历史签署不被替换。`}))});
      assert.equal((await ok('parent1','/appointments/'+appointment.id+'/agreement')).policyId,policy.id);
    });
    await t.test('real uploads, unshared files protected, growth private, video byte ranges',async()=>{
      const uploaded=await ok('teacher1','/upload/'+appointment.id,'POST',png(),{'Content-Type':'image/png'});
      assert.equal((await call('parent1','/media/'+uploaded.id)).status,404);
      assert.equal((await call('parent2','/media/'+uploaded.id)).status,404);
      assert.equal((await call('teacher2','/upload/'+appointment.id,'POST',png(),{'Content-Type':'image/png'})).status,404);
      assert.equal((await call('teacher1','/upload/'+appointment.id,'POST',Buffer.from('<svg>bad</svg>'),{'Content-Type':'image/png'})).status,415);
      const future=Date.parse(tomorrow+'T10:00:00+08:00');
      t.mock.timers.enable({apis:['Date'],now:future});
      for(const who of ['parent1','parent2'])await ok(who,'/login','POST',{username:who,password:'Parent-test-password-123'});
      for(const who of ['teacher1','teacher2'])await ok(who,'/login','POST',{username:who,password:'Teacher-test-password-123'});
      await ok('admin','/login','POST',{username:'admin',password:'A-strong-test-password-1'});
      assert.equal((await call('parent1','/growth','POST',{})).status,403);
      await ok('teacher1','/growth','POST',{appointmentId:appointment.id,occurredAt:new Date(future).toISOString(),title:'绘本阅读',text:'主动指认绘本中的小动物。',diet:'米饭与蔬菜',nap:'平稳',mood:'愉快',media:[uploaded.id]});
      assert.equal((await ok('parent1','/growth')).records.length,1);
      assert.equal((await ok('parent2','/growth')).records.length,0);
      assert.equal((await ok('teacher2','/growth')).records.length,0);
      const r=await fetch(base+'/api/media/'+uploaded.id,{headers:{Cookie:clients.parent1.cookie,Range:'bytes=0-15'}});
      assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,16);assert.match(r.headers.get('cache-control'),/no-store/);
      assert.equal((await fetch(base+'/api/media/'+uploaded.id,{headers:{Cookie:clients.parent2.cookie}})).status,404);
    });
    let post;
    await t.test('shared community, server-assigned identities, idempotent likes and favorites',async()=>{
      post=await ok('parent1','/posts','POST',{text:'今天进步了一点点',tag:'成长日常',name:'伪装管理员',role:'admin'});
      assert.equal((await ok('parent2','/posts')).posts[0].name,'家长一');
      await ok('teacher1','/posts/'+post.id+'/comments','POST',{text:'很棒的进步，继续耐心陪伴。',role:'parent'});
      const p=await ok('parent1','/posts/'+post.id);assert.equal(p.comments[0].role,'teacher');
      await ok('parent2','/posts/'+post.id+'/like','PUT',{active:true});await ok('parent2','/posts/'+post.id+'/like','PUT',{active:true});
      assert.equal((await ok('parent1','/posts/'+post.id)).post.likes,1);
      await ok('parent1','/favorites/article:0','PUT',{active:true});await ok('parent1','/favorites/resource:0','PUT',{active:true});
      assert.equal((await ok('parent1','/bootstrap')).favorites.length,2);assert.deepEqual((await ok('parent2','/bootstrap')).favorites,[]);
      assert.equal((await call('parent2','/posts/'+post.id,'DELETE',{})).status,403);
    });
    await t.test('password changes and staff suspension revoke sessions',async()=>{
      const oldCookie=clients.parent2.cookie;await ok('parent2','/password','POST',{oldPassword:'Parent-test-password-123',password:'Changed-password-12345'});
      assert.equal((await fetch(base+'/api/bootstrap',{headers:{Cookie:oldCookie}})).status,401);
      await ok('admin','/admin/teachers/'+teacher.id,'PATCH',{active:false});assert.equal((await call('teacher1','/bootstrap')).status,401);
      await ok('admin','/admin/teachers/'+teacher.id,'PATCH',{active:true});
    });
    await t.test('online backup contains a consistent database and referenced media',async()=>{
      const backups=await mkdtemp(join(tmpdir(),'jinlin-backup-test-'));
      try{
        await promisify(execFile)(process.execPath,['scripts/backup.mjs',backups],{
          cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,DATA_DIR:dir}
        });
        const entries=await readdir(backups);assert.equal(entries.length,1);const target=join(backups,entries[0]);
        const snapshot=new DatabaseSync(join(target,'jinlin.sqlite'),{readOnly:true});
        try{
          assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check,'ok');
          assert.equal(snapshot.prepare('SELECT count(*) n FROM growth').get().n,1);
          for(const row of snapshot.prepare('SELECT filename FROM media').all())assert.ok((await readFile(join(target,'uploads',row.filename))).length>0);
          assert.equal(JSON.parse(await readFile(join(target,'backup.json'),'utf8')).schema,1);
        }finally{snapshot.close();}
      }finally{await rm(backups,{recursive:true,force:true});}
    });
    await t.test('data survives server restart; no public database or uploads path',async()=>{
      await new Promise(resolve=>app.server.close(resolve));app=createApp({dataDir:dir,origin});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;
      assert.equal((await ok('parent1','/bootstrap')).appointments[0].baby,profile.baby);
      assert.equal((await ok('parent1','/growth')).records.length,1);
      assert.equal((await fetch(base+'/server/app.mjs')).status,404);
      assert.equal((await fetch(base+'/var/jinlin.sqlite')).status,404);
      assert.equal((await fetch(base+'/.env')).status,404);
      const raw=await readFile(join(dir,'jinlin.sqlite'));assert.ok(raw.length>0);
      await ok('admin','/posts/'+post.id,'DELETE',{});assert.equal((await call('parent1','/posts/'+post.id)).status,404);
    });
  }finally{t.mock.timers.reset();await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
