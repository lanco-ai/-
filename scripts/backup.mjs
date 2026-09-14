import { backup, DatabaseSync } from 'node:sqlite';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { openDatabase } from '../server/db.mjs';
const source=resolve(process.env.DATA_DIR||'./var');
const base=resolve(process.argv[2]||'./backups');
if(base===source||base.startsWith(source+'/')||base.startsWith(source+'\\'))throw new Error('备份目录不能在数据目录内');
const target=join(base,new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(target,{recursive:true,mode:0o700});
const db=openDatabase(source);
try{
  // Online SQLite backup captures a consistent snapshot, including WAL contents.
  await backup(db,join(target,'jinlin.sqlite'));
  // Copy only complete media named in the database snapshot, not in-flight uploads.
  const snapshot=new DatabaseSync(join(target,'jinlin.sqlite'),{readOnly:true});
  try{
    if(snapshot.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('备份数据库校验失败');
    await mkdir(join(target,'uploads'),{mode:0o700});
    for(const row of snapshot.prepare('SELECT filename FROM media UNION ALL SELECT filename FROM consultation_media').all()){
      if(!/^[a-f0-9-]+\.(png|jpg|webp|mp4|webm)$/.test(row.filename))throw new Error('媒体文件名异常');
      await copyFile(join(source,'uploads',row.filename),join(target,'uploads',row.filename));
    }
  }finally{snapshot.close();}
  await writeFile(join(target,'backup.json'),JSON.stringify({createdAt:new Date().toISOString(),schema:1}),{mode:0o600});
  console.log('备份完成：'+target);
}finally{db.close();}
