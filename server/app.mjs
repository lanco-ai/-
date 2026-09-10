import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, open, unlink } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction, stamp, audit } from './db.mjs';
import { check, HttpError, token, hash, passwordHash, verifyPassword, passwordRules,
  username, text, profileData, signatureData, chinaDate, dateValid } from './security.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp',
  '.ico':'image/x-icon', '.webm':'video/webm', '.mp4':'video/mp4' };
const DOC_NAMES = ['入户/托育服务协议', '数据及隐私保密协议', '入托健康/信息登记表'];
const sessionMs = 12 * 60 * 60 * 1000;

export function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || './var');
  const origin = options.origin || process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
  const production = options.production ?? process.env.NODE_ENV === 'production';
  check(new URL(origin).origin === origin, 500, 'PUBLIC_ORIGIN 必须是不含路径和尾部斜杠的站点地址');
  if (production) check(origin.startsWith('https://'), 500, '生产环境必须配置 HTTPS PUBLIC_ORIGIN');
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const db = openDatabase(dataDir);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  let uploads = 0;
  let authWork = 0;
  const publicUser = u => u ? ({id:u.id, name:u.name, username:u.username, role:u.role}) : null;

  function currentPolicy() {
    const key = get("SELECT value FROM settings WHERE key='policy'");
    if (!key) return null;
    const p = get('SELECT * FROM policies WHERE id=?', key.value);
    return {...p, documents:JSON.parse(p.documents)};
  }
  function limiter(key, max, duration) {
    const now = Date.now();
    run(`INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END,
      expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END`, hash(key), now+duration, now, now);
    check(get('SELECT count FROM rate_limits WHERE key=?', hash(key)).count <= max, 429, '操作过于频繁，请稍后再试');
  }
  function identify(req) {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(x=>x.trim().split('=')));
    if (!/^[a-f0-9]{64}$/.test(cookies.jinlin_session || '')) return null;
    return get(`SELECT u.*, s.csrf, s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, hash(cookies.jinlin_session), Date.now()) || null;
  }
  function cookie(value, age = sessionMs / 1000) {
    return `jinlin_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${production?'; Secure':''}`;
  }
  function newSession(res, user) {
    const raw = token(), csrf = token();
    run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)', hash(raw),user.id,csrf,Date.now()+sessionMs);
    res.setHeader('Set-Cookie', cookie(raw));
    return {user:publicUser(user), csrf};
  }
  function requireUser(user, roles) {
    check(user, 401, '请先登录');
    if (roles) check(roles.includes(user.role),403,'没有此操作权限');
  }
  function appointment(id, user, staffOnly=false) {
    requireUser(user);
    const a = get('SELECT * FROM appointments WHERE id=?',id);
    check(a && (user.role==='admin' || (user.role==='teacher' && a.teacher_id===user.id)
      || (!staffOnly && user.role==='parent' && a.user_id===user.id)),404,'未找到该预约');
    return a;
  }
  function appointmentView(a) {
    const slot=get('SELECT * FROM slots WHERE id=?',a.slot_id);
    const teacher=a.teacher_id?get('SELECT name FROM users WHERE id=?',a.teacher_id):null;
    return {...JSON.parse(a.profile),id:a.id,userId:a.user_id,slotId:a.slot_id,date:slot.date,
      time:`${slot.start}–${slot.end}`,status:a.status,teacherId:a.teacher_id,teacherName:teacher?.name||'',
      staffNote:a.staff_note,confirmedAt:a.created_at,updatedAt:a.updated_at};
  }
  function slotView(s) {
    const used=get("SELECT count(*) n FROM appointments WHERE slot_id=? AND status IN ('pending','confirmed','completed')",s.id).n;
    return {...s,remaining:Math.max(0,s.capacity-used)};
  }
  function postView(p,user) {
    const author=get('SELECT name,role FROM users WHERE id=?',p.user_id);
    const reply=get(`SELECT c.*,u.name,u.role FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.post_id=? AND u.role IN ('teacher','admin') ORDER BY c.id DESC LIMIT 1`,p.id);
    return {id:p.id,text:p.text,tag:p.tag,name:author.name,role:author.role,mine:p.user_id===user.id,
      time:p.created_at,likes:get('SELECT count(*) n FROM likes WHERE post_id=?',p.id).n,
      liked:!!get('SELECT 1 FROM likes WHERE post_id=? AND user_id=?',p.id,user.id),
      commentCount:get('SELECT count(*) n FROM comments WHERE post_id=?',p.id).n,
      officialReply:reply?{name:reply.name,text:reply.text}:null};
  }
  async function body(req, max=500000) {
    check((req.headers['content-type']||'').split(';')[0]==='application/json',415,'请使用 JSON 请求');
    check(!req.headers['content-encoding'],415,'不支持压缩请求');
    let size=0;const chunks=[];
    for await (const chunk of req) { size+=chunk.length;check(size<=max,413,'请求内容过大');chunks.push(chunk); }
    try { const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));check(value && typeof value==='object'&&!Array.isArray(value),400,'请求格式不正确');return value; }
    catch(error) { if(error instanceof HttpError)throw error;throw new HttpError(400,'JSON 格式不正确'); }
  }
  function json(res, value, status=200) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value)); }

  async function serveFile(req,res,path,mime,privateFile=false) {
    let info;try{info=await stat(path)}catch{throw new HttpError(404,'文件不存在')}
    check(info.isFile(),404,'文件不存在');
    res.setHeader('Content-Type',mime);
    res.setHeader('Cache-Control',privateFile?'private, no-store':'no-cache');
    res.setHeader('Accept-Ranges','bytes');
    let start=0,end=info.size-1,status=200;
    if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match||(!match[1]&&!match[2])){res.setHeader('Content-Range',`bytes */${info.size}`);throw new HttpError(416,'范围无效')}
      if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end}
      else{start=Math.max(0,info.size-Number(match[2]))}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size){res.setHeader('Content-Range',`bytes */${info.size}`);throw new HttpError(416,'范围无效')}
      status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${info.size}`);
    }
    res.setHeader('Content-Length',end-start+1);res.writeHead(status);
    if(req.method==='HEAD'){res.end();return}
    await pipeline(createReadStream(path,{start,end}),res);
  }

  const server=createServer(async(req,res)=>{
    const requestId=randomUUID();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,origin),path=url.pathname,method=req.method;
      const user=identify(req);
      const ip=trustProxy?(req.headers['x-real-ip']||req.socket.remoteAddress):req.socket.remoteAddress;
      const writes=!['GET','HEAD','OPTIONS'].includes(method);
      if(path.startsWith('/api/')){
        limiter('requests:'+ip,1500,60000);
        if(writes){
          check(req.headers.origin===origin,403,'请求来源不匹配，请从本站页面操作');
          if(!['/api/login','/api/register'].includes(path)){
            requireUser(user);check(req.headers['x-csrf-token']===user.csrf,403,'会话校验失败，请刷新页面');
          }
        }
      }
      if(method==='GET'&&path==='/api/health')return json(res,{ok:!!get('SELECT 1 ok').ok});
      if(method==='GET'&&path==='/api/session')return json(res,{user:publicUser(user),csrf:user?.csrf||null,policy:currentPolicy()});
      if(method==='POST'&&['/api/register','/api/login'].includes(path)){
        limiter('auth-ip:'+ip,30,15*60000);
        check(authWork<4,429,'登录服务繁忙，请稍后重试');authWork++;
        try{
          const b=await body(req,5000),account=username(b.username);
          limiter('auth-account:'+account+':'+ip,12,15*60000);
          if(path==='/api/register'){
            limiter('register:'+ip,8,3600000);
            const p=currentPolicy();check(p&&b.policyId===p.id&&b.consent===true,409,'请阅读并同意当前隐私协议后注册');
            const name=text(b.name,'显示名称',30),password=await passwordHash(b.password);
            check(!get('SELECT id FROM users WHERE username=?',account),409,'该账号已被使用');
            const id=randomUUID();transaction(db,()=>{
              run('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)',id,account,name,password,'parent',stamp());
              run('INSERT INTO registration_consents(user_id,policy_id,created_at) VALUES(?,?,?)',id,p.id,stamp());
              audit(db,id,'register',id);
            });
            return json(res,newSession(res,get('SELECT * FROM users WHERE id=?',id)),201);
          }
          const candidate=get('SELECT * FROM users WHERE username=?',account);
          const valid=await verifyPassword(b.password,candidate?.password);
          const latest=candidate&&get('SELECT * FROM users WHERE id=?',candidate.id);
          check(valid&&latest?.active&&latest.password===candidate.password,401,'账号或密码不正确');
          audit(db,candidate.id,'login',candidate.id);return json(res,newSession(res,candidate));
        }finally{authWork--}
      }
      if(method==='POST'&&path==='/api/logout'){
        run('DELETE FROM sessions WHERE token_hash=?',user.token_hash);res.setHeader('Set-Cookie',cookie('',0));return json(res,{ok:true});
      }
      if(method==='POST'&&path==='/api/password'){
        limiter('password:'+user.id,5,15*60000);const b=await body(req,5000);
        check(await verifyPassword(b.oldPassword,user.password),400,'原密码不正确');
        const password=await passwordHash(b.password);
        check(identify(req)?.password===user.password,401,'登录状态已变更，请重新登录');
        transaction(db,()=>{run('UPDATE users SET password=? WHERE id=?',password,user.id);run('DELETE FROM sessions WHERE user_id=?',user.id);audit(db,user.id,'password.change',user.id)});
        res.setHeader('Set-Cookie',cookie('',0));return json(res,{ok:true});
      }
      if(path.startsWith('/api/'))requireUser(user);
      if(method==='GET'&&path==='/api/bootstrap'){
        const rows=user.role==='parent'?all('SELECT * FROM appointments WHERE user_id=? ORDER BY created_at DESC',user.id)
          :user.role==='teacher'?all('SELECT * FROM appointments WHERE teacher_id=? ORDER BY created_at DESC',user.id)
          :all('SELECT * FROM appointments ORDER BY created_at DESC');
        return json(res,{user:publicUser(user),profile:JSON.parse(get('SELECT data FROM profiles WHERE user_id=?',user.id)?.data||'{}'),
          draft:JSON.parse(get('SELECT data FROM drafts WHERE user_id=?',user.id)?.data||'{}'),appointments:rows.map(appointmentView),
          favorites:all('SELECT item FROM favorites WHERE user_id=?',user.id).map(r=>r.item),policy:currentPolicy(),
          slots:all('SELECT * FROM slots WHERE date>=? ORDER BY date,start',chinaDate()).map(slotView),
          teachers:user.role==='admin'?all("SELECT id,name,username,active FROM users WHERE role='teacher' ORDER BY name"):[]});
      }
      if(method==='PUT'&&path==='/api/profile'){
        requireUser(user,['parent']);const d=profileData(await body(req,15000));
        run('INSERT INTO profiles(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data',user.id,JSON.stringify(d));
        audit(db,user.id,'profile.save',user.id);return json(res,{profile:d});
      }
      if(method==='PUT'&&path==='/api/draft'){
        requireUser(user,['parent']);const b=await body(req,15000);const d={};
        for(const k of ['baby','age','gender','allergy','allergyNote','notes','parent','phone','emergency','slotId'])
          if(typeof b[k]==='string')d[k]=b[k].slice(0,1000);
        run('INSERT INTO drafts(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data',user.id,JSON.stringify(d));return json(res,{ok:true});
      }
      if(method==='POST'&&path==='/api/appointments'){
        requireUser(user,['parent']);limiter('book:'+user.id,20,3600000);
        const b=await body(req),profile=profileData(b.profile),signature=signatureData(b.signature);
        const key=text(b.requestKey,'请求编号',80);check(/^[a-zA-Z0-9-]{16,80}$/.test(key),400,'请求编号不正确');
        const existing=get('SELECT * FROM appointments WHERE user_id=? AND request_key=?',user.id,key);
        if(existing)return json(res,{appointment:appointmentView(existing)});
        const p=currentPolicy();check(p&&p.id===b.policyId&&b.agreed===true,409,'协议已更新，请重新阅读并确认');
        const id=randomUUID(),created=stamp();
        transaction(db,()=>{
          const slot=get('SELECT * FROM slots WHERE id=?',String(b.slotId||''));
          check(slot&&slot.enabled&&Date.parse(`${slot.date}T${slot.start}:00+08:00`)>Date.now(),409,'该时段不可预约，请重新选择');
          check(slotView(slot).remaining>0,409,'该时段已约满，请选择其他时段');
          check(!get("SELECT 1 FROM appointments WHERE user_id=? AND slot_id=? AND status IN ('pending','confirmed','completed')",user.id,slot.id),409,'你已预约该时段');
          const evidence=hash(JSON.stringify({profile,slot:{id:slot.id,date:slot.date,start:slot.start,end:slot.end},policyHash:p.hash,signatureHash:hash(signature),created,user:user.id}));
          run(`INSERT INTO appointments(id,user_id,slot_id,profile,policy_id,signature,evidence_hash,request_key,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`,id,user.id,slot.id,JSON.stringify(profile),p.id,signature,evidence,key,created,created);
          run('INSERT INTO profiles(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data',user.id,JSON.stringify(profile));
          run('DELETE FROM drafts WHERE user_id=?',user.id);audit(db,user.id,'appointment.create',id);
        });
        return json(res,{appointment:appointmentView(get('SELECT * FROM appointments WHERE id=?',id))},201);
      }
      let m;
      if(method==='GET'&&(m=/^\/api\/appointments\/([\w-]+)\/agreement$/.exec(path))){
        const a=appointment(m[1],user);const p=get('SELECT * FROM policies WHERE id=?',a.policy_id);
        return json(res,{appointment:appointmentView(a),documents:JSON.parse(p.documents),organization:p.organization,
          policyId:p.id,policyHash:p.hash,signature:a.signature,evidenceHash:a.evidence_hash,confirmedAt:a.created_at});
      }
      if(method==='PATCH'&&(m=/^\/api\/appointments\/([\w-]+)$/.exec(path))){
        const b=await body(req,3000),a=appointment(m[1],user);let status=a.status,teacher=a.teacher_id,note=a.staff_note;
        if(user.role==='parent'){
          check(b.status==='cancelled'&&['pending','confirmed'].includes(a.status),409,'当前预约不能取消');
          const slot=get('SELECT * FROM slots WHERE id=?',a.slot_id);check(Date.parse(`${slot.date}T${slot.start}:00+08:00`)>Date.now(),409,'服务已开始，请联系工作人员');status='cancelled';
        }else{
          if(b.teacherId!==undefined){requireUser(user,['admin']);check(['pending','confirmed'].includes(a.status),409,'当前状态不能重新分配老师');
            const t=get("SELECT * FROM users WHERE id=? AND role='teacher' AND active=1",String(b.teacherId));check(t,400,'请选择有效老师');teacher=t.id;}
          if(b.status){const allowed={pending:['confirmed','rejected'],confirmed:['completed','cancelled'],completed:[],cancelled:[],rejected:[]};
            check(allowed[a.status].includes(b.status),409,'预约状态已变化，请刷新');
            if(b.status==='confirmed')check(teacher,400,'请先分配照护老师');status=b.status;
          }
          if(b.note!==undefined)note=text(b.note,'处理说明',500,false);
          if(['rejected','cancelled'].includes(status))check(note,400,'请填写处理原因');
        }
        run('UPDATE appointments SET status=?,teacher_id=?,staff_note=?,updated_at=? WHERE id=?',status,teacher,note,stamp(),a.id);
        audit(db,user.id,'appointment.'+status,a.id);return json(res,{ok:true});
      }
      if(method==='PUT'&&(m=/^\/api\/favorites\/(article|resource):(\d+)$/.exec(path))){
        check(Number(m[2])<(m[1]==='article'?7:6),404,'内容不存在');const b=await body(req,1000);
        check(typeof b.active==='boolean',400,'收藏状态不正确');const item=`${m[1]}:${m[2]}`;
        if(b.active)run('INSERT OR IGNORE INTO favorites(user_id,item) VALUES(?,?)',user.id,item);
        else run('DELETE FROM favorites WHERE user_id=? AND item=?',user.id,item);return json(res,{ok:true});
      }
      if(method==='GET'&&path==='/api/posts'){
        const before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER);check(Number.isSafeInteger(before)&&before>0,400,'分页参数无效');
        const mine=url.searchParams.get('mine')==='1';
        const rows=mine?all('SELECT * FROM posts WHERE hidden=0 AND id<? AND user_id=? ORDER BY id DESC LIMIT 21',before,user.id)
          :all('SELECT * FROM posts WHERE hidden=0 AND id<? ORDER BY id DESC LIMIT 21',before);
        return json(res,{posts:rows.slice(0,20).map(p=>postView(p,user)),next:rows.length>20?rows[19].id:null});
      }
      if(method==='POST'&&path==='/api/posts'){
        limiter('post:'+user.id,10,60000);const b=await body(req,15000);
        const result=run('INSERT INTO posts(user_id,text,tag,created_at) VALUES(?,?,?,?)',user.id,text(b.text,'留言',2000),text(b.tag||'','话题标签',30,false),stamp());
        return json(res,{id:Number(result.lastInsertRowid)},201);
      }
      if((m=/^\/api\/posts\/(\d+)(?:\/(comments|like))?$/.exec(path))){
        const p=get('SELECT * FROM posts WHERE id=? AND hidden=0',Number(m[1]));check(p,404,'留言不存在或已隐藏');
        if(method==='GET'&&!m[2]){
          const before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER);check(Number.isSafeInteger(before)&&before>0,400,'分页参数无效');
          const comments=all(`SELECT c.id,c.text,c.created_at time,u.name,u.role FROM comments c JOIN users u ON c.user_id=u.id
            WHERE c.post_id=? AND c.id<? ORDER BY c.id DESC LIMIT 21`,p.id,before);
          return json(res,{post:postView(p,user),comments:comments.slice(0,20),next:comments.length>20?comments[19].id:null});
        }
        if(method==='POST'&&m[2]==='comments'){
          limiter('comment:'+user.id,20,60000);const b=await body(req,8000);
          run('INSERT INTO comments(post_id,user_id,text,created_at) VALUES(?,?,?,?)',p.id,user.id,text(b.text,'评论',1000),stamp());return json(res,{ok:true},201);
        }
        if(method==='PUT'&&m[2]==='like'){
          const b=await body(req,1000);check(typeof b.active==='boolean',400,'点赞状态不正确');
          if(b.active)run('INSERT OR IGNORE INTO likes(post_id,user_id) VALUES(?,?)',p.id,user.id);
          else run('DELETE FROM likes WHERE post_id=? AND user_id=?',p.id,user.id);return json(res,{ok:true});
        }
        if(method==='DELETE'&&!m[2]){
          check(user.id===p.user_id||user.role==='admin',403,'没有删除权限');run('UPDATE posts SET hidden=1 WHERE id=?',p.id);audit(db,user.id,'post.hide',String(p.id));return json(res,{ok:true});
        }
      }
      if(method==='GET'&&path==='/api/growth'){
        const before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER);check(Number.isSafeInteger(before)&&before>0,400,'分页参数无效');
        const condition=user.role==='admin'?'1=1':user.role==='teacher'?'a.teacher_id=?':'a.user_id=?';
        const rows=all(`SELECT g.*,a.profile,u.name teacher_name FROM growth g JOIN appointments a ON a.id=g.appointment_id
          JOIN users u ON u.id=g.teacher_id WHERE ${condition} AND g.id<? ORDER BY g.id DESC LIMIT 21`,...(user.role==='admin'?[]:[user.id]),before);
        const daily=get(`SELECT g.diet,g.nap,g.mood,g.occurred_at FROM growth g JOIN appointments a ON a.id=g.appointment_id WHERE ${condition} AND date(g.occurred_at,'+8 hours')=? ORDER BY g.occurred_at DESC,g.id DESC LIMIT 1`,...(user.role==='admin'?[]:[user.id]),chinaDate());
        return json(res,{daily:daily||null,records:rows.slice(0,20).map(r=>({...r,baby:JSON.parse(r.profile).baby,profile:undefined,
          media:all('SELECT m.id,m.mime FROM media m JOIN growth_media gm ON gm.media_id=m.id WHERE gm.growth_id=?',r.id)
            .map(m=>({...m,url:'/api/media/'+m.id}))})),next:rows.length>20?rows[19].id:null});
      }
      if(method==='POST'&&path==='/api/growth'){
        requireUser(user,['teacher','admin']);const b=await body(req,20000),a=appointment(String(b.appointmentId),user,true);
        check(['confirmed','completed'].includes(a.status),409,'确认预约后才能记录照护动态');
        const occurred=text(b.occurredAt,'记录时间',40);const instant=Date.parse(occurred);
        check(Number.isFinite(instant)&&instant<=Date.now()+60000,400,'记录时间不正确或晚于当前时间');
        const slot=get('SELECT * FROM slots WHERE id=?',a.slot_id);
        check(instant>=Date.parse(`${slot.date}T${slot.start}:00+08:00`)&&instant<=Date.parse(`${slot.date}T${slot.end}:00+08:00`),400,'记录时间须在预约服务时段内');
        const title=text(b.title,'动态标题',80),content=text(b.text,'老师记录',3000),diet=text(b.diet||'','饮食',1000,false),nap=text(b.nap||'','午睡',500,false),mood=text(b.mood||'','情绪',500,false);
        const media=b.media||[];check(Array.isArray(media)&&media.length<=8&&new Set(media).size===media.length,400,'最多添加 8 个不同媒体文件');
        transaction(db,()=>{
          for(const id of media){const m=get('SELECT * FROM media WHERE id=?',String(id));check(m&&m.appointment_id===a.id&&m.uploader_id===user.id&&!get('SELECT 1 FROM growth_media WHERE media_id=?',id),400,'媒体文件不属于本次预约或已使用');}
          const result=run('INSERT INTO growth(appointment_id,teacher_id,occurred_at,title,text,diet,nap,mood,created_at) VALUES(?,?,?,?,?,?,?,?,?)',a.id,user.id,new Date(instant).toISOString(),title,content,diet,nap,mood,stamp());
          for(const id of media)run('INSERT INTO growth_media(growth_id,media_id) VALUES(?,?)',Number(result.lastInsertRowid),id);
          audit(db,user.id,'growth.create',String(result.lastInsertRowid));
        });return json(res,{ok:true},201);
      }
      if(method==='POST'&&(m=/^\/api\/upload\/([\w-]+)$/.exec(path))){
        requireUser(user,['teacher','admin']);limiter('upload:'+user.id,30,3600000);
        const a=appointment(m[1],user,true);check(['confirmed','completed'].includes(a.status),409,'确认预约后才能上传');
        const allowed={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm'};
        const mime=req.headers['content-type'],ext=allowed[mime];check(ext,415,'仅支持 PNG、JPEG、WebP 图片和 MP4、WebM 视频');
        const max=mime.startsWith('image/')?10*1024*1024:50*1024*1024;
        check(!req.headers['content-encoding'],415,'不支持压缩上传');
        check(Number(req.headers['content-length']||0)<=max,413,'图片最大 10MB，视频最大 50MB');
        check(uploads<2,429,'上传繁忙，请稍后再试');uploads++;
        const id=randomUUID(),filename=id+ext,file=join(dataDir,'uploads',filename);let size=0,complete=false;
        try{
          const counter=new Transform({transform(chunk,enc,cb){size+=chunk.length;cb(size>max?new HttpError(413,'文件超过大小限制'):null,chunk)}});
          await pipeline(req,counter,createWriteStream(file,{flags:'wx',mode:0o600}));
          const handle=await open(file,'r'),header=Buffer.alloc(32);await handle.read(header,0,32,0);await handle.close();
          const valid=mime==='image/png'?header.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
            :mime==='image/jpeg'?header.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))
            :mime==='image/webp'?header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP'
            :mime==='video/mp4'?header.toString('ascii',4,8)==='ftyp':header.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'));
          check(size>32&&valid,415,'文件内容与格式不匹配');
          // Recheck after streaming: permissions or appointment status may have changed.
          const latestUser=get('SELECT * FROM users WHERE id=? AND active=1',user.id);requireUser(latestUser,['teacher','admin']);
          const latest=appointment(a.id,latestUser,true);check(['confirmed','completed'].includes(latest.status),409,'预约状态已变化');
          run('INSERT INTO media(id,appointment_id,uploader_id,filename,mime,bytes,created_at) VALUES(?,?,?,?,?,?,?)',id,a.id,user.id,filename,mime,size,stamp());
          complete=true;return json(res,{id,url:'/api/media/'+id,mime},201);
        }finally{uploads--;if(!complete)await unlink(file).catch(()=>{});}
      }
      if(['GET','HEAD'].includes(method)&&(m=/^\/api\/media\/([\w-]+)$/.exec(path))){
        const media=get('SELECT * FROM media WHERE id=?',m[1]);check(media,404,'媒体不存在');
        appointment(media.appointment_id,user);
        if(user.role==='parent')check(get('SELECT 1 FROM growth_media WHERE media_id=?',media.id),404,'媒体尚未发布');
        return await serveFile(req,res,join(dataDir,'uploads',media.filename),media.mime,true);
      }
      if(path.startsWith('/api/admin/'))requireUser(user,['admin']);
      if(method==='POST'&&path==='/api/admin/teachers'){
        limiter('create-teacher:'+user.id,10,3600000);const b=await body(req,5000);
        const account=username(b.username),name=text(b.name,'老师姓名',30),password=await passwordHash(b.password);
        check(!get('SELECT 1 FROM users WHERE username=?',account),409,'账号已存在');const id=randomUUID();
        run('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)',id,account,name,password,'teacher',stamp());
        audit(db,user.id,'teacher.create',id);return json(res,{id},201);
      }
      if(method==='PATCH'&&(m=/^\/api\/admin\/teachers\/([\w-]+)$/.exec(path))){
        const b=await body(req,1000);check(typeof b.active==='boolean',400,'状态不正确');
        check(get("SELECT 1 FROM users WHERE id=? AND role='teacher'",m[1]),404,'老师不存在');
        transaction(db,()=>{run('UPDATE users SET active=? WHERE id=?',b.active?1:0,m[1]);run('DELETE FROM sessions WHERE user_id=?',m[1]);audit(db,user.id,'teacher.active',m[1]);});return json(res,{ok:true});
      }
      if(method==='POST'&&path==='/api/admin/slots'){
        const b=await body(req,2000);check(dateValid(b.date)&&b.date>=chinaDate(),400,'请选择今天或之后的有效日期');
        check(typeof b.start==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start)&&typeof b.end==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(b.end)&&b.start<b.end,400,'请设置正确的起止时间');
        check(Number.isInteger(b.capacity)&&b.capacity>=1&&b.capacity<=100,400,'名额应为 1–100');
        check(!get('SELECT 1 FROM slots WHERE date=? AND start<? AND end>?',b.date,b.end,b.start),409,'该日期已有重叠时段，请修改现有时段');
        const id=randomUUID();run('INSERT INTO slots(id,date,start,end,capacity) VALUES(?,?,?,?,?)',id,b.date,b.start,b.end,b.capacity);audit(db,user.id,'slot.create',id);return json(res,{id},201);
      }
      if(method==='PATCH'&&(m=/^\/api\/admin\/slots\/([\w-]+)$/.exec(path))){
        const b=await body(req,1000),s=get('SELECT * FROM slots WHERE id=?',m[1]);check(s,404,'时段不存在');
        check(typeof b.enabled==='boolean',400,'时段状态不正确');check(Number.isInteger(b.capacity)&&b.capacity>=1&&b.capacity<=100,400,'名额应为 1–100');
        const used=s.capacity-slotView(s).remaining;check(b.capacity>=used,409,'名额不能少于已预约人数');
        run('UPDATE slots SET enabled=?,capacity=? WHERE id=?',b.enabled?1:0,b.capacity,s.id);audit(db,user.id,'slot.update',s.id);return json(res,{ok:true});
      }
      if(method==='POST'&&path==='/api/admin/policies'){
        const b=await body(req,300000),organization=text(b.organization,'服务机构名称',100),contact=text(b.contact,'联系及隐私事务方式',200);
        check(Array.isArray(b.documents)&&b.documents.length===3,400,'请填写三份正式文件');
        const documents=b.documents.map((d,i)=>({title:DOC_NAMES[i],text:text(d.text,DOC_NAMES[i],20000)}));
        check(documents.every(d=>d.text.length>=30),400,'请提供完整协议正文（至少 30 字）');
        const id=randomUUID(),digest=hash(JSON.stringify({organization,contact,documents}));
        transaction(db,()=>{
          run('INSERT INTO policies(id,organization,contact,documents,hash,created_at,created_by) VALUES(?,?,?,?,?,?,?)',id,organization,contact,JSON.stringify(documents),digest,stamp(),user.id);
          run("INSERT INTO settings(key,value) VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",id);
          audit(db,user.id,'policy.publish',id);
        });return json(res,{id},201);
      }
      if(path.startsWith('/api/'))throw new HttpError(404,'接口不存在');
      check(['GET','HEAD'].includes(method),405,'不支持此请求方式');
      let decoded;try{decoded=decodeURIComponent(path)}catch{throw new HttpError(400,'路径无效')}
      check(!decoded.includes('\0')&&!decoded.includes('\\'),400,'路径无效');
      const file=resolve(PUBLIC,'.'+(decoded==='/'?'/index.html':decoded));
      check(file.startsWith(PUBLIC.endsWith(sep)?PUBLIC:PUBLIC+sep),404,'文件不存在');
      const mime=TYPES[extname(file)];check(mime,404,'文件不存在');return await serveFile(req,res,file,mime);
    }catch(error){
      if(res.headersSent||res.destroyed){if(!res.destroyed)res.destroy();return}
      if(!error.status)console.error(JSON.stringify({requestId,error:error.code||error.name}));
      const status=error.status||500;
      if(status===429)res.setHeader('Retry-After','60');
      json(res,{error:status===500?'服务器暂时无法处理，请稍后重试':error.message,fields:error.fields,requestId},status);
    }
  });
  server.requestTimeout=120000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  const cleanup=setInterval(()=>{
    run('DELETE FROM sessions WHERE expires_at<?',Date.now());run('DELETE FROM rate_limits WHERE expires_at<?',Date.now());
  },600000);cleanup.unref();
  server.on('close',()=>{clearInterval(cleanup);db.close()});
  return {server,db,dataDir};
}
