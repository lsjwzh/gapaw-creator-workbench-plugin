'use strict';
const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {execFile,execFileSync}=require('node:child_process');
const binary=process.env.GAPAW_TEST_BINARY||'/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench';
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'selection-chat-')),workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(),'.gapaw-selection-test-')));
 const config={profiles:[{id:'alpha',name:'隔离测试实例',createdAt:1,updatedAt:2,running:true}]};
 const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const {command,input={}}=body?JSON.parse(body):{};res.setHeader('Content-Type','application/json');let result;
 if(req.url==='/api/plugins')result={plugins:[{id:'chrome-proxy-launcher',version:'1.6.3',commands:['list','browser-read-capabilities','browser-read'],engine:{available:true}}]};
 else if(command==='list')result={profiles:config.profiles,subscriptions:[]};
 else if(command==='browser-read-capabilities')result={protocol:'multicc-browser-read-v1',actions:['status','pages','inspect-page','open-page']};
 else {result={...input,available:true,instanceId:config.instanceId||'11111111-1111-4111-8111-111111111111'};
 if(input.action==='pages')result.pages=[{targetId:'kalo',title:'合成分析平台',url:'https://www.kalodata.com/creator'},{targetId:'shop',title:'合成店铺',url:config.shopUrl||'https://affiliate.tiktok.com/connection'}].filter(p=>input.origins.includes(new URL(p.url).origin));
 if(input.action==='inspect-page'&&input.targetId==='shop'&&config.shopReadFailed){res.writeHead(400);res.end(JSON.stringify({error:'合成页面读取失败'}));return;}
 if(input.action==='inspect-page')result={...result,page:{targetId:input.targetId,url:input.targetId==='kalo'?'https://www.kalodata.com/creator':config.shopUrl||'https://affiliate.tiktok.com/connection',text:config.challenge?'Security verification':'合成业务页',truncated:false},observations:{identity:{httpStatus:config.signedOut?401:200,bodyState:'json',metadata:{country:'US'},fields:input.targetId==='kalo'?{'/success':true,'/data/username':'test-analysis','/data/secId':config.kaloId||'test-analysis'}:{'/code':0,'/data/account/account_id':'operator','/data/shop/shop_id':'test-shop','/data/shop/shop_name':'test-shop','/data/shop/region':config.market||'US'}}}};
 }res.end(JSON.stringify(result));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env={...process.env,GAPAW_CREATOR_DATA_DIR:root,GAPAW_BROWSER_HOST_URL:'http://127.0.0.1:'+server.address().port};delete env.MULTICC_PLUGIN_WORKSPACE;delete env.MULTICC_PLUGIN_DIR_ID;
 const raw=(command,input={})=>new Promise((resolve,reject)=>{const p=execFile(binary,[command],{env,timeout:12000,encoding:'utf8'},(error,stdout,stderr)=>{if(error)return reject(error);assert.equal(stderr,'');resolve(JSON.parse(stdout));});p.stdin.end(JSON.stringify(input));});
 const run=async(c,p)=>{const r=await raw(c,p);assert.equal(r.ok,true,r.error);return r.data;};
 const sql=(query,db='workbench.sqlite')=>JSON.parse(execFileSync('python3',['-c',"import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute(sys.argv[2]); print(json.dumps(r.fetchall())); c.commit()",path.join(root,db),query],{encoding:'utf8'}));
 const setup=async()=>{await run('local-workbench-init',{confirmed:true});await run('configure',{workspace:{dirId:'synthetic-dir',path:workspace}});const b=await run('browser-status');await run('bind-browser',{profileId:'alpha',expectedRevision:0,expectedSourceRevision:b.environments[0].sourceRevision});const latest=await run('browser-status');return run('selection-check-environment',{expectedBinding:latest.binding});};
 const create=async(requestId='r1')=>{const op=(await run('selection-create',{requestId,prompt:'寻找宠物用品达人',runtime:{cli:'codex-exp',provider:'fixture',model:'fixture-model'}})).operation;await run('record-dispatch',{operationId:op.id,stage:'created',response:{taskId:'tsk_'+requestId,sessionId:'session_'+requestId,shellId:'shell_'+requestId,url:'/air?task=tsk_'+requestId}});await run('record-dispatch',{operationId:op.id,stage:'sent',response:{taskId:'tsk_'+requestId,receiptId:'receipt_'+requestId}});return (await run('selection-status',{operationId:op.id})).operation;};
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});fs.rmSync(workspace,{recursive:true,force:true});});return{root,env,config,raw,run,setup,create,sql};
}
function candidate(key='a',accountId='1234567') {return{key,identity:{platform:'tiktok',accountId,handle:'fixture_'+key,url:'https://www.tiktok.com/@fixture_'+key,sourceId:'s1'},content:{country:'US',language:null,categories:['宠物'],fit:'待核验',reason:'合成内容依据'},metrics:[{name:'followers',value:null,unit:'人',sourceId:'s1',period:null}],contacts:[],sources:[{id:'s1',platform:'tiktok',url:'https://www.tiktok.com/@fixture_'+key,capturedAt:'2026-10-28T00:00:00Z',note:'合成来源，未访问平台'}],missingFields:['粉丝数未知']};}
function submission(op,extras={}){return{operationId:op.id,taskId:op.task.taskId,turnId:op.dispatch.message.clientMsgId,resultId:'result_'+op.id,expectedRevision:0,parentRevision:0,list:{schemaVersion:1,criteria:'宠物用品适配，合成测试',candidates:[candidate(),candidate('b',null)]},...extras};}

