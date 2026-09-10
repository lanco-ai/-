import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fillAgreement} from '../server/agreement.mjs';
import {openDatabase} from '../server/db.mjs';
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
    let db=openDatabase(dir);db.exec('ALTER TABLE appointments DROP COLUMN signed_documents; PRAGMA user_version=1;');db.close();
    db=openDatabase(dir);assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);
    assert.ok(db.prepare('PRAGMA table_info(appointments)').all().some(c=>c.name==='signed_documents'));db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('public resource count stays fixed and unreviewed instructions remain server-side',()=>{
  const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/content.js',import.meta.url),'utf8')+readFileSync(new URL('../public/material-content.js',import.meta.url),'utf8'),context);
  assert.equal(vm.runInContext('ARTICLES.length',context),7);assert.equal(vm.runInContext('RESOURCES.length',context),6);
  assert.equal(vm.runInContext('MATERIAL_CONTENT.chapters.length',context),3);
  assert.ok(!readFileSync(new URL('../public/material-content.js',import.meta.url),'utf8').includes('饭后 45 分钟'));
});
