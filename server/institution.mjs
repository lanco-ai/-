import {check,text} from './security.mjs';
import {stamp,audit,transaction} from './db.mjs';
export function institutionHandler({db,body,json,identify,requireUser}){
  const current=()=>JSON.parse(db.prepare("SELECT value FROM settings WHERE key='institution'").get()?.value||'{"revision":0,"intro":"","team":[],"environment":[],"notices":[]}');
  function picture(value){
    if(!value)return '';check(typeof value==='string'&&value.length<=700000,400,'每张图片最大 500KB');
    const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);check(m,400,'请上传 PNG、JPEG 或 WebP 图片');
    const b=Buffer.from(m[2],'base64');check(b.length>32&&b.length<=500*1024,400,'图片大小不正确');
    check(m[1]==='png'?b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):m[1]==='jpeg'?b.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP',400,'图片内容与格式不符');return value;
  }
  return async(req,res,url,user)=>{
    if(url.pathname!=='/api/institution')return false;
    if(req.method==='GET'){requireUser(user);json(res,current());return true;}
    check(req.method==='PUT',405,'不支持此操作');const b=await body(req,12000000);user=identify(req);requireUser(user,['admin']);
    check(Array.isArray(b.team)&&b.team.length<=8&&Array.isArray(b.environment)&&b.environment.length<=8&&Array.isArray(b.notices)&&b.notices.length<=10,400,'师资和环境最多各 8 项，公告最多 10 项');
    check([...b.team,...b.environment,...b.notices].every(x=>x&&typeof x==='object'&&!Array.isArray(x)),400,'机构资料格式不正确');
    const value={intro:text(b.intro,'机构简介',2000),
      team:b.team.map(t=>({name:text(t.name,'老师姓名',30),title:text(t.title,'师资介绍',100),intro:text(t.intro||'','老师简介',500,false),image:picture(t.image)})),
      environment:b.environment.map(e=>({caption:text(e.caption,'环境说明',100),image:picture(e.image)})),
      notices:b.notices.map(n=>({title:text(n.title,'公告标题',100),text:text(n.text,'公告内容',2000)}))};
    check(value.environment.every(e=>e.image),400,'请为环境项目上传图片');
    transaction(db,()=>{const old=current();check(b.revision===old.revision,409,'机构资料已更新，请重新打开编辑页');
      value.revision=old.revision+1;value.updatedAt=stamp();
      db.prepare("INSERT INTO settings(key,value) VALUES('institution',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));audit(db,user.id,'institution.publish',String(value.revision));
    });json(res,value);return true;
  };
}
