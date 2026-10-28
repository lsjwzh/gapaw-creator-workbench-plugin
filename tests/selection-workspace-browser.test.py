"""隔离端到端：实际 Rust 命令与持久库，宿主任务/浏览器目录用合成接口。"""
import json,os,tempfile,threading,subprocess,shutil
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parent.parent
HOST=Path('/Users/Zhuanz/Downloads/gapasea-all-in-one/code/claudecode/multicc')
BINARY=os.environ.get('GAPAW_TEST_BINARY','/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench')
class Catalog(BaseHTTPRequestHandler):
 signed_out=False
 def log_message(self,*a): pass
 def do_GET(self): self.send_json({'plugins':[{'id':'chrome-proxy-launcher','version':'1.6.3','commands':['list','browser-read-capabilities','browser-read'],'engine':{'available':True}}]})
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))));cmd=body.get('command');i=body.get('input',{})
  if cmd=='list':out={'profiles':[{'id':'alpha','name':'测试专用实例','createdAt':1,'updatedAt':2,'running':True}],'subscriptions':[]}
  elif cmd=='browser-read-capabilities':out={'protocol':'multicc-browser-read-v1','actions':['status','pages','inspect-page','open-page']}
  else:
   out={**i,'available':True,'instanceId':'11111111-1111-4111-8111-111111111111'}
   if i.get('action')=='pages':out['pages']=[{'targetId':'kalo','title':'合成分析平台','url':'https://www.kalodata.com/creator'},{'targetId':'shop','title':'合成店铺','url':'https://affiliate.tiktok.com/connection'}]
   if i.get('action')=='inspect-page':
    k=i['targetId']=='kalo';out.update({'page':{'targetId':i['targetId'],'url':'https://www.kalodata.com/creator' if k else 'https://affiliate.tiktok.com/connection','text':'合成业务页','truncated':False},'observations':{'identity':{'httpStatus':401 if Catalog.signed_out else 200,'bodyState':'json','metadata':{'country':'US'},'fields':{'/success':True,'/data/username':'test-analysis','/data/secId':'test-analysis'} if k else {'/code':0,'/data/account/account_id':'operator','/data/shop/shop_id':'test-shop','/data/shop/shop_name':'test-shop','/data/shop/region':'US'}}}})
  self.send_json(out)
 def send_json(self,v):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(v).encode())
def candidate(k,account):
 return {'key':k,'identity':{'platform':'tiktok','accountId':account,'handle':'合成达人'+k,'url':'https://www.tiktok.com/@fixture_'+k,'sourceId':'s'},'content':{'country':'US','language':None,'categories':['宠物'],'fit':'待核验','reason':'合成的内容依据'},'metrics':[{'name':'followers','value':None,'unit':'人','sourceId':'s','period':None}],'contacts':[],'sources':[{'id':'s','platform':'tiktok','url':'https://www.tiktok.com/@fixture_'+k,'capturedAt':'2026-10-28T00:00:00Z','note':'隔离测试'}],'missingFields':['粉丝数未知']}