test('跨境联盟页面参与自动检查；读取失败不能误报页面缺失或已登录',async t=>{
 const f=await fixture(t);f.config.shopUrl='https://affiliate.tiktokshopglobalselling.com/affiliate/sample/sample-request';
 const ready=await f.setup();assert.equal(ready.ready,true);assert.equal(ready.confirmation.shop.state,'signed_in');assert.equal(ready.confirmation.shop.market,'US');
 f.config.shopReadFailed=true;
 const failed=await f.run('selection-check-environment');assert.equal(failed.ready,false);assert.equal(failed.confirmation.shop.state,'read_failed');assert.equal(failed.confirmation.shop.loginVerified,false);assert.equal(failed.confirmation.shop.pages.length,1);
});

test('空工作区只读；环境不就绪不能创建任务，自动探测替代人工确认',async t=>{
 const f=await fixture(t);assert.deepEqual((await f.run('selection-status')).operations,[]);assert.equal(fs.existsSync(path.join(f.root,'state.sqlite')),false);
 assert.equal((await f.raw('selection-create',{requestId:'r',prompt:'test',runtime:{cli:'codex'}})).ok,false);
 const e=await f.setup();assert.equal(e.ready,true);assert.equal(e.automaticLoginCheck,true);assert.equal(e.confirmation.method,'automatic');assert.equal(e.fieldsVerified,false);assert.equal((await f.raw('selection-confirm-environment',{confirmed:true})).ok,false);
 f.config.profiles[0].updatedAt++;assert.equal((await f.run('selection-environment')).ready,false);
});

test('同一请求恢复原任务；固定账号与工作台来源；名单与轮次有完整回写契约',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();const same=await f.create();assert.equal(same.id,op.id);
 const contract=await f.run('selection-contract',{operationId:op.id,turnId:op.dispatch.message.clientMsgId});assert.equal(contract.taskId,op.task.taskId);assert.equal(contract.expectedRevision,0);assert.equal(contract.browser.profile.id,'alpha');assert.equal(contract.environment.shop.account,'test-shop');assert.equal(contract.submissionTemplate.taskId,op.task.taskId);assert.equal(contract.submissionTemplate.expectedRevision,0);
 assert.ok(op.dispatch.message.text.includes('selection-submit-list'));assert.ok(op.dispatch.message.text.includes('不发送邮件'));
 assert.equal((await f.raw('selection-create',{requestId:'r1',prompt:'改变内容',runtime:{cli:'codex'}})).ok,false);
 const payload=submission(op);await f.run('selection-submit-list',payload);const d=await f.run('selection-status',{operationId:op.id});assert.equal(d.record.list.candidates[0].metrics[0].value,null);assert.equal(d.versions[0].revision,1);
 assert.equal((await f.run('selection-submit-list',payload)).replayed,true);
 assert.equal((await f.raw('selection-submit-list',{...payload,list:{...payload.list,criteria:'changed'}})).ok,false);
});

