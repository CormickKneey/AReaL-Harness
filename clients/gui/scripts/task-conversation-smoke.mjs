// 真实 Electron / Desktop adapter / Core；模型响应确定化，所有状态与权限来自生产路径。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rmdir,writeFile,readFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const gui=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(gui,'app/package.json'));
const {_electron:electron}=require('playwright-core');
const binary=process.env.AREAL_CORE_BIN || resolve(gui,'../../target/debug/areal');
const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
const scratch=await mkdtemp('/private/tmp/areal-schedule-desktop-');
const loadingRegression=process.env.AREAL_TASK_LOADING_REGRESSION==='1';
const loadingGate=join(scratch,'hold-project'), loadingTrace=join(scratch,'loading-trace.log'), prepareFailureGate=join(scratch,'fail-projectless-prepare');
const watchGates=[];
let launchApp=process.env.AREAL_GUI_TEST_APP_DIR || join(gui,'app');
const workspace=join(scratch,'workspace'), userHome=join(scratch,'user');
await mkdir(workspace); await mkdir(join(userHome,'.areal'),{recursive:true});
const taskDirectory=join(workspace,'task-working-directory'), independentDirectory=join(scratch,'independent-working-directory');
await mkdir(taskDirectory);await mkdir(independentDirectory);
execFileSync('git',['init','-b','main'],{cwd:workspace,stdio:'ignore'});
const errors=[],checks=[],modelRequests=[],held=new Set();
const pastDailyAnchor=new Date(Date.now()-86400000).toISOString().replace(/\.\d{3}Z$/,'Z');
const changedAnchor=new Date(Date.now()+172800000).toISOString().replace(/\.\d{3}Z$/,'Z');
const blockedOnce=new Set();
const text=message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('\n');
const model=createServer(async(request,response)=>{
 try {
  assert.equal(request.headers.authorization,'Bearer task-fixture-key','every scheduled model request carries its configured credential');
  let raw='';for await(const chunk of request)raw+=chunk;
  const body=JSON.parse(raw),messages=body.messages??[];
  modelRequests.push(body);
  if(body.stream===false){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{role:'assistant',content:'OK'}}]}));return;}
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(delta,reason=null)=>response.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:reason}]})}\n\n`);
  const end=()=>{response.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\n`);response.end('data: [DONE]\n\n');};
  const finish=content=>{send({content});send({},'stop');end();};
  const tool=(name,args)=>{send({tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]});send({},'tool_calls');end();};
  if(messages.some(m=>text(m).includes('AREAL_TASK_DRAFT'))) {
   const last=messages.filter(m=>m.role==='user'&&!text(m).startsWith('AReaL runtime context')).at(-1);
   const requestText=text(last??{});
   if(requestText.includes('过去的每日时间')){finish(JSON.stringify({kind:'proposal',message:'已保存每日任务。',objective:'过去的每日时间 SCHEDULE_FIXTURE_COMPLETE',interactionMode:'interactive',schedule:{at:pastDailyAnchor,intervalSeconds:86400}}));return;}
   if(requestText.includes('明确改为一次')){finish(JSON.stringify({kind:'proposal',message:'已保存一次性任务。',schedule:{at:changedAnchor,intervalSeconds:null}}));return;}
   if(requestText.includes('过去的一次性时间')){finish(JSON.stringify({kind:'proposal',message:'已保存过期的一次性任务。',schedule:{at:pastDailyAnchor,intervalSeconds:null}}));return;}
   if(requestText.includes('旧项目目录验收')){finish(JSON.stringify({kind:'proposal',message:'已保存旧项目任务。',objective:'旧项目目录验收 SCHEDULE_FIXTURE_COMPLETE',interactionMode:'interactive',schedule:{at:changedAnchor}}));return;}
   if(requestText.includes('独立目录验收')){finish(JSON.stringify({kind:'proposal',message:'已保存独立任务。',objective:'独立目录验收 SCHEDULE_FIXTURE_COMPLETE',interactionMode:'interactive',schedule:{at:new Date(Date.now()+4000).toISOString().replace(/\.\d{3}Z$/,'Z'),intervalSeconds:8}}));return;}
   if(requestText.includes('只修改时刻')){finish(JSON.stringify({kind:'proposal',message:'已更新并保存执行时间。',schedule:{at:changedAnchor}}));return;}
   if(requestText.includes('保存失败')){finish(JSON.stringify({kind:'proposal',message:'已保存修改，已更新执行时间。',schedule:{at:'broken'}}));return;}
   if(requestText.includes('没有时间')){finish(JSON.stringify({kind:'question',message:'你希望什么时候执行？'}));return;}
   if(requestText.includes('取消任务')){finish(JSON.stringify({kind:'control',message:'将取消任务并保留历史。',action:'cancel'}));return;}
   if(requestText.includes('暂停')){finish(JSON.stringify({kind:'control',message:'将暂停后续执行。',action:'pause'}));return;}
   if(requestText.includes('恢复')){finish(JSON.stringify({kind:'control',message:'将恢复后续执行。',action:'resume'}));return;}
   if(requestText.includes('更新描述')){finish(JSON.stringify({kind:'proposal',message:'将只汇报阻塞项。',objective:'只汇报阻塞项 SCHEDULE_FIXTURE_COMPLETE'}));return;}
   if(requestText.includes('不合法')){finish(JSON.stringify({kind:'proposal',message:'将修改时间。',schedule:{at:'broken'}}));return;}
   if(requestText.includes('稍后')){await new Promise(resolve=>setTimeout(resolve,1500));}
   finish(JSON.stringify({kind:'proposal',message:'每次运行会创建新会话。',objective:'检查项目提交和 PR SCHEDULE_FIXTURE_COMPLETE',interactionMode:'interactive',schedule:{at:new Date(Date.now()+12000).toISOString().replace(/\.\d{3}Z$/,'Z'),intervalSeconds:8}}));return;
  }
  const contexts=messages.map(text).filter(t=>t.includes('Current authoritative goal: '));
  const goalView=JSON.parse(contexts.at(-1).split('Current authoritative goal: ').at(-1));
  const goal=goalView.goal;
  if(goal.limitsPending){tool('goal_set_limits',{expectedRevision:goalView.revision,sources:{}});return;}
  if(goal.objective.includes('READ_RESUME')&&!blockedOnce.has(goal.id)) {
   blockedOnce.add(goal.id);await new Promise(resolve=>setTimeout(resolve,1500));
   tool('goal_update',{expectedRevision:goalView.revision,status:'blocked',summary:'Earlier Turn finished; waiting for explicit resume.',evidence:['Fixture reached its decision boundary.'],remaining:['Resume explicitly'],blocker:'Explicit user decision'});return;
  }
  if(goal.objective.includes('READ_RESUME')&&goal.report?.status==='blocked'&&goal.reportTurnId===goal.activeTurnId){finish('Earlier Turn complete; explicit resume required.');return;}
  if(goal.objective.includes('HOLD')){send({content:'运行中，等待用户停止。'});held.add(response);response.on('close',()=>held.delete(response));return;}
  const lastUser=messages.findLastIndex(m=>m.role==='user'&&!text(m).startsWith('AReaL runtime context'));
  if(goal.objective.includes('APPROVAL')&&!messages.slice(lastUser+1).some(m=>(m.tool_calls??[]).some(c=>c.function?.name==='fs_create'))){tool('fs_create',{path:`workspace://repo/approval-${randomUUID()}.txt`,text:'approved'});return;}
  if(goal.report?.status==='complete'){finish('SCHEDULE_FIXTURE_DONE');return;}
  tool('goal_update',{expectedRevision:goalView.revision,status:'complete',summary:'SCHEDULE_FIXTURE_DONE',evidence:['Deterministic fixture completed its requested response.'],remaining:[]});
 }catch(error){errors.push(error.stack);response.destroy(error);}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
