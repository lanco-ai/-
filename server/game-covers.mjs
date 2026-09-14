import {check} from './security.mjs';
import {transaction,stamp,audit} from './db.mjs';

const ids=['find-toys','sort-blocks','shared-reading'];
// Images live in the protected database, so the existing SQLite backup includes them.
export function gameCoverHandler({db,body,json,identify,requireUser}){
  const current=id=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('game-cover:'+id)?.value||'{"revision":0,"image":""}');
  return async(req,res,url,user)=>{
    if(url.pathname==='/api/game-covers'&&req.method==='GET'){
      requireUser(user);json(res,Object.fromEntries(ids.map(id=>[id,current(id)])));return true;
    }
    const match=/^\/api\/admin\/game-covers\/([^/]+)$/.exec(url.pathname);
    if(!match)return false;
    requireUser(user,['admin']);check(ids.includes(match[1]),404,'游戏不存在');
    check(['PUT','DELETE'].includes(req.method),405,'不支持此操作');
    const b=await body(req,720000);user=identify(req);requireUser(user,['admin']);
    check(Number.isSafeInteger(b.revision)&&b.revision>=0,400,'请提供当前封面版本');
    let image='';
    if(req.method==='PUT'){
      check(typeof b.image==='string'&&b.image.length<=700000,400,'请上传压缩后不超过500KB的图片');
      const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
      check(m,400,'仅支持 JPEG、PNG、WebP 图片');
      const bytes=Buffer.from(m[2],'base64');
      check(bytes.length>32&&bytes.length<=500*1024&&bytes.toString('base64')===m[2],400,'图片大小或编码不正确');
      check(m[1]==='png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):m[1]==='jpeg'?bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP',400,'图片内容与格式不符');
      image=b.image;
    }
    let value;
    transaction(db,()=>{
      const old=current(match[1]);check(b.revision===old.revision,409,'此封面已被更新，请重新打开游戏封面菜单后再编辑');
      value={revision:old.revision+1,image,updatedAt:stamp()};
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('game-cover:'+match[1],JSON.stringify(value));
      audit(db,user.id,image?'game-cover.save':'game-cover.reset',match[1]);
    });
    json(res,value);return true;
  };
}
