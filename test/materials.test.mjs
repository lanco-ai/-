import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fillAgreement} from '../server/agreement.mjs';
import {openDatabase} from '../server/db.mjs';
test('version 3 upgrade preserves published and hidden community posts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jinlin-v3-'));
  try{
    let db=openDatabase(dir);db.exec(`
      INSERT INTO users(id,username,name,password,role,created_at) VALUES('u','user','旧账号','hash','parent','2026-01-01');
      INSERT INTO posts(id,user_id,text,tag,hidden,created_at) VALUES(1,'u','已公开','交流',0,'2026-01-01'),(2,'u','已隐藏','交流',1,'2026-01-01');
      DROP INDEX posts_moderation; ALTER TABLE posts DROP COLUMN moderation; ALTER TABLE posts DROP COLUMN review_note;
      ALTER TABLE posts DROP COLUMN review_version; ALTER TABLE posts DROP COLUMN reviewed_by; ALTER TABLE posts DROP COLUMN reviewed_at;
      PRAGMA user_version=3;
    `);db.close();db=openDatabase(dir);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);
    assert.deepEqual(db.prepare('SELECT text,hidden,moderation,review_version FROM posts ORDER BY id').all().map(p=>({...p})),[
      {text:'已公开',hidden:0,moderation:'approved',review_version:0},
      {text:'已隐藏',hidden:1,moderation:'approved',review_version:0}
    ]);db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('browser preview and stored agreement apply identical single-pass substitutions',()=>{
  const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/materials.js',import.meta.url),'utf8'),context);
  const template='{{organization}} / {{baby}} / {{age}} / {{parent}} / {{phone}} / {{date}} / {{teacher}}';
  const profile={baby:'<宝宝>{{phone}}',age:0,parent:'家长',phone:'13800000000',date:'2026-09-10',teacherName:'后来分配的老师'};
  context.template=template;context.profile=profile;
  const result=fillAgreement(template,profile,'机构');
  assert.equal(vm.runInContext("fillAgreement(template,profile,'机构')",context),result);
  assert.match(result,/待分配（签署时）/);assert.match(result,/<宝宝>\{\{phone\}\}/);assert.ok(!result.includes('后来分配的老师'));
});
test('version 1 databases migrate without modifying stored policy documents',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jinlin-migration-'));
  try{
    let db=openDatabase(dir);db.exec('DROP INDEX posts_moderation; ALTER TABLE posts DROP COLUMN moderation; ALTER TABLE posts DROP COLUMN review_note; ALTER TABLE posts DROP COLUMN review_version; ALTER TABLE posts DROP COLUMN reviewed_by; ALTER TABLE posts DROP COLUMN reviewed_at; DROP TABLE morning_requests; DROP TABLE morning_versions; ALTER TABLE media DROP COLUMN purpose; ALTER TABLE appointments DROP COLUMN signed_documents; PRAGMA user_version=1;');db.close();
    db=openDatabase(dir);assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);
    assert.ok(db.prepare('PRAGMA table_info(appointments)').all().some(c=>c.name==='signed_documents'));db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('public resource count stays fixed and unreviewed instructions remain server-side',()=>{
  const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/content.js',import.meta.url),'utf8')+readFileSync(new URL('../public/material-content.js',import.meta.url),'utf8'),context);
  assert.equal(vm.runInContext('ARTICLES.length',context),7);assert.equal(vm.runInContext('RESOURCES.length',context),6);
  assert.equal(vm.runInContext('MATERIAL_CONTENT.chapters.length',context),3);
  assert.ok(!readFileSync(new URL('../public/material-content.js',import.meta.url),'utf8').includes('饭后 45 分钟'));
});
test('version 2 upgrade preserves existing signed document snapshots',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jinlin-v2-'));
  try{
    let db=openDatabase(dir);db.exec(`
      INSERT INTO users(id,username,name,password,role,created_at) VALUES('u','user','旧账号','hash','parent','2026-01-01');
      INSERT INTO policies(id,organization,contact,documents,hash,created_at,created_by) VALUES('p','机构','联系','[]','hash','2026-01-01','u');
      INSERT INTO slots(id,date,start,end,capacity) VALUES('s','2026-01-01','09:00','10:00',1);
      INSERT INTO appointments(id,user_id,slot_id,profile,policy_id,signature,evidence_hash,request_key,created_at,updated_at,signed_documents)
        VALUES('a','u','s','{}','p','original-signature','hash','old-request','2026-01-01','2026-01-01','[{"text":"历史已签内容"}]');
      DROP INDEX posts_moderation; ALTER TABLE posts DROP COLUMN moderation; ALTER TABLE posts DROP COLUMN review_note; ALTER TABLE posts DROP COLUMN review_version; ALTER TABLE posts DROP COLUMN reviewed_by; ALTER TABLE posts DROP COLUMN reviewed_at; DROP TABLE morning_requests; DROP TABLE morning_versions; ALTER TABLE media DROP COLUMN purpose; PRAGMA user_version=2;
    `);db.close();db=openDatabase(dir);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);
    const a=db.prepare('SELECT * FROM appointments WHERE id=?').get('a');assert.equal(a.signature,'original-signature');assert.equal(JSON.parse(a.signed_documents)[0].text,'历史已签内容');
    assert.equal(db.prepare('SELECT count(*) n FROM morning_versions').get().n,0);db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
