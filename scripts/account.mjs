import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { openDatabase, transaction, audit, stamp } from '../server/db.mjs';
import { username, text, passwordHash } from '../server/security.mjs';

const {values}=parseArgs({options:{username:{type:'string'},name:{type:'string'},role:{type:'string',default:'admin'},reset:{type:'boolean',default:false}}});
async function readPassword(){
  if(!process.stdin.isTTY){let result='';for await(const c of process.stdin)result+=c;return result.replace(/\r?\n$/,'');}
  process.stdout.write('请输入密码（至少 12 位，输入不回显）：');
  process.stdin.setRawMode(true);process.stdin.resume();
  return await new Promise((resolve,reject)=>{
    let password='';
    const finish=()=>{process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',onData);process.stdout.write('\n');};
    const onData=chunk=>{for(const c of chunk.toString('utf8')){
      if(c==='\u0003'){finish();reject(new Error('已取消'));return;}
      if(c==='\r'||c==='\n'){finish();resolve(password);return;}
      if(c==='\u007f'||c==='\b')password=password.slice(0,-1);else password+=c;
    }};process.stdin.on('data',onData);
  });
}
let db;
try{
  const account=username(values.username);
  if(!['parent','teacher','admin'].includes(values.role))throw new Error('role 必须为 parent、teacher 或 admin');
  db=openDatabase(process.env.DATA_DIR||'./var');
  const old=db.prepare('SELECT * FROM users WHERE username=?').get(account);
  if(old&&!values.reset)throw new Error('账号已存在。如需重置密码，请使用 --reset（保留原角色）');
  if(!old&&values.reset)throw new Error('待重置的账号不存在');
  const name=old?.name||text(values.name,'姓名',30);
  const password=await passwordHash(await readPassword());
  transaction(db,()=>{
    if(old){db.prepare('UPDATE users SET password=?,active=1 WHERE id=?').run(password,old.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(old.id);audit(db,old.id,'password.reset.cli',old.id);}
    else{const id=randomUUID();db.prepare('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run(id,account,name,password,values.role,stamp());audit(db,id,'account.create.cli',id);}
  });
  console.log(`${old?'密码已重置，旧会话已撤销':'账号已创建'}：${account}`);
}catch(error){console.error(error.message);process.exitCode=1;}finally{db?.close();}
