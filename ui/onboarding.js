// 开工引导与运行页面。业务状态来自 Rust；轮询只读状态，不替代后台调度。
(function () {
  'use strict';
  const LABEL={dispatcher:'流转器',sel:'小选',copy:'小文',send:'小发',follow:'小跟',sort:'小拣',deal:'小谈',ful:'小履'};
  const ORDER=Object.keys(LABEL),STATES={pending:'待派发',claimed:'派发待核对',dispatched:'宿主已受理',processing:'员工处理中',awaiting_review:'候选已交回，等待交接',handed_off:'接收员工已验收',draft_ready:'草稿候选已准备',blocked:'等待补充或决定',stale:'依据或约定已变化',cancelled:'本轮已停止'};
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  const client=GapawClient.createClient(window.fetch.bind(window)),call=(name,input={})=>client.run('team-onboarding-'+name,input),clone=v=>JSON.parse(JSON.stringify(v));
  let data=null,roles=[],phase='welcome',roleIndex=0,values=null,reviewed=[],revision=0,busy=false,editing=false,preflight=null,block=null,scene=null,poll=null,returnFocus=null;
  const stateForScene=()=>({phase,reduced:$('reduce-motion').checked,activeKey:phase==='roles'?ORDER[roleIndex]:block?.staffKey||(data?.blockers||[]).find(b=>b.state==='pending')?.staffKey||'dispatcher',blocked:!!block||(data?.blockers||[]).some(b=>b.state==='pending'),copyWorking:(data?.items||[]).some(w=>w.staffKey==='copy'&&w.state==='processing')});
  const link=(text,path)=>{const a=el('a',text);a.href=path;return a;};
  const notice=t=>$('global-notice').textContent=t||'';
  function button(text,action,primary=false){const b=el('button',text,'btn'+(primary?' primary arrow':''));b.type='button';b.setAttribute('aria-label',text);b.disabled=busy;b.onclick=()=>act(action);return b;}
  async function act(action){if(busy)return;busy=true;notice('正在核对并保存…');document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await action();notice('');}catch(e){notice(e.message);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
  function field(parent,id,label,value,{multiline=false,oninput,readonly=false}={}){const wrap=el('div',null,'form-field'),l=el('label',label),input=el(multiline?'textarea':'input');l.htmlFor=id;input.id=id;input.value=value||'';input.maxLength=id.includes('prompt')?18000:2000;input.readOnly=readonly;if(!multiline)input.type='text';input.oninput=()=>oninput?.(input.value);wrap.append(l,input);parent.append(wrap);return input;}
  function select(parent,id,label,value,options,onchange){const wrap=el('div',null,'form-field'),l=el('label',label),input=el('select');l.htmlFor=id;input.id=id;options.forEach(([v,t])=>{const o=el('option',t);o.value=v;input.append(o);});input.value=value;input.onchange=()=>onchange(input.value);wrap.append(l,input);parent.append(wrap);return input;}
  function prepareEdit(){values=clone(data.config.values);reviewed=[...(data.config.reviewedRoles||[])];revision=data.config.revision;}
  async function refresh({renderPage=true}={}){data=await call('status');if(renderPage)render();}
  async function save(step){data=await call('save',{requestId:crypto.randomUUID(),expectedRevision:revision,step,values,reviewedRoles:reviewed});revision=data.config.revision;}
  async function loadRoles(){const result=await call('roles');roles=result.roles;}
  async function go(next){phase=next;render();if(innerWidth<781)$('speaker-name').scrollIntoView({block:'start'});}
  function summary(text){return el('p',text,'say');}
  function render(){
    if(!data)return;const cfg=data.config,d=$('dialogue'),a=$('actions'),active=stateForScene().activeKey;
    d.replaceChildren();a.replaceChildren();$('aside-action').replaceChildren();$('feedback').textContent='';
    $('speaker-name').textContent=LABEL[active]||'流转器';$('speaker-job').textContent=roles.find(r=>r.key===active)?.description||'让工作按约定接着往下走';
    $('journal-count').textContent=data.history.length;$('settings-btn').hidden=!cfg.completed;$('setup-steps').hidden=!!cfg.completed;$('live-badge').hidden=!cfg.completed;
    $('live-badge').textContent=cfg.running?'已允许团队运行':'已暂停领取新工作';
    const index={welcome:0,mission:0,roles:1,rules:2,preflight:3,runtime:4,blocker:4}[phase];document.querySelectorAll('.steps li').forEach((li,i)=>{li.className=i===index?'active':i<index?'done':'';li.toggleAttribute('aria-current',i===index);});
    $('ready-count').textContent=cfg.completed?'工作约定版本 '+cfg.revision:phase==='roles'?'已逐个确认 '+(reviewed?.length||0)+' / 8 位':data.team.initialized?'已有团队 · 设置下一轮工作':'准备你的运营团队';
    const titles={welcome:'第一次开工，先把团队准备好。',mission:'先告诉大家，要做成什么。',roles:'认识伙伴，约定工作方式。',rules:'这些事，交给团队自己推进。',preflight:'核对准备情况，再开始运行。',runtime:'团队在工作，你掌握方向。',blocker:'这件事，需要老板决定。'};
    if(phase==='welcome'&&data.creators.length)titles.welcome='已有业务，接着安排下一轮。';
    $('scene-title').textContent=phase==='runtime'&&!cfg.running?'办公室已暂停，你可以随时调整。':titles[phase];$('speech-tag').textContent=cfg.completed?'真实运行状态':'开工设置';$('room-label').textContent=cfg.completed?'工作室 · 当前状态':'工作室 · 安排工作';
    $('scene-caption').textContent=stateForScene().blocked?'员工带着卡点来找你；未受影响的工单继续。':cfg.running?'工单由宿主后台时钟调度，进展以实际回执为准。':cfg.completed?'已暂停新工作；运行中的员工仍可交回结果。':'先对齐目标和规则，确认后再开工。';
    $('desk-note').textContent='交回候选、接收员工验收、正式采用分别记账。待补资料的部分会保持未完成。';
    ORDER.forEach(k=>{$('pin-'+k)?.classList.toggle('active',k===active);$('mini-'+k)?.classList.toggle('ready',reviewed?.includes(k)||cfg.completed);});scene?.portrait(active);
    if(!data.team.initialized){d.append(el('h3','先把办公室和员工准备好。'),summary('请在连接与设置中选定模型、线路和运营目录，初始化流转器与七位员工。已有配置会继续使用。'),link('去连接与设置','./setup.html#team-panel'));return;}
    if(phase==='welcome'){
      d.append(el('p','已有业务可随时从工作总览查看','eyebrow'),el('h3','安排接下来要做的工作。'),summary('先选定本轮目标与已有候选，认识角色、调整提示词，再核对开工条件。团队会按约定准备候选和草稿，遇到缺资料或条件冲突才来找你。'),el('p','当前接通已有候选复核与文案准备。新平台发现和真实外发另行处理。','detail'));
      a.append(button('开始开工设置',()=>{prepareEdit();return go('mission');},true));
    }else if(phase==='mission')renderMission(d,a);
    else if(phase==='roles')renderRoles(d,a);
    else if(phase==='rules')renderRules(d,a);
    else if(phase==='preflight')renderPreflight(d,a);
    else if(phase==='blocker')renderBlocker(d,a);
    else renderRuntime(d,a);
  }
  function missionFields(parent,prefix,object){field(parent,prefix+'product','本轮产品与目标',object.product,{oninput:v=>object.product=v});field(parent,prefix+'market','市场与内容语言',object.market,{oninput:v=>object.market=v});field(parent,prefix+'criteria','必须满足的筛选条件',object.criteria,{multiline:true,oninput:v=>object.criteria=v});}
  function candidates(parent,object){parent.append(el('p','选择本轮复核的已有候选（每轮最多 20 位）','detail'));const list=el('div',null,'candidate-list');list.id='candidate-list';for(const row of data.creators){const l=el('label'),input=el('input');input.type='checkbox';input.value=row.id;input.checked=object.creatorIds.includes(row.id);input.onchange=()=>{object.creatorIds=object.creatorIds.filter(id=>id!==row.id);if(input.checked)object.creatorIds.push(row.id);};l.append(input,document.createTextNode((row.handle?'@'+row.handle:row.id)+' · '+row.id));list.append(l);}parent.append(list);if(!data.creators.length)parent.append(link('准备或导入业务资料','./setup.html'));}
  function renderMission(d,a){d.append(el('h3','这次，我们要帮你做什么？'),summary('员工会逐位核对你选定的候选。缺少的数据会明确列出来，不会默认为合格。'));missionFields(d,'',values);candidates(d,values);a.append(button('保存目标，认识团队',async()=>{await save('roles');await loadRoles();roleIndex=0;await go('roles');},true));}
  function renderRoles(d,a){const r=roles.find(r=>r.key===ORDER[roleIndex]);if(!r){d.append(summary('尚未读到真实角色提示词。'));a.append(button('读取角色任务',async()=>{await loadRoles();render();},true));return;}
    d.append(el('p',(roleIndex+1)+' / 8 · '+r.name,'eyebrow'),el('h3',r.name+'，来报到。'),summary(r.description),link('打开原角色任务',r.task.url));
    const input=field(d,'role-prompt','当前角色提示词，可直接修改',r.prompt,{multiline:true});d.append(el('p','保存后写入这个真实角色任务；开工、交接和卡点协议由插件维护。正在执行的角色需等当前轮结束再改。','detail'));
    a.append(button('上一位',()=>{roleIndex=Math.max(0,roleIndex-1);render();}),button('保存并确认，下一位',async()=>{await call('role-save',{staffKey:r.key,expectedVersion:r.version,prompt:input.value});if(!reviewed.includes(r.key))reviewed.push(r.key);await refresh({renderPage:false});revision=data.config.revision;await save(roleIndex===7?'rules':'roles');await loadRoles();if(roleIndex===7)await go('rules');else{roleIndex++;render();}},true));
    $('aside-action').append(button('其余采用当前提示词，统一同步开工协议',async()=>{for(const row of roles){notice('正在同步'+row.name+'…');await call('role-save',{staffKey:row.key,expectedVersion:row.version,prompt:row.key===r.key?input.value:row.prompt});}reviewed=[...ORDER];await refresh({renderPage:false});revision=data.config.revision;await save('rules');await go('rules');}));
  }
  function ruleFields(parent,prefix,object){field(parent,prefix+'strategy','选人顺序和偏好',object.strategy,{multiline:true,oninput:v=>object.strategy=v});field(parent,prefix+'tone','文案语气与注意事项',object.tone,{multiline:true,oninput:v=>object.tone=v});}
  function renderRules(d,a){d.append(el('h3','日常准备，让大家自己接着做。'),summary('你提前定方向，小选逐位核验，资料通过交付验收后由小文准备草稿。'));ruleFields(d,'',values);const box=el('div',null,'agreement');box.append(el('b','工作权限'),el('p','团队自行：核验候选、交接资料、准备草稿。','detail'),el('p','卡点找你：资料不足、条件冲突、任务异常。未受影响的工单继续。','detail'),el('p','仍需你确认：正式采用、邮件外发、报价与合作承诺。','detail'));d.append(box);a.append(button('返回选人目标',()=>go('mission')),button('保存约定，检查开工条件',async()=>{await save('preflight');preflight=await call('preflight');await go('preflight');},true));}
  function renderPreflight(d,a){d.append(el('h3','把必需的条件核对清楚。'),summary('检查真实任务、当前提示词、宿主交付接口与后台调度。不会用动画或演示结果替代这些检查。'));
    if(preflight){const ul=el('ul',null,'preflight');preflight.checks.forEach(c=>{const li=el('li'),t=el('div');t.append(el('strong',c.label),el('small',c.message));li.append(t,el('span',c.ready?'已核对':'待处理',c.ready?'status good':'status'));ul.append(li);});d.append(ul,el('p',preflight.scope,'detail'));}
    a.append(button('重新检查',async()=>{preflight=await call('preflight');render();}),button('回去调整约定',()=>go('rules')));
    if(preflight?.ready)a.append(button('按这些设置开工',async()=>{data=await call('control',{requestId:crypto.randomUUID(),expectedRevision:data.config.revision,expectedControlVersion:data.config.controlVersion||0,running:true});phase='runtime';await call('tick');await refresh();},true));
    d.append(link('处理连接与宿主配置','./setup.html'));
  }
  function renderRuntime(d,a){const items=data.items,pending=data.blockers.filter(b=>b.state==='pending');d.append(el('h3',!data.config.running?'办公室已暂停领取新工作。':pending.length?'有卡点待决定，其余工作继续。':'团队按工作约定推进。'));
    const metrics=el('div',null,'run-metrics');[[items.filter(w=>['processing','dispatched','claimed'].includes(w.state)).length,'处理中'],[items.filter(w=>w.state==='draft_ready').length,'草稿候选'],[pending.length,'待你决定']].forEach(([v,t])=>{const c=el('div');c.append(el('strong',String(v)),el('small',t));metrics.append(c);});d.append(metrics);
    if(data.lastTick){d.append(el('p','最近核对：'+new Date(data.lastTick.at).toLocaleString()+' · '+data.lastTick.message,data.lastTick.ok?'detail':'notice-error'));if(Date.now()-Date.parse(data.lastTick.at)>180000&&data.config.running)d.append(el('p','后台核对回执已超过三分钟未更新，请检查宿主时钟。','notice-error'));}
    else d.append(el('p','尚无后台核对回执。开工后每分钟检查一次；页面轮询只读取进度。','detail'));
    for(const b of data.blockers){const card=el('div',null,'blocker-card');card.append(el('span',(LABEL[b.staffKey]||'员工')+' → 老板','eyebrow'),el('h4',b.reason),el('p',b.suggestion,'detail'));if(b.state==='waiting')card.append(el('p','已挂起等补充，这部分仍未完成。','detail'));card.append(button(b.state==='waiting'?'补齐后重新处理':'查看卡点并决定',()=>{block=clone(b);return go('blocker');},true));d.append(card);}
    const list=el('ul',null,'work-stream');items.forEach(w=>{const li=el('li');li.append(el('span',LABEL[w.staffKey],'work-name'),el('span',STATES[w.state]||w.state),el('small',(data.creators.find(c=>c.id===w.creatorId)?.handle||w.creatorId)));if(w.submissions?.length)li.append(button('查看交回内容',()=>showWork(w)));list.append(li);});d.append(list);if(!items.length)d.append(summary('本轮尚未生成工单。后台会依据已保存的候选范围准备工作。'));
    a.append(button('随时调整工作约定',openSettings,true),button(data.config.running?'暂停领取新工作':'恢复运行',async()=>{if(!data.config.running){preflight=await call('preflight');if(!preflight.ready){await go('preflight');return;}}data=await call('control',{requestId:crypto.randomUUID(),expectedRevision:data.config.revision,expectedControlVersion:data.config.controlVersion||0,running:!data.config.running});render();}));
    $('aside-action').append(button('立即核对一次队列',async()=>{await call('tick');await refresh();}));
    d.append(el('p','已经运行的员工可以交回结果；候选草稿尚未正式采用，邮件不会自动发送。','detail'));
  }
  function renderBlocker(d,a){if(!block){phase='runtime';render();return;}d.append(el('h3',block.reason),summary(block.suggestion));const ul=el('ul');(block.missing||[]).forEach(x=>ul.append(el('li',typeof x==='string'?x:JSON.stringify(x))));d.append(ul);
    let action='hold';select(d,'block-action','如何处理这张工单？','hold',[['hold','先挂起，等资料补齐'],['retry','按当前资料重新核验'],['exclude','本轮不再处理这位候选']],v=>action=v);const input=field(d,'boss-note','补充要求（会写入重新核验的工单）',block.note||'',{multiline:true});
    a.append(button('稍后处理，回办公室',()=>{block=null;return go('runtime');}),button('保存这个决定',async()=>{data=await call('decide',{requestId:crypto.randomUUID(),workId:block.workId,expectedVersion:block.version,action,note:input.value});block=null;await go('runtime');},true));
  }
  function modal(title,build){returnFocus=document.activeElement;$('modal-title').textContent=title;$('modal-body').replaceChildren();build($('modal-body'));$('modal').hidden=false;document.body.style.overflow='hidden';$('modal-close').focus();}
  function close(){if(busy)return;$('modal').hidden=true;document.body.style.overflow='';editing=false;returnFocus?.isConnected&&returnFocus.focus();}
  function showWork(w){modal('交回候选 · '+(LABEL[w.staffKey]||''),body=>{for(const s of w.submissions){body.append(summary(s.result.summary));const ul=el('ul');s.result.evidence.forEach(x=>ul.append(el('li',x)));body.append(ul);if(s.result.draft)body.append(el('h3',s.result.draft.subject),el('pre',s.result.draft.body,'prompt-preview'));}body.append(link('返回工作总览','./index.html'));});}
  async function openSettings(){editing=true;const draft=clone(data.config.values),expected=data.config.revision;modal('随时调整工作约定',body=>{body.append(el('p','保存后，依赖旧约定的候选重新核验；历史记录保留。','detail'));missionFields(body,'edit-',draft);ruleFields(body,'edit-',draft);candidates(body,draft);const row=el('div',null,'actions');row.append(button('取消',()=>{busy=false;close();}),button('保存并用于后续工作',async()=>{data=await call('save',{requestId:crypto.randomUUID(),expectedRevision:expected,step:'preflight',values:draft,reviewedRoles:data.config.reviewedRoles||[]});$('modal').hidden=true;document.body.style.overflow='';editing=false;phase='runtime';render();},true));body.append(row,el('p','角色提示词可点击办公室里的员工进行调整。','detail'));});}
  async function selectRole(key){if(phase==='roles'){roleIndex=ORDER.indexOf(key);render();return;}await act(async()=>{await loadRoles();const r=roles.find(r=>r.key===key);editing=true;modal(r.name+' · 工作方式',body=>{body.append(summary(r.description),link('打开原角色任务',r.task.url));const input=field(body,'edit-role-prompt','角色提示词',r.prompt,{multiline:true});body.append(button('保存到真实角色任务',async()=>{await call('role-save',{staffKey:r.key,expectedVersion:r.version,prompt:input.value});$('modal').hidden=true;document.body.style.overflow='';editing=false;await refresh();},true));});});}
  function journal(){modal('老板的手册',body=>{const ol=el('ol');for(const h of data.history){const li=el('li');li.append(el('strong',h.title),el('p',new Date(h.at).toLocaleString(),'detail'),el('pre',typeof h.body==='string'?h.body:JSON.stringify(h.body,null,2),'prompt-preview'));ol.append(li);}body.append(ol);});}
  async function polling(){clearTimeout(poll);if(!document.hidden&&!busy){try{await refresh({renderPage:phase==='runtime'&&$('modal').hidden});}catch(e){notice('状态暂未更新：'+e.message);}}poll=setTimeout(polling,6000);}
  document.addEventListener('DOMContentLoaded',async()=>{
    scene=GapawOnboardingScene.mount(document,stateForScene,selectRole);$('settings-btn').onclick=()=>act(openSettings);$('journal-btn').onclick=journal;$('modal-close').onclick=close;$('modal').onclick=e=>{if(e.target===$('modal'))close();};$('refresh-btn').onclick=()=>act(async()=>{await refresh({renderPage:false});if(!editing&&phase!=='blocker'){prepareEdit();phase=data.config.completed?'runtime':data.config.step;render();}});
    document.addEventListener('keydown',e=>{if($('modal').hidden)return;if(e.key==='Escape')close();if(e.key==='Tab'){const xs=[...$('modal').querySelectorAll('button,input,select,textarea,a')].filter(n=>n.getClientRects().length&&!n.disabled);if(!xs.length)return;if(e.shiftKey&&document.activeElement===xs[0]){e.preventDefault();xs.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===xs.at(-1)){e.preventDefault();xs[0].focus();}}});
    try{data=await call('status');prepareEdit();phase=data.config.completed?'runtime':data.config.revision?data.config.step:'welcome';if(phase==='roles')await loadRoles();render();notice('');}catch(e){notice(e.message);$('dialogue').append(summary('暂时无法读取办公室，请恢复连接后刷新。'));}poll=setTimeout(polling,6000);
  });
}());