with tempfile.TemporaryDirectory(prefix='gapaw-selection-browser-') as data:
 workspace=tempfile.mkdtemp(prefix='.gapaw-selection-browser-',dir=Path.home())
 server=ThreadingHTTPServer(('127.0.0.1',0),Catalog);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 env={**os.environ,'GAPAW_CREATOR_DATA_DIR':data,'GAPAW_BROWSER_HOST_URL':'http://127.0.0.1:'+str(server.server_port)}
 for key in ['MULTICC_PLUGIN_WORKSPACE','MULTICC_PLUGIN_DIR_ID']:env.pop(key,None)
 def raw(cmd,payload={}):
  p=subprocess.run([BINARY,cmd],input=json.dumps(payload),text=True,capture_output=True,env=env,check=True)
  return json.loads(p.stdout)
 def run(cmd,payload={}):
  v=raw(cmd,payload);assert v['ok'],v;return v['data']
 run('local-workbench-init',{'confirmed':True})
 execution={'busy':False};control={'dropNext':False};sent=[];messages=[];receipts=[];requests=[];runtime={'cli':'codex-exp','provider':'fixture','model':'fixture-model','effort':None};errors=[]
 def respond(route):
  request=route.request;url=request.url.split('https://plugin.test',1)[-1];body=request.post_data_json if request.method in ['POST','PATCH'] else {}
  requests.append((request.method,url))
  if url.startswith('/plugins/gapaw-creator-workbench/ui/'):
   name=url.split('/')[-1].split('?')[0];p=ROOT/'ui'/name
   route.fulfill(status=200,body=p.read_bytes(),content_type='text/css' if name.endswith('.css') else 'application/javascript' if name.endswith('.js') else 'text/html; charset=utf-8');return
  if url in ['/shared/format.js','/provider-catalog.js','/run-config.js']:
   route.fulfill(status=200,body=(HOST/'public'/url[1:]).read_bytes(),content_type='application/javascript');return
  value={};status=200
  if url=='/api/plugins/gapaw-creator-workbench/run':
   result=raw(body['command'],body.get('input',{}));value=result.get('data') if result['ok'] else result
   if not result['ok']:status=400
  elif url=='/api/directories':value=[{'id':'dir-fixture','name':'测试运营目录','path':str(Path(workspace).resolve())}]
  elif url.startswith('/api/providers?'):
   value={'available':True,'providers':[{'id':'fixture','name':'合成线路','appType':'codex','apiFormat':'openai_responses','compatibleClis':['codex','codex-exp'],'model':'fixture-model','modelOptions':['fixture-model','fixture-model-2'],'hasToken':True}],'defaults':{}}
  elif url=='/api/air/tasks':
   runtime.update({k:body[k] for k in ['cli','provider','model','effort'] if k in body});value={'taskId':'tsk_fixture','sessionId':'session_fixture','shellId':'shell_fixture','url':'/air?task=tsk_fixture'}
  elif url=='/api/task-shells/shell_fixture':value={'receipts':receipts}
  elif url.startswith('/api/task-shell-tasks/tsk_fixture/history'):
   value={'task':{'id':'tsk_fixture'},'messages':messages,'hasMore':False,'execution':execution,'readOnly':False}
  elif url=='/api/task-shell-tasks/tsk_fixture/messages':
   sent.append(body);mid=body['clientMsgId'];r={'taskId':'tsk_fixture','receiptId':'receipt_'+mid};receipts.append({'id':r['receiptId'],'taskId':'tsk_fixture','clientMsgId':mid,'status':'accepted'})
   messages.extend([{'id':'user_'+mid,'role':'user','content':body['text']},{'id':'assistant_'+mid,'role':'assistant','content':'已按要求整理，名单以工作台保存版本为准。'}]);value=r
   if control['dropNext']:
    control['dropNext']=False;route.abort('failed');return
  elif url=='/api/sessions/session_fixture':
   if request.method=='PATCH':runtime.update(body)
   value=runtime
  elif url=='/api/sessions/session_fixture/switch-cli':runtime['cli']=body['cli'];value={'ok':True}
  else:
   raise AssertionError('出现未授权请求：'+url)
  route.fulfill(status=status,body=json.dumps(value,ensure_ascii=False),content_type='application/json')
 try:
  with sync_playwright() as pw:
   browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('GAPAW_TEST_CHROME','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),args=['--disable-gpu'])
   page=browser.new_page(viewport={'width':1440,'height':1080});page.on('pageerror',lambda e:errors.append(str(e)));page.route('**/*',respond)
   page.goto('https://plugin.test/plugins/gapaw-creator-workbench/ui/selection.html')
   expect(page.locator('#send')).to_be_disabled()
   page.locator('#runtime').click();page.locator('#runtime-cli').select_option('codex-exp');expect(page.locator('#runtime-provider option')).to_have_count(1)
   page.locator('#dialog-foot button').last.click();expect(page.locator('#runtime-label')).to_contain_text('fixture-model')
   page.locator('#workspace-pill').click();page.locator('#dialog-foot button').last.click();expect(page.locator('#workspace-label')).to_have_text('运营目录已就绪')
   page.locator('#browser-pill').click();page.locator('#profile-picker').select_option('alpha');page.locator('#bind-profile').click();expect(page.locator('#browser-label')).to_have_text('测试专用实例')
   expect(page.locator('#kalo-label')).to_have_text('Kalodata · 已登录');expect(page.locator('#dialog-body input')).to_have_count(0)
   page.locator('#close-dialog').click();expect(page.locator('#send')).to_be_enabled()
   page.locator('#input').fill('找适合宠物用品的达人');page.locator('#send').click();expect(page.locator('#host-task')).to_be_visible()
   op=run('selection-status')['operation'];assert op['task']['taskId']=='tsk_fixture'
   first={'operationId':op['id'],'taskId':'tsk_fixture','turnId':op['dispatch']['message']['clientMsgId'],'resultId':'result_first','expectedRevision':0,'parentRevision':0,'list':{'schemaVersion':1,'criteria':'首轮合成名单','candidates':[candidate('a','1234'),candidate('b',None)]}}
   run('selection-submit-list',first);page.locator('#refresh').click();expect(page.locator('#list-count')).to_have_text('2')
   execution.update({'pending':{'requestId':'question_fixture','taskId':'tsk_fixture','resolved':False},'turnId':'host_turn_fixture','busy':False});control['dropNext']=True
   page.locator('#input').fill('保留内容最匹配的');page.locator('#send').click();expect(page.locator('#notice')).to_contain_text('网络连接失败');page.locator('#retry').click();expect(page.locator('#conversation')).to_contain_text('保留内容最匹配的')
   assert sent[-1]['intent']=='answer' and sent[-1]['requestId']=='question_fixture' and sent[-1]['taskId']=='tsk_fixture';assert len(sent)==2
   execution.clear();execution['busy']=False
   turns=run('selection-status')['turns'];assert len(turns)==2;assert len([r for r in requests if r[1]=='/api/air/tasks'])==1
   second={**first,'turnId':turns[-1]['id'],'resultId':'result_second','expectedRevision':1,'parentRevision':1,'list':{**first['list'],'criteria':'收窄名单','candidates':[candidate('a','1234')]}}
   run('selection-submit-list',second);page.locator('#refresh').click();expect(page.locator('#versions button')).to_have_count(2)
   page.locator('#compare').click();expect(page.locator('#dialog-body')).to_contain_text('移除 1 位');page.locator('#close-dialog').click()
   page.locator('#versions button').last.click();expect(page.locator('#list-count')).to_have_text('2');page.locator('#continue-version').click();expect(page.locator('#base-note')).to_contain_text('第 1 版')
   page.locator('#people input').nth(0).check();page.locator('#people input').nth(1).check();page.locator('#adopt').click();expect(page.locator('#dialog-body')).to_contain_text('暂不合并');page.locator('#dialog-foot button').last.click();expect(page.locator('#list-status')).to_contain_text('已采用 1 位')
   assert run('local-workbench-status')['counts']['creators']==1
   page.locator('#input').fill('刷新后保留的输入');page.reload();expect(page.locator('#input')).to_have_value('刷新后保留的输入');expect(page.locator('#versions button')).to_have_count(2)
   page.locator('#runtime').click();page.locator('#runtime-model').select_option('fixture-model-2');page.locator('#dialog-foot button').last.click();expect(page.locator('#runtime-label')).to_contain_text('fixture-model-2');assert runtime['model']=='fixture-model-2'
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   page.screenshot(path='/tmp/gapaw-selection-live-desktop.png',full_page=True)
   page.set_viewport_size({'width':390,'height':844});page.locator('#mobile-list').click();expect(page.locator('#list-panel')).to_be_visible();expect(page.locator('#chat-panel')).not_to_be_visible();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');page.screenshot(path='/tmp/gapaw-selection-live-mobile.png',full_page=True)
   page.set_viewport_size({'width':1440,'height':1080});page.locator('#mobile-chat').evaluate('(e)=>e.click()')
   Catalog.signed_out=True
   page.locator('#browser-pill').click();page.get_by_role('button',name='重新检查',exact=True).click();expect(page.locator('#kalo-label')).to_contain_text('待登录');page.locator('#close-dialog').click();expect(page.locator('#send')).to_be_disabled()
   cid=run('selection-status')['adoptions'][0]['accepted'][0]['creatorId']
   assert run('workbench-home')['items'],run('outreach-status')
   assert run('workbench-creator',{'creatorId':cid})['profile']['selectionSnapshot']['revision']==1
   page.goto('https://plugin.test/plugins/gapaw-creator-workbench/ui/index.html#module=selection&creator='+cid)
   expect(page.locator('#wb-detail')).to_contain_text('已采用的选人资料 · 第 1 版');expect(page.locator('#wb-detail')).to_contain_text('粉丝数未知')
   page.locator('[data-module="cooperation"]').click();expect(page.locator('[data-module-panel="cooperation"] select').first).to_have_value('')
   assert errors==[],errors
   browser.close()
   print('正式选人页隔离端到端通过：真实Rust持久化、配置胶囊、自动登录检查、同任务两轮对话、自动读回版本、版本比较、旧版继续、部分采用、刷新恢复及390px布局；无脚本错误。')
 finally:
  server.shutdown();server.server_close();thread.join();shutil.rmtree(workspace)
