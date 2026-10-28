/* 工作台只管理操作、名单及输入；执行与对话历史仍来自 MultiCC。 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const client = window.GapawWorkbenchApp.createClient(fetch.bind(window));
  const dispatcher = window.GapawWorkbenchApp.createDispatcher(client);
  const catalogAPI = window.MultiCCProviderCatalog;
  const prefix = 'gapaw:selection:v1:';
  const state = { op:null, data:null, env:null, config:null, status:null, record:null, view:0, base:0, selected:new Set(), busy:false, loading:false, versionLoading:false, versionGeneration:0, generation:0, history:[], hasMore:false, execution:null, readOnly:false, runtime:null, polling:false, adoption:null };
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const canonical = v => JSON.stringify(v, function(k,x){return x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((a,k)=>(a[k]=x[k],a),{}) : x;});
  const id = () => 'selreq_' + crypto.randomUUID().replaceAll('-','');
  const storage = {get(k){try{return JSON.parse(localStorage.getItem(prefix+k));}catch{return null;}},set(k,v){try{if(v===null)localStorage.removeItem(prefix+k);else localStorage.setItem(prefix+k,JSON.stringify(v));}catch{throw new Error('浏览器无法保存恢复信息，请检查存储设置后重试。');}}};
  const el = (tag,text,cls) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const draftKey=()=> 'draft:'+(state.op?.id||'new');
  function notice(s,error=false){$('notice-text').textContent=s;$('notice').className='notice show'+(error?' error':'');}
  function toast(s){$('toast').textContent=s;$('toast').className='show';setTimeout(()=>$('toast').className='',3500);}
  function modal(title,body,actions=[]){$('dialog-title').textContent=title;$('dialog-body').innerHTML=body;$('dialog-error').hidden=true;$('dialog-foot').replaceChildren();for(const [label,fn,primary] of actions){const b=el('button',label,primary?'primary':'');b.onclick=async()=>{if(b.disabled)return;b.disabled=true;try{await fn();}catch(e){$('dialog-error').textContent=e.message;$('dialog-error').hidden=false;}finally{b.disabled=false;}};$('dialog-foot').append(b);}if(!$('dialog').open)$('dialog').showModal();}
  $('close-dialog').onclick=()=>$('dialog').close();
  const close=()=>$('dialog').close();
  function setMobile(v){$('chat-panel').classList.toggle('mobile-hide',v!=='chat');$('list-panel').classList.toggle('mobile-hide',v!=='list');$('mobile-chat').classList.toggle('active',v==='chat');$('mobile-list').classList.toggle('active',v==='list');}
  $('mobile-chat').onclick=()=>setMobile('chat');$('mobile-list').onclick=()=>setMobile('list');
  [['selection','选人入库'],['verification','资料核验'],['cooperation','合作准备'],['drafts','专属文案'],['outreach','触达执行'],['messages','往来消息'],['reply','谈判回复'],['followup','跟进待办'],['fulfilment','合作履约'],['review','运营复盘']].forEach(([key,title],i)=>{const a=el('a',undefined,'nav-item'+(!i?' active':''));a.href=i?'./index.html#module='+key:'./selection.html';a.append(el('span',String(i+1).padStart(2,'0')),el('span',title));$('navigation').append(a);});
  function controls(){
    const ready=!!state.env?.ready&&!!state.config&&!!state.status?.workspace?.valid;
    const pending=storage.get('pending:'+(state.op?.id||'new'));
    const busy=state.busy||state.loading||state.execution?.busy===true;
    $('send').disabled=state.busy||state.loading||state.readOnly||!ready||!!pending;
    $('send').textContent=state.busy?'正在投递…':state.execution?.pending&&!state.execution.pending.resolved?'回答当前问题 ↑':state.execution?.busy?'补充到当前任务 ↑':ready?'发送 ↑':'先完成配置';
    $('runtime').disabled=busy||state.readOnly||!!pending;$('new-chat').disabled=state.busy||state.loading;$('operation-picker').disabled=state.busy||state.loading;
    $('retry').hidden=!pending&&(!state.op||state.op.status==='accepted')&&!state.data?.turns?.some(t=>t.status==='prepared'&&!t.id.endsWith('_first'));
    if(state.op&&state.op.status!=='accepted')$('retry').hidden=false;
    $('retry').disabled=state.busy||state.loading;for(const key of ['refresh','browser-pill','kalo-pill','shop-pill','workspace-pill'])$(key).disabled=state.busy||state.loading;
    $('continue-version').disabled=!state.record||state.busy||state.loading||state.versionLoading;
    $('adopt').disabled=!state.selected.size||state.busy||state.loading||state.versionLoading;
    $('runtime-label').textContent=state.config?[state.config.cli,state.config.providerName||state.config.provider,state.config.model].filter(Boolean).join(' · '):'选择执行配置';
    $('workspace-label').textContent=state.status?.workspace?.valid?'运营目录已就绪':'选择运营目录';
    const b=state.env?.browser;
    $('browser-label').textContent=b?.binding?.profile?.name||'选择浏览器';
    $('browser-dot').className='dot'+(b?.bindingState==='bound'?'':' amber');
    for(const [key,label,source]of [['kalo','Kalodata','kalodata'],['shop','店铺','shop']]) {
      const check=state.env?.sameProfile?state.env?.confirmation?.[source]:null;
      const fresh=state.env?.fresh&&state.env?.sameInstance;
      const names={signed_in:'已登录',signed_out:'待登录',challenge:'需完成验证',permission_denied:'权限不足',page_missing:'未打开页面',multiple_pages:'选择页面',market_unknown:'市场待确认',bridge_unavailable:'检查不可用',read_failed:'检查未完成',service_error:'平台暂不可用'};
      const labelText=!fresh&&check?.loginVerified?'需重新检查':(names[check?.state]||'待检查');
      $(key+'-label').textContent=label+' · '+labelText;
      $(key+'-dot').className='dot'+(fresh&&check?.state==='signed_in'?'':' amber');
    }
  }
  function cleanRuntime(c){const out={cli:c.cli};for(const k of ['provider','model','effort'])if(c[k])out[k]=c[k];return out;}
  async function runtimeDialog(){
    if(!catalogAPI)throw new Error('MultiCC 配置目录组件不可用，请刷新宿主后重试。');
    const offered=Object.keys(catalogAPI.CLI_DISPLAY).filter(k=>catalogAPI.cliOffersIn(k,'chat')&&!catalogAPI.cliProviderless(k));
    modal('执行配置','<p>读取 MultiCC 供应商与模型目录。仅修改当前选人任务，不改全局配置。</p><div class="field"><label>执行工具</label><select id="runtime-cli"></select></div><div class="field"><label>供应商线路</label><select id="runtime-provider"></select></div><div class="field"><label>模型</label><select id="runtime-model"></select><input id="runtime-custom" aria-label="自定义模型" placeholder="输入供应商支持的模型编号" hidden></div><div class="field"><label>推理强度</label><select id="runtime-effort"><option value="">沿用工具默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">很高</option></select></div>',[['取消',close],['应用到后续对话',async()=>{
      const cli=$('runtime-cli').value,provider=$('runtime-provider').value,model=$('runtime-model').value==='__custom__'?$('runtime-custom').value.trim():$('runtime-model').value;
      if(!cli||!provider)throw new Error('请选择有效执行工具与供应商。');
      const next={cli,provider,model,effort:$('runtime-effort').value,providerName:$('runtime-provider').selectedOptions[0]?.textContent};
      if(state.op){await applyRuntime(next,state.op);state.config=next;}else state.config=next;
      storage.set('config',state.config);controls();close();
    },true]]);
    for(const cli of offered){const o=el('option',catalogAPI.cliDisplayName(cli));o.value=cli;$('runtime-cli').append(o);}
    if(offered.includes(state.config?.cli))$('runtime-cli').value=state.config.cli;
    let epoch=0,providers=[];
    function models(){const p=providers.find(p=>p.id===$('runtime-provider').value);$('runtime-model').replaceChildren();const opts=catalogAPI.modelsFor(p);for(const v of opts){const value=typeof v==='string'?v:v.id||v.value||v.model;const o=el('option',typeof v==='string'?v:v.label||v.name||value);o.value=value;$('runtime-model').append(o);}const custom=el('option','自定义模型');custom.value='__custom__';$('runtime-model').append(custom);const chosen=state.config?.model;if(chosen&&[...$('runtime-model').options].some(o=>o.value===chosen))$('runtime-model').value=chosen;else if(chosen){$('runtime-model').value='__custom__';$('runtime-custom').value=chosen;}else if(!opts.length)$('runtime-model').value='__custom__';$('runtime-custom').hidden=$('runtime-model').value!=='__custom__';}
    async function load(){const mine=++epoch;$('runtime-provider').disabled=true;const cli=$('runtime-cli').value;try{const c=catalogAPI.normalizeCatalog(await client.request('/api/providers?cli='+encodeURIComponent(cli)));if(mine!==epoch||!$('dialog').open)return;providers=catalogAPI.providersForCli(c,cli);$('runtime-provider').replaceChildren();for(const p of providers){const o=el('option',catalogAPI.providerDisplayName(p));o.value=p.id;$('runtime-provider').append(o);}if(providers.some(p=>p.id===state.config?.provider))$('runtime-provider').value=state.config.provider;models();}catch(e){$('dialog-error').textContent=e.message;$('dialog-error').hidden=false;}finally{$('runtime-provider').disabled=false;}}
    $('runtime-cli').onchange=load;$('runtime-provider').onchange=models;$('runtime-model').onchange=()=>{$('runtime-custom').hidden=$('runtime-model').value!=='__custom__';};$('runtime-effort').value=state.config?.effort||'';await load();
  }
  async function applyRuntime(next,op){
    const base='/api/sessions/'+encodeURIComponent(op.task.sessionId);
    const entry=await client.request('/api/task-shell-tasks/'+encodeURIComponent(op.task.taskId)+'/history?limit=1');
    if(entry.execution?.busy)throw new Error('任务正在执行，请等当前轮结束后切换配置。');
    if(entry.readOnly)throw new Error('原任务只读，不能更换配置。');
    const old=await client.request(base);
    if(old.cli!==next.cli)await client.request(base+'/switch-cli',{cli:next.cli});
    const response=await fetch(base,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:next.provider,providerSelection:null,model:next.model||null,effort:next.effort||null})});
    const r=await response.json();if(!response.ok||r.ok===false)throw new Error(r.error||'配置保存失败');
    const verify=await client.request(base);
    if(verify.cli!==next.cli||verify.provider!==next.provider||(next.model&&verify.model!==next.model))throw new Error('配置尚未读回一致，请在原任务检查后重试。');
  }
  async function workspaceDialog(){const directories=await client.request('/api/directories');if(!Array.isArray(directories))throw new Error('目录清单不可读取');modal('运营目录','<p>选人任务和证据使用此持久目录。已创建的会话保留原目录。</p><div class="field"><label>MultiCC 已登记目录</label><select id="directory"></select></div>',[['取消',close],['保存目录',async()=>{const d=directories.find(d=>d.id===$('directory').value);if(!d)throw new Error('请选择有效目录');await client.run('configure',{workspace:{dirId:d.id,path:d.path}});state.status=await client.run('status');controls();close();},true]]);for(const d of directories){const o=el('option',d.name||d.path);o.value=d.id;$('directory').append(o);}if(state.status?.workspace?.dirId)$('directory').value=state.status.workspace.dirId;}
  async function dependencyDialog(envOverride){
    const gen=state.generation,inputs=state.op?{operationId:state.op.id}:{};
    const env=envOverride||await client.run('selection-environment',inputs);if(gen!==state.generation)return;
    state.env=env;controls();
    const b=env.browser,proof=env.sameProfile&&env.confirmation?.method==='automatic'?(env.confirmation||{}):{},current=!!state.op;
    const draw=key=>{const p=proof[key]||{};return '<div class="dep"><h3>'+(key==='kalodata'?'② Kalodata':'③ 店铺与达人联盟')+'</h3><p>'+esc(p.message||'绑定实例后自动检查，在该实例内完成平台登录。')+'</p>'+(p.account?'<p>检测到：'+esc(p.account)+' · '+esc(p.market||'市场待确认')+'</p>':'')+(p.checkedAt?'<p>检查时间：'+esc(new Date(p.checkedAt).toLocaleString())+'</p>':'')+(p.pages?.length>1?'<label>本次使用的页面<select id="page-'+key+'" aria-label="'+(key==='kalodata'?'Kalodata 页面':'店铺页面')+'"><option value="">请选择</option>'+p.pages.map(q=>'<option value="'+esc(q.targetId)+'" '+(proof.targetSelections?.[key]===q.targetId?'selected':'')+'>'+esc(q.title||q.url)+'</option>').join('')+'</select></label>':'')+'<button data-open-platform="'+key+'">在绑定实例打开平台</button></div>';};
    modal('本次选人环境','<p>在浏览器实例内登录 Kalodata 和店铺，工作台自动检查状态。检查会短暂打开并关闭后台核验页，保留你原来的页面。</p><div class="dep"><h3>① 浏览器实例</h3><select id="profile-picker" aria-label="浏览器实例" '+(current?'disabled':'')+'></select><button id="bind-profile" '+(current?'disabled':'')+'>绑定并检查</button><p>'+(current?'此对话使用固定实例；更换实例请新建对话。':'切换实例后重新检查。')+'</p><a href="/plugins/chrome-proxy-launcher/ui/index.html" target="_blank" rel="noopener">打开浏览器隔离插件 ↗</a></div>'+draw('kalodata')+draw('shop')+'<p>登录通过后，本轮筛选所需字段与时间范围仍会逐项核验。</p>',[['关闭',close],['重新检查',async()=>{
      const targets={...(proof.targetSelections||{})};for(const k of ['kalodata','shop'])if($('page-'+k))targets[k]=$('page-'+k).value||null;
      $('dialog-error').hidden=false;$('dialog-error').textContent='正在检查绑定实例中的平台，请稍候…';
      const checked=await client.run('selection-check-environment',{...inputs,expectedBinding:b.binding,targets});
      if(gen===state.generation){state.env=checked;controls();if($('dialog').open)await dependencyDialog(checked);}
    },true]]);
    const placeholder=el('option','请选择专用实例');placeholder.value='';$('profile-picker').append(placeholder);
    for(const p of b.environments){const o=el('option',p.name+' · '+(p.processState==='pid_alive'?'运行中':'未运行'));o.value=p.id;$('profile-picker').append(o);}if(b.binding.profile)$('profile-picker').value=b.binding.profile.id;
    const runAction=async(action)=>{const nodes=[...$('dialog-body').querySelectorAll('select,button')],disabled=nodes.map(n=>n.disabled);try{nodes.forEach(n=>n.disabled=true);$('dialog-error').hidden=false;$('dialog-error').textContent='正在处理，请稍候…';await action();}catch(e){$('dialog-error').textContent=e.message;$('dialog-error').hidden=false;nodes.forEach((n,i)=>n.disabled=disabled[i]);}};
    $('bind-profile').onclick=()=>runAction(async()=>{const p=b.environments.find(p=>p.id===$('profile-picker').value);if(!p)throw new Error('请选择实例');await client.run('bind-browser',{profileId:p.id,expectedRevision:b.binding.revision,expectedSourceRevision:p.sourceRevision});const checked=await client.run('selection-check-environment',inputs);if(gen===state.generation){state.env=checked;controls();if($('dialog').open)await dependencyDialog(checked);}});
    for(const button of $('dialog-body').querySelectorAll('[data-open-platform]'))button.onclick=()=>runAction(async()=>{await client.run('selection-open-platform',{...inputs,expectedBinding:b.binding,platform:button.dataset.openPlatform});await dependencyDialog();notice('页面已在绑定实例中打开。请前往该实例登录，然后重新检查。');});
  }
  function renderLists(){
    const v=state.record,history=state.data?.versions||[];const adopted=new Set((state.data?.adoptions||[]).filter(a=>a.revision===v?.revision).flatMap(a=>[...(a.accepted||[]),...(a.skipped||[])]).map(a=>a.key));$('list-status').textContent=adopted.size?'本版已采用 '+adopted.size+' 位；其余候选可继续核验。':'';
    $('versions').replaceChildren();for(const item of history){const b=el('button','第 '+item.revision+' 版'+(item.revision===history[0]?.revision?' · 最新':''),'version'+(v?.revision===item.revision?' active':''));b.onclick=()=>selectVersion(item.revision).catch(fail);$('versions').append(b);}
    $('saved-label').textContent=history.length?'已保存 '+history.length+' 个名单版本':'尚无名单版本';$('base-note').textContent=state.base?'下一轮基于第 '+state.base+' 版':'首次选人 · 尚无名单';
    $('list-count').textContent=v?.list.candidates.length||0;$('delta').textContent=v?.list.criteria||'任务形成名单并成功回写后，版本会出现在这里。';$('compare').disabled=!v?.parentRevision;$('people').replaceChildren();
    if(!v)$('people').append(el('div','尚无已保存名单。对话生成后会按固定格式回到这里。','empty'));
    for(const c of v?.list.candidates||[]){
      const item=el('article',undefined,'person');const top=el('div',undefined,'person-top');const check=document.createElement('input');check.type='checkbox';check.className='check';check.checked=state.selected.has(c.key);check.setAttribute('aria-label','选择 '+c.identity.handle);check.onchange=()=>{check.checked?state.selected.add(c.key):state.selected.delete(c.key);selected();};const title=el('div',undefined,'person-main');title.append(el('strong',c.identity.handle),el('small',[c.content.country,c.content.categories.join('、')].filter(Boolean).join(' · ')));top.append(check,el('div',c.identity.handle.slice(0,1),'avatar'),title,el('span',adopted.has(c.key)?'此版已采用':c.identity.accountId?'候选':'身份待核','tag'+(c.identity.accountId?'':' amber')));item.append(top);
      const metrics=el('div',undefined,'metrics');for(const name of ['followers','gmv']){const m=c.metrics.find(m=>m.name===name);const box=el('div');box.append(el('span',name==='followers'?'粉丝数':'成交额'),el('b',m?.value==null?'未知':m.value+' '+m.unit));metrics.append(box);}const fit=el('div');fit.append(el('span','内容适配'),el('b',c.content.fit));metrics.append(fit);item.append(metrics,el('p',c.content.reason,'reason'));const detail=el('button','查看依据与缺失项 ↗','text-button');detail.onclick=()=>detailDialog(c);item.append(detail);$('people').append(item);
    }
    selected();
  }
  function selected(){$('selection-count').textContent='已选 '+state.selected.size+' 位';controls();}
  function detailDialog(c){const sources=c.sources.map(s=>'<div class="diff-row"><a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.platform)+' · '+esc(s.id)+'</a><br>'+esc(s.capturedAt)+'<p>'+esc(s.note)+'</p></div>').join('');modal(c.identity.handle+' · 资料依据','<dl class="detail-grid"><dt>稳定账号编号</dt><dd>'+esc(c.identity.accountId||'待核验')+'</dd><dt>账号主页</dt><dd><a href="'+esc(c.identity.url)+'" target="_blank" rel="noopener">查看主页 ↗</a></dd><dt>内容依据</dt><dd>'+esc(c.content.reason)+'</dd><dt>缺失项</dt><dd>'+esc(c.missingFields.join('；')||'未报告缺失；仍需业务核验')+'</dd></dl><h3>经营指标</h3>'+c.metrics.map(m=>'<div class="diff-row">'+esc(m.name)+'：'+esc(m.value??'未知')+' '+esc(m.unit)+'<br>来源 '+esc(m.sourceId)+' · '+esc(m.period?m.period.start+' 至 '+m.period.end+' · '+m.period.timeZone:'时点数据，时间见来源')+'</div>').join('')+'<h3>来源</h3>'+sources,[['关闭',close]]);}
  async function selectVersion(rev){const op=state.op?.id,gen=state.generation,versionGen=++state.versionGeneration;state.versionLoading=true;controls();try{const d=await client.run('selection-status',{operationId:op,revision:rev});if(gen!==state.generation||versionGen!==state.versionGeneration)return;state.data=d;state.record=d.record;state.view=rev;state.selected.clear();renderLists();}finally{if(versionGen===state.versionGeneration){state.versionLoading=false;controls();}}}
  async function compare(){const v=state.record,gen=state.generation;const d=await client.run('selection-status',{operationId:state.op.id,revision:v.parentRevision});if(gen!==state.generation)return;const prior=d.record.list.candidates,now=v.list.candidates,old=new Map(prior.map(c=>[c.key,c])),next=new Map(now.map(c=>[c.key,c]));const added=now.filter(c=>!old.has(c.key)),removed=prior.filter(c=>!next.has(c.key)),changed=now.filter(c=>old.has(c.key)&&JSON.stringify(old.get(c.key))!==JSON.stringify(c));modal('第 '+v.revision+' 版与第 '+v.parentRevision+' 版比较','<p>筛选条件：'+esc(d.record.list.criteria)+' → '+esc(v.list.criteria)+'</p>'+[['新增',added],['移除',removed],['资料变化',changed]].map(([label,list])=>'<div class="diff-row"><b>'+label+' '+list.length+' 位</b><p>'+esc(list.map(c=>c.identity.handle).join('、')||'无')+'</p></div>').join(''),[['关闭',close]]);}
  function renderHistory(){
    const box=$('conversation'),nearBottom=box.scrollHeight-box.clientHeight-box.scrollTop<70,scroll=box.scrollTop;box.replaceChildren();
    if(state.hasMore){const b=el('button','加载更早对话','history-more');b.onclick=()=>loadHistory(true).catch(fail);box.append(b);}
    for(const m of state.history){if(!['user','assistant'].includes(m.role))continue;let text=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'';if(m.role==='user')text=text.split('\n\n【工作台选人任务约定】')[0];if(!text)continue;const a=el('div',undefined,'message '+m.role);a.append(el('div',m.role==='user'?'你':'选人助手','by'),el('div',text,'bubble'));box.append(a);}
    if(!state.history.length){for(const t of state.data?.turns||[]){const a=el('div',undefined,'message user');a.append(el('div','你 · '+(t.status==='accepted'?'已受理':'待核对投递'),'by'),el('div',t.prompt,'bubble'));box.append(a);}if(!box.childNodes.length)box.append(el('div','这次想找什么样的达人？\n先确认环境，再描述市场、商品和筛选条件。','empty'));}
    for(const v of (state.data?.versions||[]).slice(0,8).reverse()){const c=el('button',undefined,'result-card');c.append(el('strong','第 '+v.revision+' 版名单 · '+v.count+' 位候选'),el('small','工作台已保存 · 点击查看此版'));c.onclick=()=>selectVersion(v.revision).then(()=>setMobile('list')).catch(fail);box.append(c);}
    box.scrollTop=nearBottom?box.scrollHeight:scroll;
  }
  async function loadHistory(older=false){if(!state.op?.task)return;const gen=state.generation,tid=state.op.task.taskId;const cursor=older?state.history[0]?.id||state.history[0]?.sourceMessageId:null;const d=await client.request('/api/task-shell-tasks/'+encodeURIComponent(tid)+'/history?limit=50'+(cursor?'&before='+encodeURIComponent(cursor):''));if(gen!==state.generation)return;if(d.task?.id&&d.task.id!==tid)throw new Error('宿主历史归属不一致');state.history=older?[...d.messages,...state.history]:d.messages;state.hasMore=d.hasMore;state.execution=d.execution;state.readOnly=d.readOnly===true;const pending=d.execution?.pending;$('chat-status').textContent=d.readOnly?'原任务只读':pending&&!pending.resolved?'等待你回答当前问题':d.execution?.busy?'正在执行':'可继续对话';renderHistory();controls();}
  function fail(e){notice(e.message||String(e),true);}
  async function load(operationId,reset=false){const gen=++state.generation;state.loading=true;controls();try{if(reset){storage.set(draftKey(),$('input').value);state.history=[];state.execution=null;state.readOnly=false;state.view=0;state.base=0;state.selected.clear();}
    const d=await client.run('selection-status',operationId?{operationId}:{});if(gen!==state.generation)return;state.data=d;state.op=operationId===null?null:d.operation;if(operationId===null){state.data={...d,operation:null,turns:[],versions:[],record:null};}
    state.record=state.data.record;state.view=state.record?.revision||0;if(!state.base)state.base=state.view;
    const options=$('operation-picker');options.replaceChildren();const n=el('option','新的选人对话');n.value='';options.append(n);for(const o of d.operations){const option=el('option',o.title);option.value=o.id;options.append(option);}options.value=state.op?.id||'';
    const inputs={};if(state.op)inputs.operationId=state.op.id;
    const [env,status]=await Promise.all([client.run('selection-environment',inputs),client.run('status')]);if(gen!==state.generation)return;state.env=env;state.status=status;
    state.config=state.op?.runtime||storage.get('config');if(state.op?.task){try{const r=await client.request('/api/sessions/'+encodeURIComponent(state.op.task.sessionId));if(gen!==state.generation)return;state.config={cli:r.cli,provider:r.provider,model:r.model,effort:r.effort};}catch(e){notice('运行配置读取失败：'+e.message,true);}}
    $('input').value=storage.get(draftKey())||'';$('task-title').textContent=state.op?.title||'新的选人对话';$('host-task').hidden=!state.op?.task;if(state.op?.task)$('host-task').href=state.op.task.url;
    const url=new URL(location.href);state.op?url.searchParams.set('operation',state.op.id):url.searchParams.delete('operation');history.replaceState({},'',url);
    renderLists();renderHistory();controls();notice(state.env.message);await loadHistory();}finally{if(gen===state.generation){state.loading=false;controls();}}
  }
  async function deliverTurn(t){const op=state.op,shell=await client.request('/api/task-shells/'+encodeURIComponent(op.task.shellId));const receipt=shell.receipts?.find(r=>r.clientMsgId===t.id);let response;if(receipt){if(receipt.taskId!==op.task.taskId)throw new Error('消息回执不属于当前任务');if(receipt.status==='accepted')response={taskId:receipt.taskId,receiptId:receipt.id};else if(['failed','rejected'].includes(receipt.status))response=await client.request('/api/task-shells/'+encodeURIComponent(op.task.shellId)+'/receipts/'+encodeURIComponent(receipt.id)+'/retry',{});else throw new Error('原消息仍在等待确认，请稍后恢复原消息。');}else response=await client.request('/api/task-shell-tasks/'+encodeURIComponent(op.task.taskId)+'/messages',t.message);await client.run('selection-record-turn',{turnId:t.id,response});}
  async function submit(retry=false){if(state.busy||state.loading)return;state.busy=true;controls();try{
    const key='pending:'+(state.op?.id||'new');let pending=storage.get(key);
    if(state.op&&state.op.status!=='accepted'){state.op=await dispatcher.dispatch(state.op);await client.run('selection-record-turn',{turnId:state.op.dispatch.message.clientMsgId,response:state.op.receipt});storage.set(key,null);const pendingNew=storage.get('pending:new');if(pendingNew?.input?.requestId===state.op.requestId){storage.set('pending:new',null);storage.set('draft:new',null);}await load(state.op.id);return;}
    if(!pending&&retry&&state.op){const turn=state.data?.turns?.find(t=>t.status==='prepared'&&!t.id.endsWith('_first'));if(turn){await deliverTurn(turn);await load(state.op.id);return;}}
    if(!pending){if(retry)throw new Error('没有未确认的投递');const prompt=$('input').value.trim();if(!prompt)throw new Error('请先输入选人要求');pending={kind:state.op?'turn':'create',input:{requestId:id(),prompt,runtime:cleanRuntime(state.config),...(state.op?{operationId:state.op.id,parentRevision:state.base}:{})}};if(state.op){await loadHistory();const execution=state.execution,question=execution?.pending;if(state.readOnly)throw new Error('原任务只读，请新建对话');if(question&&!question.resolved){if(question.taskId!==state.op.task.taskId||!question.requestId||!execution.turnId)throw new Error('待回答问题缺少原任务关联，请打开原任务处理');pending.input.control={intent:'answer',turnId:execution.turnId,requestId:question.requestId};}else if(execution?.busy&&execution.turnId)pending.input.control={intent:'steer',turnId:execution.turnId};}storage.set(key,pending);}
    let target=state.op?.id;
    if(pending.kind==='create'){const d=await client.run('selection-create',pending.input);let op=d.operation;op=await dispatcher.dispatch(op);await client.run('selection-record-turn',{turnId:op.dispatch.message.clientMsgId,response:op.receipt});target=op.id;}
    else{const d=await client.run('selection-prepare-turn',pending.input);await deliverTurn(d.turn);}
    storage.set(key,null);storage.set(draftKey(),null);$('input').value='';await load(target);notice('已投递到原任务；名单回写后会显示新版本。');
  }catch(e){fail(e);}finally{state.busy=false;controls();}}
  async function adoptionPreview(){const gen=state.generation;const input={operationId:state.op.id,revision:state.record.revision,keys:[...state.selected]};const expectedPlan=await client.run('selection-preview-adoption',input);if(gen!==state.generation)return;state.adoption={...input,expectedPlan,requestId:id(),confirmed:true};const items=expectedPlan.plan.items;modal('采用前，核对更新范围','<p>本次采用第 '+input.revision+' 版。待核验项保留，人工合作设置和已发生事实保持原样。</p>'+items.map(i=>'<div class="diff-row"><b>'+esc(i.handle)+'</b> · '+({create:'新增档案',update:'保存资料快照',blocked:'暂不合并',unchanged:'此版已采用，跳过'}[i.action])+'<p>'+esc(i.reason)+'</p></div>').join(''),[['返回',close],['确认采用',async()=>{if(storage.get('adoption:'+state.op.id))throw new Error('请先核对上次采用回执');const key='adoption:'+state.op.id;storage.set(key,state.adoption);await recoverAdoption();close();},true]]);}
  async function recoverAdoption(){const operationId=state.op.id,key='adoption:'+operationId,p=storage.get(key);if(!p)return;const before=await client.run('selection-adoption-status',{requestId:p.requestId});if(!before.receipt){try{await client.run('selection-adopt',p);}catch(e){if(e.status&&/档案或采用范围自预览后发生变化|所选名单暂无身份明确且可采用的达人/.test(e.message)){storage.set(key,null);throw new Error(e.message+'。本次未写入，请重新选择并预览。');}throw e;}}const after=await client.run('selection-adoption-status',{requestId:p.requestId});if(!after.receipt||canonical(after.receipt.request)!==canonical(p))throw new Error('采用回执尚未读回一致，请保留原操作重试');storage.set(key,null);if(state.op?.id===operationId){await selectVersion(p.revision);toast('已采用 '+after.receipt.accepted.length+' 位，跳过 '+(after.receipt.skipped?.length||0)+' 位；'+after.receipt.blocked.length+' 位保留待核验。');}}
  $('runtime').onclick=()=>runtimeDialog().catch(fail);$('workspace-pill').onclick=()=>workspaceDialog().catch(fail);for(const k of ['browser-pill','kalo-pill','shop-pill'])$(k).onclick=()=>dependencyDialog().catch(fail);
  $('new-chat').onclick=()=>load(null,true).catch(fail);$('operation-picker').onchange=()=>load($('operation-picker').value||null,true).catch(fail);$('refresh').onclick=()=>load(state.op?.id||null).catch(fail);
  $('input').oninput=()=>{try{storage.set(draftKey(),$('input').value);}catch(e){fail(e);}};$('input').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing){e.preventDefault();if(!$('send').disabled)submit();}};
  $('send').onclick=()=>submit();$('retry').onclick=()=>submit(true);$('compare').onclick=()=>compare().catch(fail);$('adopt').onclick=()=>{if(storage.get('adoption:'+state.op?.id))modal('恢复采用结果','<p>上次采用尚未完成读回确认，请先核对原回执。</p>',[['稍后',close],['核对原回执',async()=>{await recoverAdoption();close();},true]]);else adoptionPreview().catch(fail);};
  $('continue-version').onclick=()=>{state.base=state.record.revision;renderLists();setMobile('chat');$('input').focus();toast('下一轮将基于第 '+state.base+' 版');};
  $('rules').onclick=()=>modal('本轮任务约定','<p>每轮用户输入后附加固定任务约定，包含原任务编号、基准名单和结构化回写契约。</p><ol><li>使用任务固定的浏览器、账号与店铺。</li><li>重新核对本轮需要的字段、来源与统计时窗。</li><li>未知值保留为空，不补零，不按昵称合并身份。</li><li>完整名单通过 Rust 校验后新增版本，读回成功才算已保存。</li><li>人工预览与确认后才能采用，不执行邮件、私信或邀约。</li></ol>',[['知道了',close]]);
  async function poll(){if(document.hidden||state.busy||state.loading||state.versionLoading||state.polling||$('dialog').open)return;state.polling=true;const op=state.op?.id,gen=state.generation;try{const env=await client.run('selection-environment',op?{operationId:op}:{});if(gen!==state.generation)return;const wasReady=state.env?.ready;state.env=env;controls();if(wasReady&&!env.ready)notice(env.message,true);if(!op)return;const d=await client.run('selection-status',{operationId:op,...(state.view?{revision:state.view}:{})});if(gen!==state.generation)return;const wasLatest=state.view===state.data?.versions?.[0]?.revision;state.data=d;state.op=d.operation;if(wasLatest&&d.versions[0]?.revision!==state.view){const fresh=await client.run('selection-status',{operationId:op});if(gen!==state.generation)return;state.data=fresh;state.record=fresh.record;state.view=state.record?.revision||0;state.base=state.view;state.selected.clear();}else if(!state.record&&d.record){state.record=d.record;state.view=state.base=d.record.revision;}renderLists();await loadHistory();}catch(e){fail(e);}finally{state.polling=false;}}
  let timer=setInterval(poll,5000);window.addEventListener('pagehide',()=>clearInterval(timer));document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
  load(new URLSearchParams(location.search).get('operation')||undefined).then(()=>{if(state.op&&storage.get('adoption:'+state.op.id))modal('恢复采用结果','<p>上次采用尚未完成读回确认，请先核对原回执。</p>',[['稍后',close],['核对原回执',async()=>{await recoverAdoption();close();},true]]);}).catch(fail);
}());