await writeFile(join(userHome,'.areal/config.toml'),`schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\napi_key_env="AREAL_CREDENTIAL_task_fixture"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\nask=["fs_create"]\n`);
const deployment=join(scratch,'desktop.json');
await writeFile(deployment,JSON.stringify({profiles:[{id:'standard',revision:'v1',displayName:'Fixture',instructions:'Complete the requested fixture.',approvalTools:['fs_create']}]}));
const env={...process.env,AREAL_GUI_USER_DATA:join(scratch,'electron'),AREAL_CORE_HOME:join(scratch,'core'),AREAL_CORE_USER_HOME:userHome,AREAL_HARNESS_SERVICE_HOME:join(scratch,'registry'),AREAL_CORE_DESKTOP_CONFIG:deployment,AREAL_CORE_BIN:binary,AREAL_CREDENTIAL_task_fixture:'task-fixture-key'};
for(const key of ['AREAL_CORE_WORKSPACE','AREAL_CORE_CONFIG','AREAL_HARNESS_HOME','AREAL_HARNESS_CONFIG'])delete env[key];
let app,page,pid,workspacePid,taskCwd,passed=false;
async function until(fn,label,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,150));}throw Error(`Timeout: ${label}`);}
const snapshot=()=>page.evaluate(()=>window.arealDesktop.snapshot());
async function call(name,params){const reply=await page.evaluate(({name,params})=>window.arealDesktop.command(name,params),{name,params});assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;}
const task=id=>call('manage',{projectId:pid,operation:'task',taskId:id});
const control=async(id,operation,runId)=>{const current=await task(id);return call('manage',{projectId:pid,operation,taskId:id,expectedRevision:current.revision,...(runId?{expectedRunId:runId}:{})});};
async function assertGlobalCreation(){
 const main=page.getByRole('main',{name:'新建定时任务',exact:true});
 await main.waitFor();
 assert.equal(await main.getByLabel('任务归属',{exact:true}).count(),0,'new task has no project affiliation selector');
 assert.equal(await main.getByLabel('工作目录',{exact:true}).count(),0,'new task has no working directory field');
 assert.equal(await main.getByRole('button',{name:'开始配置',exact:true}).count(),0,'new task requires no start-configuration gate');
 assert.equal(await main.locator('.task-plan-summary').count(),0);
 const chat=page.getByTestId('chat-input');await chat.waitFor();await until(()=>chat.isEditable(),'automatic independent configuration Composer ready');
 const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),`areal-gui:task-draft:${workspacePid}`);
 const owner=(await snapshot()).projects.find(project=>project.id===saved.ownerId);
 assert.equal(owner.projectless,true);
 assert.notEqual(owner.id,workspacePid);
 assert.notEqual(owner.root,workspace);
 assert.notEqual(owner.root,taskDirectory);
 const draft=await call('manage',{projectId:owner.id,operation:'taskDraftRead',threadId:saved.threadId});
 assert.equal(draft.thread.cwd,owner.root);
 return {saved,owner,draft};
}
async function launch(){app=await electron.launch({executablePath:process.env.AREAL_ELECTRON_EXECUTABLE||require('electron'),args:[launchApp],env,timeout:120000});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.show();window.focus();});await page.bringToFront();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.getByTestId('areal-workbench').waitFor({timeout:120000});await until(async()=>(await snapshot()).connection?.state==='ready','adapter ready');}
if(loadingRegression){
 launchApp=join(scratch,'app');await mkdir(launchApp);
 await writeFile(join(launchApp,'package.json'),JSON.stringify({name:'task-loading-fixture',main:'bootstrap.cjs'}));
 await writeFile(join(launchApp,'bootstrap.cjs'),`
const {CoreBackend}=require(${JSON.stringify(join(gui,'app/src/core/backend.cjs'))});
const {existsSync,appendFileSync,unlinkSync}=require('node:fs');
const {join}=require('node:path');
const start=CoreBackend.prototype.start, execute=CoreBackend.prototype.executeCommand;
CoreBackend.prototype.start=async function(id){
 const project=this.saved.find(project=>project.id===id);
 if(project?.root.endsWith('slow-workspace')&&existsSync(${JSON.stringify(loadingGate)})){
  appendFileSync(${JSON.stringify(loadingTrace)},'project pending\\n');
  while(existsSync(${JSON.stringify(loadingGate)}))await new Promise(resolve=>setTimeout(resolve,50));
 }
 return start.call(this,id);
};
CoreBackend.prototype.executeCommand=async function(name,request,context){
 if(name==='projectless'&&request.operation==='prepare'){
  appendFileSync(${JSON.stringify(loadingTrace)},'projectless prepare '+request.requestId+'\\n');
  if(existsSync(${JSON.stringify(prepareFailureGate)})){
   unlinkSync(${JSON.stringify(prepareFailureGate)});
   throw new Error('独立任务初始化验收失败，请重试。');
  }
 }
 if(name==='manage'&&request.operation==='taskDraftStart')appendFileSync(${JSON.stringify(loadingTrace)},'draft start '+request.projectId+' '+request.draftId+'\\n');
 const result=await execute.call(this,name,request,context);
 if(name==='manage'&&request.operation==='taskWatch'){
  const gate=join(${JSON.stringify(scratch)},'watch-'+request.taskId);
  if(existsSync(gate)){
   appendFileSync(${JSON.stringify(loadingTrace)},'watch pending '+request.taskId+'\\n');
   while(existsSync(gate))await new Promise(resolve=>setTimeout(resolve,50));
   appendFileSync(${JSON.stringify(loadingTrace)},'watch returned '+request.taskId+'\\n');
  }
 }
 return result;
};
require(${JSON.stringify(join(gui,'app/src/main.cjs'))});
`);
}
async function checkLoadingRegression(){
 const slow=join(scratch,'slow-workspace');await mkdir(slow);
 await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},slow);
 await page.evaluate(()=>window.arealDesktop.chooseProject());
 const slowProject=await until(async()=>(await snapshot()).projects.find(p=>p.root===slow&&p.state?.connected),'second project ready');
 const create=objective=>call('manage',{projectId:pid,operation:'taskCreate',mode:'scheduled',objective,interactionMode:'interactive',schedule:{at:Math.floor(Date.now()/1000)+86400,timeZone:'Asia/Shanghai'}});
 const first=await create('READY_TASK_FIRST'), second=await create('READY_TASK_SECOND');
 for(const entry of [first,second]){const gate=join(scratch,'watch-'+entry.id);watchGates.push(gate);await writeFile(gate,'hold');}
 await writeFile(loadingGate,'hold');
 await page.getByRole('button',{name:'定时任务',exact:true}).click();
 const traced=async value=>(await readFile(loadingTrace,'utf8').catch(()=>'' )).includes(value);
 await until(()=>traced('project pending'),'global catalog waits on unrelated project');
 assert.equal((await snapshot()).projects.find(p=>p.id===pid).state.tasks[first.id].objective,'READY_TASK_FIRST');
 await page.getByText('其余任务仍在读取…',{exact:true}).waitFor();
 assert.equal(await page.getByText('没有符合筛选条件的定时任务。',{exact:true}).count(),0);
 assert.equal(await page.getByText('正在读取任务…',{exact:true}).count(),0);
 await page.getByRole('button',{name:'打开自动化 READY_TASK_FIRST',exact:true}).click();
 await until(()=>traced('watch pending '+first.id),'first subscription receipt held');
 assert.equal(await page.getByTestId('chat-input').count(),0,'pending subscription cannot start management Composer');
 assert.equal(await page.locator('.task-plan-summary').count(),0,'existing management loading has no environment banner');
 await page.getByRole('button',{name:'打开自动化 READY_TASK_SECOND',exact:true}).click();
 await until(()=>traced('watch pending '+second.id),'second subscription receipt held');
 await rm(watchGates[0]);
 await until(()=>traced('watch returned '+first.id),'first receipt arrives after selection changed');
 await call('manage',{projectId:pid,operation:'task',taskId:first.id});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.getByRole('main',{name:'定时任务会话'}).getByText('正在读取会话…',{exact:false}).waitFor();
 assert.equal(await page.getByTestId('chat-input').count(),0,'late first receipt cannot enable second task Composer');
 await rm(watchGates[1]);
 const chat=page.getByTestId('chat-input');await chat.waitFor();
 await until(()=>chat.isEditable(),'selected task Composer enabled by its own receipt');
 assert.equal(await page.locator('.task-plan-summary').count(),0);
 await chat.fill('检查现有任务，没有时间。');await page.getByTestId('chat-send-button').click();
 await page.getByText('你希望什么时候执行？',{exact:true}).waitFor();
 const management=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),`areal-gui:task-edit:${pid}:${second.id}`);
 assert.equal((await call('manage',{projectId:pid,operation:'taskDraftRead',threadId:management.threadId})).thread.cwd,workspace);
 await page.getByText('其余任务仍在读取…',{exact:true}).waitFor();
 await page.screenshot({path:join(scratch,'ready-task-while-catalog-pending.png')});
 checks.push('ready task opens and sends through Composer before unrelated catalog returns; pending and stale subscription receipts do not enable management');
 await page.evaluate(projectId=>{window.loadingRegressionCreation=window.arealDesktop.command('manage',{projectId,operation:'taskCreate',mode:'scheduled',objective:'DELAYED_OWNER_TASK',interactionMode:'interactive',schedule:{at:Math.floor(Date.now()/1000)+86400,timeZone:'Asia/Shanghai'}});},slowProject.id);
 assert.equal(await page.getByRole('button',{name:'打开自动化 DELAYED_OWNER_TASK',exact:true}).count(),0);
 await rm(loadingGate);
 assert.equal((await page.evaluate(()=>window.loadingRegressionCreation)).ok,true);
 await page.getByRole('button',{name:'打开自动化 DELAYED_OWNER_TASK',exact:true}).waitFor();
 await until(async()=>await page.getByText('其余任务仍在读取…',{exact:true}).count()===0,'global catalog completes after release');
 checks.push('delayed owner tasks appear after release without a false global empty state');
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 const retainedId=randomUUID(),retainedText='保留初始化失败前的任务描述';
 await page.evaluate(({projectId,cwd,draftId,text})=>localStorage.setItem(`areal-gui:task-draft:${projectId}`,JSON.stringify({draftId,location:{kind:'project',projectId,cwd},text})),{projectId:workspacePid,cwd:taskDirectory,draftId:retainedId,text:retainedText});
 await writeFile(prepareFailureGate,'fail once');
 await page.getByRole('button',{name:'新建自动化',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'独立任务初始化验收失败，请重试。'}).waitFor();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByTestId('chat-input').count(),0);
 const failed=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),`areal-gui:task-draft:${workspacePid}`);
 assert.equal(failed.draftId,retainedId);assert.equal(failed.text,retainedText);assert.equal(failed.location.kind,'independent');
 assert.equal((await readFile(loadingTrace,'utf8')).split('projectless prepare '+retainedId).length-1,1,'failed prepare waits for explicit retry');
 await page.getByRole('button',{name:'重试',exact:true}).click();
 const created=await assertGlobalCreation();
 assert.equal(created.saved.draftId,retainedId);
 assert.equal(created.saved.location.kind,'independent');
 assert.equal((await page.getByTestId('chat-input').textContent()).trim(),retainedText);
 assert.equal((await readFile(loadingTrace,'utf8')).split('projectless prepare '+retainedId).length-1,2,'explicit retry prepares the same independent draft');
 checks.push('legacy unadmitted draft keeps text and independent location through prepare failure; only explicit Retry admits the same draft independently');
 checks.push('new task opens directly in an independent Composer without project, directory or start controls');
 await page.getByRole('button',{name:'关闭创建对话',exact:true}).click();
 const key=`areal-gui:task-draft:${workspacePid}`;
 await page.evaluate(({key,saved})=>localStorage.setItem(key,JSON.stringify({...saved,threadId:undefined})),{key,saved:created.saved});
 await page.getByRole('button',{name:'新建自动化',exact:true}).click();
 const recovered=await assertGlobalCreation();
 assert.equal(recovered.saved.draftId,created.saved.draftId);
 assert.equal(recovered.saved.ownerId,created.saved.ownerId);
 assert.equal(recovered.saved.threadId,created.saved.threadId);
 assert.equal(recovered.draft.thread.cwd,created.owner.root);
 checks.push('prepared independent owner retries the same draft identity and recovers its original Thread');
 await page.getByRole('button',{name:'关闭创建对话',exact:true}).click();
 await page.evaluate(({key,saved})=>localStorage.setItem(key,JSON.stringify({...saved,threadId:undefined,pending:'start'})),{key,saved:created.saved});
 const startsBefore=(await readFile(loadingTrace,'utf8')).split('draft start ').length;
 await page.getByRole('button',{name:'新建自动化',exact:true}).click();
 await page.getByText('提交结果尚未确认，请核对当前任务；不会自动重复提交。',{exact:false}).waitFor();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByTestId('chat-input').count(),0);
 assert.equal((await readFile(loadingTrace,'utf8')).split('draft start ').length,startsBefore,'pending draft does not resubmit configuration admission');
 const pending=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
 assert.equal(pending.ownerId,created.saved.ownerId);
 assert.equal(pending.draftId,created.saved.draftId);
 assert.equal(pending.pending,'start');
 checks.push('admitted pending draft keeps its owner and request identity without automatic replay');
 assert.deepEqual(errors,[]);
}
try{
 await launch();
 await app.evaluate(({dialog,BrowserWindow},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});BrowserWindow.getAllWindows()[0].setSize(1488,1056);},workspace);
 await page.evaluate(()=>window.arealDesktop.chooseProject());
 pid=(await until(async()=>(await snapshot()).projects.find(p=>p.root===workspace&&p.state?.connected),'project ready')).id;
 workspacePid=pid;
 if(loadingRegression){await checkLoadingRegression();passed=true;}else{
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'外观',exact:true}).click();
 await page.getByRole('combobox',{name:'界面主题',exact:true}).click();
 await page.getByRole('option',{name:'浅色',exact:true}).click();
 await until(()=>page.locator('html').evaluate(el=>el.classList.contains('theme-areal-light')&&!el.classList.contains('dark')),'light theme');
 await page.getByRole('button',{name:'定时任务',exact:true}).click();
 assert.equal(await page.getByLabel('筛选任务归属',{exact:true}).count(),0,'task directory has no workspace filter');
 const retainedId=randomUUID(),retainedText='保留的任务描述';
 await page.evaluate(({projectId,cwd,draftId,text})=>localStorage.setItem(`areal-gui:task-draft:${projectId}`,JSON.stringify({draftId,location:{kind:'project',projectId,cwd},text})),{projectId:workspacePid,cwd:taskDirectory,draftId:retainedId,text:retainedText});
 await page.getByRole('button',{name:'新建自动化',exact:true}).click();
 const creation=await assertGlobalCreation();
 pid=creation.owner.id;taskCwd=creation.owner.root;
 assert.equal(creation.saved.draftId,retainedId);
 assert.equal((await page.getByTestId('chat-input').textContent()).trim(),retainedText);
 assert.equal(creation.saved.location.kind,'independent');
 checks.push('unadmitted legacy draft retains identity and text while new task admission ignores the active project and cwd');
 let chat=page.getByTestId('chat-input');
 assert.equal(await page.locator('.task-management-composer').count(),0);
 assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.locator('[data-v4-composer-dock]').count(),1);
 await page.screenshot({path:join(scratch,'task-create-light.png')});
 async function send(message){await chat.fill(message);await page.getByTestId('chat-send-button').click();}
 await send('检查项目提交和 PR，没有时间。');
 await page.getByText('你希望什么时候执行？',{exact:true}).waitFor();
 assert.equal((await call('tasks',{operation:'list'})).data.length,0);
 if(process.env.AREAL_TASK_SCHEDULE_REGRESSION==='1'){
  await send('过去的每日时间，请每天继续执行。');
  const recurring=await until(async()=>(await call('tasks',{operation:'list'})).data.find(t=>t.objective.includes('过去的每日时间')),'past recurring anchor advances to a future execution',6000);
  assert.equal(recurring.projectId,pid);
  assert.equal(recurring.scope,'independent');
  const history=await call('manage',{projectId:pid,operation:'taskDraftHistory',taskId:recurring.id});
  const draft=await call('manage',{projectId:pid,operation:'taskDraftRead',threadId:history.threadId});
  assert.equal(draft.thread.cwd,taskCwd);
  checks.push('global creation binds its management Thread to the independent owner directory');
  assert.equal(recurring.schedule.intervalSeconds,86400);
  assert.ok(recurring.schedule.at>Date.now()/1000);
  assert.ok(recurring.schedule.at<=Date.now()/1000+86400,'daily recurrence chooses the next occurrence');
  assert.equal((recurring.schedule.at-Date.parse(pastDailyAnchor)/1000)%86400,0);
  await writeFile(join(scratch,'recurring-task.json'),JSON.stringify(recurring,null,2));
  await chat.waitFor();
  assert.equal(await page.locator('.task-plan-summary').count(),0,'saved task conversation has no environment banner');
  await page.screenshot({path:join(scratch,'recurring-normalized.png')});
  checks.push('past recurring anchor advances to a future execution');
  await send('只修改时刻，保留每日频率。');
  const changed=await until(async()=>{const value=await task(recurring.id);return value.schedule.at===Date.parse(changedAnchor)/1000&&value;},'time-only edit is saved');
  assert.equal(changed.schedule.intervalSeconds,86400);
  await writeFile(join(scratch,'edited-task.json'),JSON.stringify(changed,null,2));
  checks.push('time-only edit retains the daily interval in authoritative Core state');
  const beforeRejected=JSON.stringify(changed.schedule);
  await send('保存失败，不合法的时间。');
  await page.getByRole('alert').filter({hasText:'时间'}).first().waitFor();
  assert.equal(JSON.stringify((await task(recurring.id)).schedule),beforeRejected);
  assert.equal(await page.getByText('已保存修改，已更新执行时间。',{exact:true}).count(),0);
  await page.screenshot({path:join(scratch,'rejected-save.png')});
  checks.push('rejected proposal preserves saved schedule and suppresses model success claim');
  await send('过去的一次性时间。');
  await page.getByRole('alert').filter({hasText:'计划时间已过'}).first().waitFor();
  assert.equal(JSON.stringify((await task(recurring.id)).schedule),beforeRejected);
  assert.equal(await page.getByText('已保存过期的一次性任务。',{exact:true}).count(),0);
  checks.push('past one-time schedule is rejected without changing the saved task');
  await send('明确改为一次，在新时间执行。');
  const once=await until(async()=>{const value=await task(recurring.id);return value.revision>changed.revision&&value.schedule.intervalSeconds==null&&value;},'explicit one-time edit clears interval');
  assert.equal(once.schedule.at,Date.parse(changedAnchor)/1000);
  checks.push('explicit one-time edit clears the interval without treating omitted frequency as a change');
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
  const rejected=await page.evaluate(({projectId,cwd,draftId})=>window.arealDesktop.command('manage',{projectId,operation:'taskDraftStart',draftId,cwd,timeZone:'Asia/Shanghai'}),{projectId:workspacePid,cwd:independentDirectory,draftId:randomUUID()});
  assert.equal(rejected.ok,false);assert.match(rejected.error.message,/目录/);
  const collision=await page.evaluate(({directory,requestId})=>window.arealDesktop.command('projectless',{operation:'prepare',directory,requestId}),{directory:workspace,requestId:randomUUID()});
  assert.equal(collision.ok,false);assert.match(collision.error.message,/已有项目/);
  assert.equal((await snapshot()).projects.find(p=>p.id===workspacePid).projectless,undefined);
  checks.push('production bridge preserves project directory containment and rejects independent reclassification of an existing project');
  const legacyStart=await call('manage',{projectId:workspacePid,operation:'taskDraftStart',draftId:randomUUID(),cwd:taskDirectory,timeZone:'Asia/Shanghai'});
  await call('manage',{projectId:workspacePid,operation:'taskDraftSend',threadId:legacyStart.threadId,text:'旧项目目录验收，明天执行。',timeZone:'Asia/Shanghai'});
  const legacyProposal=await until(async()=>{const value=await call('manage',{projectId:workspacePid,operation:'taskDraftRead',threadId:legacyStart.threadId});return !value.running&&value.proposal&&value;},'legacy bound fixture proposal');
  const legacy=await call('manage',{projectId:workspacePid,operation:'taskDraftConfirm',threadId:legacyStart.threadId,turnId:legacyProposal.turnId,digest:legacyProposal.digest});
  const legacyHistory=await call('manage',{projectId:workspacePid,operation:'taskDraftHistory',taskId:legacy.id});
  assert.equal(legacyHistory.threadId,legacyStart.threadId);
  await page.getByRole('button',{name:`打开自动化 ${legacy.objective}`,exact:true}).click();
  await chat.waitFor();await page.getByText('旧项目目录验收，明天执行。',{exact:true}).waitFor();
  assert.equal((await call('manage',{projectId:workspacePid,operation:'taskDraftRead',threadId:legacyHistory.threadId})).thread.cwd,taskDirectory);
  checks.push('existing project-bound task opens its original management Thread, cwd and history');
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
  await rmdir(taskDirectory);
  await page.evaluate(key=>localStorage.removeItem(key),`areal-gui:task-edit:${workspacePid}:${legacy.id}`);
  await page.getByRole('button',{name:`打开自动化 ${legacy.objective}`,exact:true}).click();
  await chat.waitFor();await page.getByText('旧项目目录验收，明天执行。',{exact:true}).waitFor();
  assert.equal((await call('manage',{projectId:workspacePid,operation:'taskDraftRead',threadId:legacyHistory.threadId})).thread.cwd,taskDirectory);
  checks.push('legacy management history remains available when its bound directory is missing');
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
  await page.getByRole('button',{name:'新建自动化',exact:true}).click();
  const next=await assertGlobalCreation();
  await chat.fill('独立目录验收，定时执行。');await page.getByTestId('chat-send-button').click();
  const independent=await until(async()=>(await call('tasks',{operation:'list'})).data.find(t=>t.objective.startsWith('独立目录验收')),'independent task created');
  assert.equal(independent.scope,'independent');
  assert.equal(independent.projectId,next.owner.id);
  await call('open',{projectId:independent.projectId,threadId:independent.threadId});
  assert.equal((await snapshot()).projects.find(p=>p.id===independent.projectId).state.threads[independent.threadId].cwd,next.owner.root);
  const executed=await until(async()=>{const value=await call('manage',{projectId:independent.projectId,operation:'task',taskId:independent.id});return value.runs.some(r=>r.status==='completed')&&value;},'independent task executes in its automatic directory');
  const executionId=executed.runs.find(r=>r.status==='completed').threadId;
  await call('open',{projectId:independent.projectId,threadId:executionId});
  assert.equal((await snapshot()).projects.find(p=>p.id===independent.projectId).state.threads[executionId].cwd,next.owner.root);
  await page.screenshot({path:join(scratch,'independent-task-saved.png')});
  checks.push('global task retains its automatic independent directory for owner, anchor and actual Run');
  for(const entry of [once,legacy,independent])assert.equal(await page.getByRole('button',{name:`打开自动化 ${entry.objective}`,exact:true}).count(),1);
  checks.push('global directory shows legacy project-bound tasks and independent tasks together without a workspace filter');
  passed=true;
 }else{
 await send('每天上午九点，稍后安排。');
 const created=await until(async()=>(await call('tasks',{operation:'list'})).data.find(t=>t.objective.includes('SCHEDULE_FIXTURE_COMPLETE')),'Agent created task');
 const taskId=created.id;
 let resources=page.getByRole('button',{name:'任务资源',exact:true});
 assert.equal(await page.getByLabel('任务资源面板').count(),0,'summary is closed initially');
 assert.equal(await page.locator('.task-resource-sidebar').count(),0,'no fixed sidebar');
 const closedWidth=(await chat.boundingBox()).width;
 await resources.click();await page.getByLabel('任务资源面板').waitFor();
 const openWidth=(await chat.boundingBox()).width;assert.ok(Math.abs(openWidth-closedWidth)<1,'popup does not reserve conversation width');
 assert.ok(!(await page.getByLabel('定时任务安排').innerText()).includes('下次：'));
 assert.ok(!(await page.getByLabel('定时任务安排').innerText()).includes('本机执行'));
 await resources.click();await until(async()=>await page.getByLabel('任务资源面板').count()===0,'same button closes popup');
 await resources.click();await page.getByLabel('任务资源面板').waitFor();
 await page.keyboard.press('Escape');await until(async()=>await page.getByLabel('任务资源面板').count()===0,'Escape closes popup');
 checks.push('existing task resource Popover: initially closed, click toggles, Escape dismisses, conversation width unchanged, summary omits execution metadata');
 await page.screenshot({path:join(scratch,'task-detail-closed.png')});
 await page.getByText(/^已创建任务。/).last().waitFor();
 const history=await call('manage',{projectId:pid,operation:'taskDraftHistory',taskId});
 const managementThread=history.threadId;
 assert.ok(managementThread);
 assert.equal((await call('manage',{projectId:pid,operation:'taskDraftRead',threadId:managementThread})).thread.cwd,taskCwd);
 assert.equal(created.scope,'independent');
 await call('open',{projectId:pid,threadId:created.threadId});
 assert.equal((await snapshot()).projects.find(project=>project.id===pid).state.threads[created.threadId].cwd,taskCwd);
 await send('更新描述，只汇报阻塞项。');
 await until(async()=>(await task(taskId)).objective.startsWith('只汇报阻塞项'),'Agent updated description');
 await resources.click();
 await page.getByLabel('定时任务安排').getByText('只汇报阻塞项 SCHEDULE_FIXTURE_COMPLETE',{exact:true}).waitFor();
 assert.equal((await call('manage',{projectId:pid,operation:'taskDraftHistory',taskId})).threadId,managementThread);
 const current=await task(taskId),scheduleBefore=JSON.stringify(current.schedule);
 await send('不合法的时间修改。');
 await page.getByRole('alert').filter({hasText:'时间'}).first().waitFor();
 assert.equal(JSON.stringify((await task(taskId)).schedule),scheduleBefore);
 await send('暂停任务。');
 await until(async()=>(await task(taskId)).paused,'Agent paused schedule');
 await send('恢复任务。');
 await until(async()=>(await task(taskId)).paused===false,'Agent resumed schedule');
 await resources.click();await page.getByLabel('任务资源面板').waitFor();
 await until(()=>page.getByLabel('任务资源面板').evaluate(el=>Number(getComputedStyle(el).opacity)>.99&&!el.hasAttribute('data-starting-style')),'light popup finished opening');
 await page.screenshot({path:join(scratch,'task-detail-light.png')});
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'外观',exact:true}).click();
 await page.getByRole('combobox',{name:'界面主题',exact:true}).click();
 await page.getByRole('option',{name:'深色',exact:true}).click();
 await until(()=>page.locator('html').evaluate(el=>el.classList.contains('dark')),'dark theme');
 await page.getByRole('button',{name:'定时任务',exact:true}).click();
 await resources.click();await page.getByLabel('定时任务安排').waitFor();
 await chat.waitFor();
 await until(()=>page.getByLabel('任务资源面板').evaluate(el=>Number(getComputedStyle(el).opacity)>.99&&!el.hasAttribute('data-starting-style')),'dark popup finished opening');
 await page.screenshot({path:join(scratch,'task-detail-dark.png')});
 const bounds=await page.getByTestId('chat-input').boundingBox();assert.ok(bounds.width>300);
 assert.equal(await page.getByRole('dialog').filter({has:page.getByLabel('定时任务安排')}).count(),1,'only the shared resource popup is open');
 assert.equal(await page.locator('.task-draft-dialog').count(),0);
 assert.equal(await page.locator('.messages-shell').count(),1);
 assert.equal(await page.locator('[data-v4-composer-dock]').count(),1);
 assert.ok(!(await page.locator('.messages-shell').innerText()).includes('"kind"'));
 checks.push('shared Messages and Composer; no task textarea/dialog; Agent clarification, creation, description update, failed proposal, pause/resume; same management Thread; light/dark');
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 await page.getByRole('button',{name:`打开自动化 ${(await task(taskId)).objective}`,exact:true}).click();
 await page.getByText('你希望什么时候执行？',{exact:true}).waitFor();
 await chat.waitFor();
 const reopened=await call('manage',{projectId:pid,operation:'taskDraftHistory',taskId});assert.equal(reopened.threadId,managementThread);
 assert.equal((await call('tasks',{operation:'list'})).data.length,1);
 checks.push('navigation restores full creation/modification history without duplicate task');
 await app.close();await launch();
 chat=page.getByTestId('chat-input');resources=page.getByRole('button',{name:'任务资源',exact:true});
 await page.getByRole('button',{name:'定时任务',exact:true}).click();
 await page.getByRole('button',{name:`打开自动化 ${(await task(taskId)).objective}`,exact:true}).click();
 await chat.waitFor();await page.getByText('你希望什么时候执行？',{exact:true}).waitFor();
 assert.equal((await call('manage',{projectId:pid,operation:'taskDraftHistory',taskId})).threadId,managementThread);
 assert.equal((await call('manage',{projectId:pid,operation:'taskDraftRead',threadId:managementThread})).thread.cwd,taskCwd);
 assert.equal((await snapshot()).projects.find(project=>project.id===pid).root,taskCwd);
 assert.equal((await call('tasks',{operation:'list'})).data.length,1);
 checks.push('desktop restart restores the same independent owner, management cwd and history without duplicate task');
 const runs=await until(async()=>{const value=await task(taskId);return value.runs.filter(r=>r.status==='completed').length>=2&&value.runs;},'two independent scheduled runs');
 assert.notEqual(runs[0].threadId,runs[1].threadId);assert.notEqual(runs[0].threadId,managementThread);
 for(const run of runs.slice(0,2)){
  await call('open',{projectId:pid,threadId:run.threadId});
  assert.equal((await snapshot()).projects.find(p=>p.id===pid).state.threads[run.threadId].cwd,taskCwd);
 }
 checks.push('scheduled runs retain independent execution Threads');
 checks.push('scheduled execution Threads retain the task independent directory after navigation and restart');
 await send('取消任务。');
 await until(async()=>(await task(taskId)).cancelled,'Agent cancelled schedule');
 await resources.click();
 await page.getByLabel('定时任务安排').getByText('已取消',{exact:true}).waitFor();
 assert.ok((await task(taskId)).runs.length>=2);
 checks.push('Agent cancellation preserves execution history');
 assert.deepEqual(errors,[]);passed=true;
 }
 }
}catch(error){
 if(page){await writeFile(join(scratch,'failure-state.json'),JSON.stringify(await snapshot(),null,2)).catch(()=>{});await writeFile(join(scratch,'failure.aria.txt'),await page.locator('body').ariaSnapshot()).catch(()=>{});await writeFile(join(scratch,'failure-ui.json'),JSON.stringify(await page.evaluate(()=>({focus:{tag:document.activeElement?.tagName,id:document.activeElement?.id,role:document.activeElement?.getAttribute('role'),label:document.activeElement?.getAttribute('aria-label')},hidden:document.hidden,options:[...document.querySelectorAll('[role=option]')].map(el=>({html:el.outerHTML,rect:el.getBoundingClientRect().toJSON(),visibility:getComputedStyle(el).visibility,display:getComputedStyle(el).display,opacity:getComputedStyle(el).opacity}))})),null,2)).catch(()=>{});await page.screenshot({path:join(scratch,'failure.png')}).catch(()=>{});}
 throw error;
}finally{
 await rm(loadingGate,{force:true});
 await rm(prepareFailureGate,{force:true});
 for(const gate of watchGates)await rm(gate,{force:true});
 for(const response of held)response.destroy();
 if(page && pid){
  try {
   const rows=await call('tasks',{operation:'list',limit:100});
   for(const entry of rows.data){if(!entry.cancelled)await call('manage',{projectId:entry.projectId,operation:'taskCancel',taskId:entry.id,expectedRevision:entry.revision}).catch(()=>{});}
   await until(async()=>{const state=await call('serviceStatus',{});return !state.busy&&!state.activeCommands;},'fixture cleanup',20000);
   await app.evaluate(({dialog})=>{const old=dialog.showMessageBox;dialog.showMessageBox=async(...args)=>args.at(-1).message==='停止共享后台服务？'?{response:1}:old(...args);});
   await call('stopService',{});
  }catch(error){errors.push(`cleanup: ${error.message}`);}
 }
 if(app)await app.close().catch(()=>{});
 model.closeAllConnections();await new Promise(resolve=>model.close(resolve));
 await writeFile(join(scratch,'evidence.json'),JSON.stringify({passed,binary,binarySha256,checks,errors,modelRequests:modelRequests.length},null,2));
 await writeFile(join(scratch,'model-requests.json'),JSON.stringify(modelRequests,null,2));
 await writeFile(join(scratch,'manifest.json'),JSON.stringify({passed,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:gui,encoding:'utf8'}).trim(),diff:execFileSync('git',['diff','--stat'],{cwd:gui,encoding:'utf8'}),binary,binarySha256,checks,errors,boundaries:['real isolated Electron, preload, Desktop adapter and Core','synthetic local model replies','native directory dialog result is stubbed','not installed app or real provider']},null,2));
 console.log(JSON.stringify({passed,scratch,checks,errors}));
}
