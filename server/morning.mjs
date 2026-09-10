import {randomUUID} from 'node:crypto';
import {check,text,hash,signatureData,chinaDate} from './security.mjs';
import {transaction,stamp,audit} from './db.mjs';

export function morningHandler({db,body,appointment,identify,requireUser,json,limiter}){
  const get=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
  const latest=id=>get('SELECT * FROM morning_versions WHERE appointment_id=? ORDER BY revision DESC LIMIT 1',id);
  function view(v){return {id:v.id,appointmentId:v.appointment_id,revision:v.revision,lock:v.lock,status:v.status,
    profile:JSON.parse(v.profile),date:v.service_date,ask:v.ask,look:v.look,touch:v.touch,inspect:v.inspect,doctor:v.doctor,
    authorName:v.author_name,createdAt:v.created_at,updatedAt:v.updated_at,submittedAt:v.submitted_at,
    source:v.source,sourceImage:v.source_media_id?'/api/media/'+v.source_media_id:null,
    contentHash:v.content_hash,signature:v.parent_signature,confirmedAt:v.confirmed_at};}
  function read(id,user){
    const a=appointment(id,user),head=latest(id),versions=all("SELECT * FROM morning_versions WHERE appointment_id=? ORDER BY revision DESC",id)
      .filter(v=>user.role!=='parent'||v.status==='submitted');
    const visible=versions[0];return {appointmentId:id,versions:versions.map(view),
      canConfirm:!!(user.role==='parent'&&visible&&head.id===visible.id&&visible.status==='submitted'&&!visible.confirmed_at),
      correcting:!!(user.role==='parent'&&head?.status==='draft'&&visible),
      canEdit:user.role!=='parent'&&['confirmed','completed'].includes(a.status)};
  }
  const digest=v=>hash(JSON.stringify({appointmentId:v.appointment_id,revision:v.revision,profile:JSON.parse(v.profile),date:v.service_date,
    ask:v.ask,look:v.look,touch:v.touch,inspect:v.inspect,doctor:v.doctor,authorId:v.author_id,authorName:v.author_name,source:v.source,sourceMediaId:v.source_media_id,submittedAt:v.submitted_at}));
  return async(req,res,url,user)=>{
    const path=url.pathname,match=/^\/api\/morning\/([\w-]+)(?:\/(save|submit|confirm|import))?$/.exec(path);
    if(req.method==='GET'&&path==='/api/morning'){
      requireUser(user);
      const rows=all(`SELECT a.id FROM appointments a WHERE ${user.role==='admin'?'1=1':user.role==='parent'?'a.user_id=?':'a.teacher_id=?'} AND EXISTS(SELECT 1 FROM morning_versions m WHERE m.appointment_id=a.id ${user.role==='parent'?"AND m.status='submitted'":''}) ORDER BY a.created_at DESC`,...(user.role==='admin'?[]:[user.id]));
      json(res,{records:rows.map(a=>{const r=read(a.id,user);const {signature,...v}=r.versions[0];return {...v,canConfirm:r.canConfirm,correcting:r.correcting};})});return true;
    }
    if(!match)return false;
    const [,id,action]=match;
    if(req.method==='GET'&&!action){json(res,read(id,user));return true;}
    check(req.method==='POST'&&action,405,'不支持此操作');
    const b=await body(req,500000);user=identify(req);requireUser(user);
    const a=appointment(id,user,action!=='confirm');
    if(action==='confirm')requireUser(user,['parent']);else requireUser(user,['teacher','admin']);
    if(action==='import')requireUser(user,['admin']);
    limiter('morning:'+user.id,120,3600000);
    const key=text(b.requestKey,'请求编号',80);check(/^[a-zA-Z0-9-]{16,80}$/.test(key),400,'请求编号不正确');
    const payloadHash=hash(JSON.stringify(b));
    let response;
    transaction(db,()=>{
      const prior=get('SELECT * FROM morning_requests WHERE user_id=? AND request_key=?',user.id,key);
      if(prior){check(prior.appointment_id===id&&prior.operation===action&&prior.payload_hash===payloadHash,409,'请求编号已用于不同内容');response=JSON.parse(prior.response);return;}
      let v=latest(id);const slot=get('SELECT * FROM slots WHERE id=?',a.slot_id),profile=JSON.parse(a.profile);
      if(action!=='confirm')check(['confirmed','completed'].includes(a.status),409,'仅已确认或已完成的预约可填写晨检');
      if(action==='save'){
        check((b.baseVersion??null)===(v?.id??null)&&(!v||b.lock===v.lock),409,'晨检内容已变化，请重新打开后编辑');
        const data={};for(const k of ['ask','look','touch','inspect'])data[k]=text(b[k]||'',{ask:'一问',look:'二看',touch:'三摸',inspect:'四查'}[k],2000,false);
        data.doctor=text(b.doctor||'','值班保健医生',100,false);
        if(v?.status==='draft'){
          run('UPDATE morning_versions SET ask=?,look=?,touch=?,inspect=?,doctor=?,author_id=?,author_name=?,updated_at=?,lock=lock+1 WHERE id=?',data.ask,data.look,data.touch,data.inspect,data.doctor,user.id,user.name,stamp(),v.id);
        }else{
          const now=stamp(),vid=randomUUID();
          run(`INSERT INTO morning_versions(id,appointment_id,revision,status,profile,service_date,ask,look,touch,inspect,doctor,author_id,author_name,source_media_id,source,created_at,updated_at)
            VALUES(?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?)`,vid,id,(v?.revision||0)+1,v?.profile||JSON.stringify({baby:profile.baby,gender:profile.gender,age:profile.age}),v?.service_date||slot.date,data.ask,data.look,data.touch,data.inspect,data.doctor,user.id,user.name,v?.source_media_id||null,v?.source||'daily',now,now);
        }
        v=latest(id);
      }else if(action==='import'){
        check(!v,409,'本次预约已有晨检，不可覆盖导入');
        check(b.profile&&b.profile.baby===profile.baby&&b.profile.gender===profile.gender&&String(b.profile.age)===String(profile.age)&&b.date===slot.date,400,'原表姓名、性别、月龄或日期与预约不匹配');
        check(slot.date<=chinaDate(),400,'不能导入未来日期晨检');
        const media=get('SELECT * FROM media WHERE id=?',String(b.sourceMediaId||''));
        check(media&&media.appointment_id===id&&media.uploader_id===user.id&&media.purpose==='morning'&&media.mime.startsWith('image/')&&!get('SELECT 1 FROM morning_versions WHERE source_media_id=?',media.id),400,'请选择本次预约的原表签名附件');
        const values=['ask','look','touch','inspect'].map(k=>text(b[k],{ask:'一问',look:'二看',touch:'三摸',inspect:'四查'}[k],2000));
        const now=stamp(),vid=randomUUID();
        run(`INSERT INTO morning_versions(id,appointment_id,revision,status,profile,service_date,ask,look,touch,inspect,doctor,author_id,author_name,source_media_id,source,created_at,updated_at,submitted_at)
          VALUES(?,?,1,'submitted',?,?,?,?,?,?,?,?,?,?,'import',?,?,?)`,vid,id,JSON.stringify({baby:profile.baby,gender:profile.gender,age:profile.age}),slot.date,...values,text(b.doctor||'','值班保健医生',100,false),user.id,user.name,media.id,now,now,now);
        v=latest(id);run('UPDATE morning_versions SET content_hash=? WHERE id=?',digest(v),v.id);
      }else{
        check(v&&b.versionId===v.id&&b.lock===v.lock,409,'晨检版本已变化，请重新阅读');
        if(action==='submit'){
          check(v.status==='draft',409,'该版本已提交');check(v.service_date<=chinaDate(),400,'不能提交未来日期晨检');
          for(const [k,label]of [['ask','一问'],['look','二看'],['touch','三摸'],['inspect','四查']])check(v[k].trim(),400,'请填写'+label);
          run("UPDATE morning_versions SET status='submitted',submitted_at=?,updated_at=?,lock=lock+1 WHERE id=?",stamp(),stamp(),v.id);
          v=latest(id);run('UPDATE morning_versions SET content_hash=? WHERE id=?',digest(v),v.id);
        }else if(action==='confirm'){
          check(v.status==='submitted'&&!v.confirmed_at,409,'此版本尚未提交或已确认');
          check(b.agreed===true,400,'请先阅读并确认完整晨检内容');const signature=signatureData(b.signature);
          run('UPDATE morning_versions SET parent_signature=?,confirmed_by=?,confirmed_at=?,lock=lock+1 WHERE id=?',signature,user.id,stamp(),v.id);
        }
      }
      response=read(id,user);
      run('INSERT INTO morning_requests(user_id,request_key,appointment_id,operation,payload_hash,version_id,response) VALUES(?,?,?,?,?,?,?)',user.id,key,id,action,payloadHash,v.id,JSON.stringify(response));
      audit(db,user.id,'morning.'+action,v.id);
    });
    json(res,response);return true;
  };
}