test('连续对话固定任务，基于旧版本分支，迟到结果不能覆盖更新名单',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();await f.run('selection-submit-list',submission(op));
 const input={operationId:op.id,requestId:'turn_two',prompt:'收窄条件',parentRevision:1,runtime:{cli:'codex-exp',provider:'fixture'}};
 const tr=(await f.run('selection-prepare-turn',input)).turn;assert.equal(tr.operationId,op.id);assert.equal((await f.run('selection-prepare-turn',input)).turn.id,tr.id);
 assert.equal((await f.raw('selection-prepare-turn',{...input,requestId:'turn_blocked'})).ok,false);
 await f.run('selection-record-turn',{turnId:tr.id,response:{taskId:op.task.taskId,receiptId:'receipt_two'}});
 await f.run('selection-submit-list',submission(op,{turnId:tr.id,resultId:'r2',expectedRevision:1,parentRevision:1}));
 const third=(await f.run('selection-prepare-turn',{...input,requestId:'turn_three'})).turn;
 await f.run('selection-record-turn',{turnId:third.id,response:{taskId:op.task.taskId,receiptId:'receipt_three'}});
 assert.equal((await f.raw('selection-submit-list',submission(op,{turnId:third.id,resultId:'late',expectedRevision:1,parentRevision:1}))).ok,false);
 await f.run('selection-submit-list',submission(op,{turnId:third.id,resultId:'branch',expectedRevision:2,parentRevision:1}));
 const history=await f.run('selection-status',{operationId:op.id,revision:1});assert.equal(history.versions.length,3);assert.equal(history.record.revision,1);assert.equal(history.versions[0].parentRevision,1);
 const other=await f.create('other');assert.equal((await f.raw('selection-submit-list',submission(other,{turnId:tr.id}))).ok,false);
});

test('字段、身份、来源与时间窗口严格校验；失败不保存版本',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();const payload=submission(op);
 for(const mutate of [c=>c.identity.accountId='nickname',c=>c.metrics[0].value='-1',c=>c.metrics[0].sourceId='missing',c=>c.identity.url='https://evil.invalid/@fixture',c=>c.content.extra='unknown',c=>c.metrics[0].name='gmv',c=>c.sources[0].url+='?token=private']){
  const p=structuredClone(payload);mutate(p.list.candidates[0]);assert.equal((await f.raw('selection-submit-list',p)).ok,false);
 }
 assert.equal((await f.run('selection-status',{operationId:op.id})).versions.length,0);
});

test('采用预览只读，部分采用、回执恢复、不覆盖合作事实与旧名单',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();await f.run('selection-submit-list',submission(op));
 const input={operationId:op.id,revision:1,keys:['a','b']};const preview=await f.run('selection-preview-adoption',input);
 assert.deepEqual(f.sql('SELECT count(*) FROM creators'),[[0]]);assert.equal(preview.plan.items[0].action,'create');assert.equal(preview.plan.items[1].action,'blocked');
 const p={...input,requestId:'adopt_one',confirmed:true,expectedPlan:preview};const r=await f.run('selection-adopt',p);assert.equal(r.receipt.accepted.length,1);assert.equal(r.receipt.blocked.length,1);assert.equal((await f.run('selection-adopt',p)).replayed,true);
 assert.deepEqual((await f.run('selection-adoption-status',{requestId:'adopt_one'})).receipt,r.receipt);
 assert.deepEqual(f.sql('SELECT count(*) FROM creators'),[[1]]);assert.deepEqual(f.sql('SELECT count(*) FROM drafts'),[[5]]);assert.deepEqual(f.sql('SELECT count(*) FROM events'),[[0]]);
 assert.equal(JSON.parse(f.sql('SELECT settings FROM creators')[0][0]).fee,null);assert.equal((await f.run('workbench-home')).items.length,1);const cid=r.receipt.accepted[0].creatorId;assert.equal((await f.run('workbench-creator',{creatorId:cid})).profile.selectionSnapshot.revision,1);
 const repeated=await f.run('selection-preview-adoption',input);assert.equal(repeated.plan.items[0].action,'unchanged');
 const skipped=await f.run('selection-adopt',{...p,requestId:'skip',expectedPlan:repeated});assert.equal(skipped.receipt.accepted.length,0);assert.equal(skipped.receipt.skipped.length,1);assert.deepEqual(f.sql('SELECT count(*) FROM audit'),[[1]]);
 const turn=(await f.run('selection-prepare-turn',{operationId:op.id,requestId:'next_version',prompt:'补充资料',parentRevision:1,runtime:{cli:'codex'}})).turn;
 await f.run('selection-record-turn',{turnId:turn.id,response:{taskId:op.task.taskId,receiptId:'next_receipt'}});
 await f.run('selection-submit-list',submission(op,{turnId:turn.id,resultId:'next_result',expectedRevision:1,parentRevision:1}));
 input.revision=2;p.revision=2;
 const next=await f.run('selection-preview-adoption',input);assert.equal(next.plan.items[0].action,'update');
 f.sql("UPDATE creators SET revision=revision+1,settings=json_set(settings,'$.owner','人工负责人')");
 assert.equal((await f.raw('selection-adopt',{...p,requestId:'stale',expectedPlan:next})).ok,false);
 const fresh=await f.run('selection-preview-adoption',input);await f.run('selection-adopt',{...p,requestId:'fresh',expectedPlan:fresh});
 assert.equal(JSON.parse(f.sql('SELECT settings FROM creators')[0][0]).owner,'人工负责人');
 const saved=await f.run('selection-status',{operationId:op.id});assert.equal(saved.versions.length,2);assert.equal(saved.adoptions.length,3);
});

