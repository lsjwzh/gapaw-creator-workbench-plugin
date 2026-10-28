'use strict';
// 全新身份、合成 HTTPS 平台；不连接用户 Chrome 或复制登录态。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https'),net=require('node:net'),crypto=require('node:crypto');
const {execFile,spawnSync}=require('node:child_process');
const capture=(bin,args,env,input={})=>new Promise((resolve,reject)=>{const p=execFile(bin,args,{env,timeout:25000,maxBuffer:1048576},(err,out,stderr)=>{if(err)return reject(new Error(stderr||String(err)));try{resolve(JSON.parse(out));}catch(e){reject(e);}});p.stdin.end(JSON.stringify(input));});
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('公开命令在真实隔离 Chrome 中观察身份响应、保留会话、阻止跨实例读取', {timeout:120000,skip:!process.env.CHROME_PUBLIC_TEST_BINARY},async t=>{
 const root=fs.mkdtempSync('/tmp/cbr-public-');fs.chmodSync(root,0o700);
 const env={...process.env,CHROME_READ_TEST_ROOT:root},bin=process.env.CHROME_PUBLIC_TEST_BINARY;
 const raw=(c,i)=>capture(bin,[c],env,i),run=async(c,i)=>{const r=await raw(c,i);assert.equal(r.ok,true,r.error);return r.data;};
 const ids=[],processes=[],sockets=new Set(),servers=[];
 t.after(async()=>{for(const id of ids)await raw('stop',{id}).catch(()=>{});for(const p of processes){for(const pid of [p.pid,p.supervisorPid])try{process.kill(pid,0);process.kill(pid,'SIGTERM');}catch{}}for(const s of sockets)s.destroy();await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));fs.rmSync(root,{recursive:true,force:true});});
 assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',root+'/key','-out',root+'/cert','-days','1','-subj','/CN=kalodata.com'],{stdio:'ignore'}).status,0);
 const cookies=[];let signedOut=false,slowLoads=0;
 const fixture=https.createServer({key:fs.readFileSync(root+'/key'),cert:fs.readFileSync(root+'/cert')},(req,res)=>{
  if(req.url==='/slow' && ++slowLoads>1){setTimeout(()=>res.end('<p>延迟页面</p>'),7000);return;}
  if(req.url==='/api/v1/affiliate/account/info_v2'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data:{account:{account_id:'operator'},shop:{shop_id:'synthetic-shop',shop_name:'合成店铺',region:'US'},token:'DO_NOT_RETURN_SECRET'}}));return;}
  if(req.url==='/user/queryProfile'){cookies.push(req.headers.cookie||'');res.setHeader('Content-Type','application/json');res.statusCode=signedOut?401:200;res.end(JSON.stringify({success:!signedOut,data:{username:(req.headers.cookie||'').includes('beta')?'beta':'alpha',secId:'synthetic-id',token:'DO_NOT_RETURN_SECRET'}}));return;}
  if(req.url==='/login'){res.end('<p>请登录</p>');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');if(req.url.startsWith('/alpha')||req.url.startsWith('/beta'))res.setHeader('Set-Cookie','fixture_identity='+req.url.split('?')[0].slice(1)+'; Secure; SameSite=Lax; Path=/');
  const api=req.headers.host==='affiliate.tiktok.com'?'/api/v1/affiliate/account/info_v2':'/user/queryProfile';
  res.end('<title>合成平台</title><p>合成业务正文</p><form><input value="INPUT_SECRET"><p>FORM_SECRET</p></form><p hidden>HIDDEN_SECRET</p><script>fetch('+JSON.stringify(api)+',{method:"POST",headers:{country:"US"}}).then(r=>r.json()).then(d=>{document.body.append(document.createTextNode(d.success?"已加载":"待登录"));});</script>');
 });
 fixture.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});});await listen(fixture);servers.push(fixture);
 const proxy=http.createServer((q,r)=>{r.writeHead(502);r.end();});proxy.on('connect',(q,client,head)=>{if(!['kalodata.com:443','www.kalodata.com:443','affiliate.tiktok.com:443'].includes(q.url)){client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}const upstream=net.connect(fixture.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});for(const s of [client,upstream]){sockets.add(s);s.on('close',()=>sockets.delete(s));}client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());});await listen(proxy);servers.push(proxy);
 proxy.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
 const chrome=process.env.CHROME_TEST_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
 fs.writeFileSync(root+'/chrome','#!/bin/sh\nexec '+quote(chrome)+' --headless=new --use-mock-keychain --ignore-certificate-errors --disable-background-networking --disable-component-update --disable-sync "$@" 2>>'+quote(root+'/chrome.log')+'\n',{mode:0o700});
 const origins=['https://kalodata.com','https://www.kalodata.com','https://affiliate.tiktok.com'];
 const profiles=[];
 for(const name of ['alpha','beta']){const {profile}=await run('save',{name,chromePath:root+'/chrome',proxy:{scheme:'http',host:'127.0.0.1',port:proxy.address().port}});ids.push(profile.id);profiles.push(profile);processes.push(await run('launch',{id:profile.id,url:'https://kalodata.com/'+name,automaticFingerprint:true,checkProxy:false}));}
 const read=(p,action,extra={})=>run('browser-read',{protocol:'multicc-browser-read-v1',requestId:crypto.randomUUID(),profileId:p.id,sourceRevision:{profileCreatedAt:p.createdAt,profileUpdatedAt:p.updatedAt,subscription:null,confidence:'public_metadata'},action,origins,...extra});
 const [alpha,beta]=profiles;const a=await read(alpha,'status'),b=await read(beta,'status');assert.notEqual(a.instanceId,b.instanceId);
 await pause(700);const pages=await read(alpha,'pages',{expectedInstanceId:a.instanceId});assert.equal(pages.pages.length,1);const target=pages.pages[0].targetId;
 const spec={expectedInstanceId:a.instanceId,targetId:target,observations:[{id:'identity',path:'/user/queryProfile',fields:['/success','/data/username','/data/secId']}]};
 const inspected=await read(alpha,'inspect-page',spec);assert.equal(inspected.observations.identity.fields['/data/username'],'alpha');assert.equal(inspected.observations.identity.metadata.country,'US');
 assert.match(inspected.page.text,/合成业务正文/);assert.doesNotMatch(JSON.stringify(inspected),/SECRET|FORM_SECRET|HIDDEN_SECRET/);assert.equal((await read(alpha,'pages')).pages.length,1,'临时页面必须关闭');
 await assert.rejects(read(beta,'read-page',{targetId:target,expectedInstanceId:a.instanceId}));
 await assert.rejects(read(alpha,'inspect-page',{...spec,observations:[{id:'bad',path:'/user/queryProfile',fields:['/data/token']}]}));
 // 达人 Rust -> 宿主公开命令 -> 浏览器 Rust -> 真实 Chrome，全链只使用新建合成资料。
 if(process.env.GAPAW_TEST_BINARY){
  const host=http.createServer(async(q,r)=>{try{let body='';for await(const c of q)body+=c;let out;
   if(q.url==='/api/plugins')out={plugins:[{id:'chrome-proxy-launcher',version:'1.6.3+page-read.1',commands:['list','browser-read-capabilities','browser-read'],engine:{available:true}}]};
   else {const i=JSON.parse(body);out=await run(i.command,i.input);}
   r.setHeader('Content-Type','application/json');r.end(JSON.stringify(out));
  }catch(e){r.statusCode=500;r.end(JSON.stringify({error:String(e)}));}});await listen(host);servers.push(host);
  const ce={...process.env,GAPAW_CREATOR_DATA_DIR:root+'/creator-data',GAPAW_BROWSER_HOST_URL:'http://127.0.0.1:'+host.address().port};delete ce.GAPAW_CHROME_PLUGIN_DIR;
  const creator=async(c,i={})=>{const r=await capture(process.env.GAPAW_TEST_BINARY,[c],ce,i);assert.equal(r.ok,true,r.error);return r.data;};
  const inventory=await creator('browser-status');const selected=inventory.environments.find(p=>p.id===alpha.id);
  await creator('bind-browser',{profileId:alpha.id,expectedRevision:0,expectedSourceRevision:selected.sourceRevision});
  const bound=await creator('browser-status');await creator('selection-open-platform',{platform:'shop',expectedBinding:bound.binding});await pause(400);
  const checked=await creator('selection-check-environment',{expectedBinding:bound.binding});assert.equal(checked.ready,true,JSON.stringify(checked.confirmation));assert.equal(checked.confirmation.kalodata.account,'alpha');assert.equal(checked.confirmation.shop.accountId,'synthetic-shop');assert.equal(checked.fieldsVerified,false);
  assert.equal((await read(alpha,'pages')).pages.length,2,'联合检查保留原平台页并关闭两张临时页');
 }
 signedOut=true;const expired=await read(alpha,'inspect-page',spec);assert.equal(expired.observations.identity.httpStatus,401);assert.equal(expired.observations.identity.fields['/success'],false);
 // 慢页面超出观察预算后，仍可查询状态；临时页关闭、原页保留。
 const slow=await read(beta,'open-page',{expectedInstanceId:b.instanceId,url:'https://kalodata.com/slow'});
 await pause(700);
 await assert.rejects(read(beta,'inspect-page',{...spec,targetId:slow.targetId,expectedInstanceId:b.instanceId}));
 assert.equal((await read(beta,'status')).state,'ready');
 assert.equal((await read(beta,'pages')).pages.length,2,'超时后的临时页必须关闭');
 await run('stop',{id:alpha.id});processes.push(await run('launch',{id:alpha.id,url:'https://kalodata.com/again',automaticFingerprint:true,checkProxy:false}));
 const restarted=await read(alpha,'status');assert.notEqual(restarted.instanceId,a.instanceId);await assert.rejects(read(alpha,'pages',{expectedInstanceId:a.instanceId}));
 assert.ok(cookies.some(c=>c.includes('fixture_identity=alpha')));assert.ok(!cookies.some(c=>c.includes('alpha')&&c.includes('beta')));
});
