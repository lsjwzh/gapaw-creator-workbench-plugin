'use strict';
// 使用专用测试根目录和全新 profile；测试代理仅把允许域名映射到本地合成页面。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const https=require('node:https');
const net=require('node:net');
const {execFile,spawnSync}=require('node:child_process');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

test('隔离 Chrome 经生产私有管道和 Unix socket 读取合成平台正文', {skip:!process.env.CHROME_TEST_BIN||!process.env.PLUGIN_TEST_MANIFEST,timeout:60000}, async t=>{
  const testRoot=fs.mkdtempSync('/tmp/cbr-');
  const sockets=new Set();
  t.after(()=>{for(const socket of sockets)socket.destroy();fs.rmSync(testRoot,{recursive:true,force:true});});
  const certificate=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(testRoot,'fixture.key'),'-out',path.join(testRoot,'fixture.crt'),'-days','1','-subj','/CN=kalodata.com'],{stdio:'ignore'});
  assert.equal(certificate.status,0,'生成一次性测试证书');
  const html=`<!doctype html><meta charset="utf-8"><title>合成页面</title><p>公开正文</p>
    <form><p>表单秘密</p><input value="密码秘密"><textarea>输入秘密</textarea></form>
    <p style="display:none">隐藏秘密</p><div style="opacity:0"><p>透明秘密</p></div>
    <div style="height:0;overflow:hidden"><p>裁切秘密</p></div>
    <div style="clip-path:inset(100%)">路径裁切秘密</div>
    <div contenteditable>编辑秘密</div><iframe src="https://evil.invalid/frame"></iframe>
    <script>void '脚本秘密'</script>`;
  const fixture=https.createServer({key:fs.readFileSync(path.join(testRoot,'fixture.key')),cert:fs.readFileSync(path.join(testRoot,'fixture.crt'))},(req,res)=>{
    res.setHeader('content-type','text/html; charset=utf-8');res.end(html);
  });
  fixture.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
  await listen(fixture); t.after(()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();fixture.close(resolve);setTimeout(resolve,1000).unref();}));
  const proxy=http.createServer((_,res)=>{res.writeHead(502);res.end();});
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
  proxy.on('connect',(request,client,head)=>{
    if(request.url!=='kalodata.com:443'){client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
    const upstream=net.connect(fixture.address().port,'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
    });
    sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
    client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  });
  await listen(proxy); t.after(()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();proxy.close(resolve);setTimeout(resolve,1000).unref();}));
  const output=await new Promise((resolve,reject)=>{
    execFile('cargo',['test','--locked','--manifest-path',process.env.PLUGIN_TEST_MANIFEST,'read_bridge_headless_pipe','--','--ignored','--nocapture'],
      {env:{...process.env,CHROME_READ_TEST_ROOT:testRoot,CHROME_READ_FIXTURE_PROXY:'http://127.0.0.1:'+proxy.address().port},timeout:45000},
      (error,stdout,stderr)=>error?reject(new Error(stdout+'\n'+stderr)):resolve(stdout));
  });
  assert.match(output,/1 passed/);
});
