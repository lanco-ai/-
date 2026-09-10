import { createApp } from './app.mjs';
const [major,minor]=process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 14) throw new Error('请使用 Node.js 24 LTS（24.14 或更新的 24.x）');
const {server}=createApp();
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000);
server.listen(port,host,()=>console.log(`近邻托育服务已启动：http://${host}:${port}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),10000).unref();
});