test('已有同名但身份无可靠对应时禁止合并；来源更换、确认过期阻止继续',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();await f.run('selection-submit-list',submission(op));
 f.sql(`INSERT INTO creators(id,handle,profile,settings,revision) VALUES('legacy','fixture_a','{}','{}',0)`);
 const p=await f.run('selection-preview-adoption',{operationId:op.id,revision:1,keys:['a']});assert.equal(p.plan.items[0].action,'blocked');
 f.sql("UPDATE settings SET value=json_set(value,'$.checkedAt','2000-01-01T00:00:00Z') WHERE key='selection_readiness'",'state.sqlite');
 assert.equal((await f.run('selection-environment')).ready,false);
 f.config.signedOut=true;
 assert.equal((await f.raw('selection-prepare-turn',{operationId:op.id,requestId:'expired',prompt:'继续',parentRevision:1,runtime:{cli:'codex'}})).ok,false);
 f.sql("UPDATE meta SET value='other-source' WHERE key='gapaw_local_business_id'");
 assert.equal((await f.raw('selection-preview-adoption',{operationId:op.id,revision:1,keys:['a']})).ok,false);
});

test('等待回答与执行中补充固定原轮次；人工确认可主动失效',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();
 for(const intent of ['answer','steer']) {
  const input={operationId:op.id,requestId:'control_'+intent,prompt:'继续按原条件',parentRevision:0,runtime:{cli:'codex'},control:{intent,turnId:'host_turn',...(intent==='answer'?{requestId:'question'}:{})}};
  const {turn}=await f.run('selection-prepare-turn',input);assert.equal(turn.message.taskId,op.task.taskId);assert.equal(turn.message.turnId,'host_turn');assert.equal(turn.message.intent,intent);if(intent==='answer')assert.equal(turn.message.requestId,'question');
  await f.run('selection-record-turn',{turnId:turn.id,response:{taskId:op.task.taskId,receiptId:'receipt_'+intent}});
 }
 const e=await f.run('selection-environment');assert.equal((await f.raw('selection-clear-environment',{confirmed:true,expectedProfile:{id:'other'}})).ok,false);
 await f.run('selection-clear-environment',{confirmed:true,expectedProfile:e.confirmation.profile});assert.equal((await f.run('selection-environment')).ready,false);
 f.config.signedOut=true;
 assert.equal((await f.raw('selection-prepare-turn',{operationId:op.id,requestId:'after_clear',prompt:'继续',parentRevision:0,runtime:{cli:'codex'}})).ok,false);
});

test('编号与昵称匹配不同档案时不得选择任意一条覆盖',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();await f.run('selection-submit-list',submission(op));
 const input={operationId:op.id,revision:1,keys:['a']};const expectedPlan=await f.run('selection-preview-adoption',input);await f.run('selection-adopt',{...input,expectedPlan,requestId:'first_adopt',confirmed:true});
 f.sql("UPDATE creators SET handle='old_handle'");
 f.sql("INSERT INTO creators(id,handle,profile,settings,revision) VALUES('another','fixture_a','{}','{}',0)");
 const plan=await f.run('selection-preview-adoption',input);assert.equal(plan.plan.items[0].action,'blocked');assert.match(plan.plan.items[0].reason,/不同档案/);
 assert.equal((await f.raw('selection-adopt',{...input,expectedPlan:plan,requestId:'conflict',confirmed:true})).ok,false);assert.deepEqual(f.sql('SELECT count(*) FROM audit'),[[1]]);
});

 test('验证码、市场变化、浏览器重启与账户切换不会沿用旧检查',async t=>{
 const f=await fixture(t);await f.setup();const op=await f.create();
 f.config.instanceId='22222222-2222-4222-8222-222222222222';assert.equal((await f.run('selection-environment')).ready,false);
 f.config.challenge=true;let e=await f.run('selection-check-environment');assert.equal(e.ready,false);assert.equal(e.confirmation.kalodata.state,'challenge');
 f.config.challenge=false;f.config.market='GB';e=await f.run('selection-check-environment');assert.equal(e.ready,false);
 f.config.market='US';f.config.kaloId='different-user';e=await f.run('selection-check-environment',{operationId:op.id});assert.equal(e.sameAccounts,false);assert.equal(e.ready,false);
 });
