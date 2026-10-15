// Actual Electron/Core package workflow. External inference alone is deterministic.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {captureSmokeFailure,createProjectConversation,selectConversation} from './smoke-navigation.mjs';
const gui=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(join(gui,'app/package.json'));
const {_electron:electron}=require('playwright-core');
const scratch=await mkdtemp('/private/tmp/areal-plugin-uploads-'),workspace=join(scratch,'workspace'),userHome=join(scratch,'user');
await mkdir(join(workspace,'.agents','plugins'),{recursive:true});await mkdir(join(userHome,'.areal'),{recursive:true});
execFileSync('git',['init','-b','main'],{cwd:workspace,stdio:'ignore'});
// Failure boundaries recorded before upload implementation in /private/tmp/areal-uploads-plan.md:
// untrusted paths/field injection, picker cancel accidentally staging, directory confirmation
// cancel reaching server, stale owner/revocation granting access, UNKNOWN stage replay,
// original path leakage and server inability to read the accepted snapshot.
// Actual Core/Runtime and Electron execute; native dialog return values are scripted.
// Physical OS chooser interaction, remote upload is a separate acceptance gate; modern mode exercises two MRTR rounds.
const modern=process.env.AREAL_MCP_FORM_PROTOCOL==='modern';
const source=join(workspace,'packages','hello'),transportLog=join(scratch,'mcp.jsonl');
await mkdir(source,{recursive:true});
await writeFile(join(source,'plugin.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'hello',version:'1.0.0',description:'Desktop extension acceptance fixture.',extensions:{'com.openai':{interface:{displayName:'Extensions Fixture'}}}}));
const appHtml=`<!doctype html><html><body><h1>Uploads fixture</h1><output id="ready">waiting</output><output id="result"></output><button id="file">Request file</button><button id="directory">Request directory</button><script>
let seq=0;const pending=new Map();function call(method,params){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
addEventListener('message',event=>{if(event.source!==parent)return;const value=event.data;if(value.jsonrpc!=='2.0')return;const p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);}});
for(const kind of ['file','directory'])document.getElementById(kind).onclick=async()=>{document.getElementById('result').textContent='pending';try{document.getElementById('result').textContent=JSON.stringify(await call('tools/call',{name:'fixture.form',arguments:{kind}}));}catch(error){document.getElementById('result').textContent='ERROR: '+error.message;}};
call('ui/initialize',{appInfo:{name:'uploads-fixture',version:'1'},protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline','fullscreen']}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.getElementById('ready').textContent='initialized';});
</script></body></html>`;
await writeFile(join(source,'app.html'),appHtml);
const fixtureServer=String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const log=value=>appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(value)+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const readSelected=uri=>{if(!uri.startsWith('file://'))throw Error('Server did not receive readable snapshot URI');const path=fileURLToPath(uri);return statSync(path).isDirectory()?readdirSync(path,{recursive:true}).filter(name=>statSync(path+'/'+name).isFile()).map(name=>readFileSync(path+'/'+name,'utf8')):[readFileSync(path,'utf8')];};
log({event:'started'});const awaiting=new Map();let reverseId=0;const modern=process.env.FIXTURE_PROTOCOL==='modern';
const required=(key,state,message,schema)=>({resultType:'input_required',requestState:state,inputRequests:{[key]:{method:'elicitation/create',params:{mode:'form',message,requestedSchema:{type:'object',properties:{}},_meta:{'openai/elicitation':{requestedSchema:schema}}}}}});
const tools=[{name:'fixture.open',title:'Extension App',inputSchema:{type:'object'},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://fixture/uploads',visibility:['model']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},{name:'fixture.form',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['file','directory']}},required:['kind']},annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}}];
for await(const line of createInterface({input:process.stdin})){let q;try{q=JSON.parse(line);log({event:'wire',...q});if(!q.method){const call=awaiting.get(q.id);if(call){awaiting.delete(q.id);if(q.result?.action==='accept'){const uris=Array.isArray(q.result.content.upload)?q.result.content.upload:[q.result.content.upload];log({event:'snapshot-read',uris,texts:uris.flatMap(readSelected)});}send({jsonrpc:'2.0',id:call.id,result:{content:[{type:'text',text:'FORM_SETTLED_'+q.result?.action}]}});}continue;}if(q.id===undefined)continue;let result;
switch(q.method){case'server/discover':if(!modern){send({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not found'}});continue;}result={resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{},resources:{},extensions:{'io.modelcontextprotocol/ui':{}}},ttlMs:0,cacheScope:'private'};break;case'initialize':result={protocolVersion:q.params.protocolVersion,serverInfo:{name:'Uploads Fixture',version:'1'},capabilities:{tools:{},resources:{},extensions:{'io.modelcontextprotocol/ui':{}}}};break;
case'ping':result={};break;case'tools/list':result={tools};break;case'resources/list':result={resources:[]};break;case'resources/templates/list':result={resourceTemplates:[]};break;
case'resources/read':result={contents:[{uri:q.params.uri,mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};break;
case'tools/call':if(q.params.name==='fixture.open')result={content:[{type:'text',text:'APP_OPENED'}]};else if(q.params.name==='fixture.form'&&modern){
 const kind=q.params.arguments.kind,state=q.params.requestState;
 if(!state){const id=String(++reverseId);awaiting.set(id,{kind});log({event:'form-issued',id,callId:q.id,kind});result=required('upload','upload-'+id,'Fixture upload '+kind,{type:'object',properties:{upload:{type:'array',title:'Selected resources',items:{type:'string'},minItems:1,'x-openai-input':{type:'resource',selection:'implicit',options:[],userOptions:{kind}}}},required:['upload']});}
 else if(state.startsWith('upload-')){const id=state.slice(7),value=q.params.inputResponses.upload;log({event:'form-action',action:value.action});if(value.action!=='accept'){awaiting.delete(id);result={content:[{type:'text',text:'FORM_SETTLED_'+value.action}]};}else{const owner=awaiting.get(id);owner.uris=value.content.upload;result=required('confirm','confirm-'+id,'Confirm upload '+kind,{type:'object',properties:{confirm:{type:'string',title:'Confirmation'}},required:['confirm']});}}
 else{const id=state.slice(8),owner=awaiting.get(id),value=q.params.inputResponses.confirm;awaiting.delete(id);if(value.action==='accept'&&value.content.confirm==='ALLOW_SNAPSHOT')log({event:'snapshot-read',uris:owner.uris,texts:owner.uris.flatMap(readSelected)});result={content:[{type:'text',text:'FORM_SETTLED_'+value.action}]};}
 }else if(q.params.name==='fixture.form'){const id='upload-form-'+(++reverseId),kind=q.params.arguments.kind;awaiting.set(id,{id:q.id,kind});log({event:'form-issued',id,callId:q.id,kind});send({jsonrpc:'2.0',id,method:'openai/elicitation/create',params:{mode:'form',message:'Fixture upload '+kind,requestedSchema:{type:'object',properties:{upload:{type:'array',title:'Selected resources',items:{type:'string'},minItems:1,'x-openai-input':{type:'resource',selection:'implicit',options:[],userOptions:{kind}}}},required:['upload']}}});continue;}else throw Error('unknown tool');break;default:throw Error('unsupported method');}
send({jsonrpc:'2.0',id:q.id,result});}catch(error){log({event:'fixture-error',message:error.message});if(q?.id!==undefined)send({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:error.message}});}}
`;
await writeFile(join(source,'server.mjs'),fixtureServer);
await writeFile(join(source,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{fixture:{type:'stdio',command:'node',args:['${PLUGIN_ROOT}/server.mjs'],env:{FIXTURE_LOG:transportLog,FIXTURE_PROTOCOL:modern?'modern':'legacy'}}}}));
await writeFile(join(workspace,'sample.txt'),'OPAQUE_FILE_READ_MARKER\n');
await writeFile(join(workspace,'.agents','plugins','marketplace.json'),JSON.stringify({name:'gui-p0',plugins:[{name:'hello',source:{source:'local',path:'./packages/hello'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}]}));
async function transportEvents(){try{return (await readFile(transportLog,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
const sourceRoot=resolve(gui,'../..');
const sourceFiles={};
for(const path of new Set(execFileSync('git',['ls-files','--modified','--others','--exclude-standard','-z'],{cwd:sourceRoot}).toString().split('\0').filter(Boolean))){
if(/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path))sourceFiles[path]=createHash('sha256').update(await readFile(join(sourceRoot,path))).digest('hex');}
const sourceDiffSha256=createHash('sha256').update(execFileSync('git',['diff','--binary','HEAD'],{cwd:sourceRoot})).digest('hex');
const requests=[],checks=[],errors=[];
const model=createServer(async(req,res)=>{let body='';for await(const p of req)body+=p;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'GUI_PLUGIN_SETUP_OK'},finish_reason:null}]})+'\n\n'+'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
await writeFile(join(userHome,'.areal','config.toml'),'schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:'+model.address().port+'"\n');
const env={...process.env,AREAL_GUI_USER_DATA:join(scratch,'electron'),AREAL_CORE_HOME:join(scratch,'core'),AREAL_CORE_USER_HOME:userHome,
AREAL_HARNESS_SERVICE_HOME:join(scratch,'registry'),AREAL_CORE_BIN:process.env.AREAL_CORE_BIN??resolve(gui,'../../target/debug/areal')};
for(const k of ['AREAL_CORE_WORKSPACE','AREAL_CORE_CONFIG','AREAL_HARNESS_HOME','AREAL_HARNESS_CONFIG','AREAL_CORE_DESKTOP_CONFIG'])delete env[k];
const coreBinary=env.AREAL_CORE_BIN,coreSha256=createHash('sha256').update(await readFile(coreBinary)).digest('hex');
let app,page,failure,passed=false;
const button=n=>page.getByRole('button',{name:n,exact:true});
const state=()=>page.evaluate(()=>window.arealDesktop.snapshot());
async function until(fn,label){const end=Date.now()+30_000;while(Date.now()<end){const s=await state();if(fn(s))return s;await new Promise(r=>setTimeout(r,75));}throw Error('timeout: '+label);}
async function waitEvents(predicate,label){const end=Date.now()+30_000;while(Date.now()<end){const events=await transportEvents();if(predicate(events))return events;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('timeout: '+label);}
async function appFrame(){const end=Date.now()+30_000;while(Date.now()<end){const frame=page.frames().find(frame=>/^areal-mcp:\/\/[^/]+\/view$/.test(frame.url()));if(frame){await frame.locator('#ready').filter({hasText:'initialized'}).waitFor();return frame;}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('sandbox app frame missing');}
async function settings(){await button('设置').click();await page.getByLabel('集成',{exact:true}).getByRole('button',{name:'插件',exact:true}).click();await page.getByRole('heading',{name:'插件',exact:true}).waitFor();await page.getByRole('button',{name:'查看插件 hello@gui-p0',exact:true}).click();}
try{
app=await electron.launch({executablePath:require('electron'),args:[join(gui,'app')],env,timeout:120_000});
page=await app.firstWindow();page.setDefaultTimeout(20_000);page.on('pageerror',e=>errors.push(e.message));
await page.getByTestId('areal-workbench').waitFor({timeout:120_000});await until(s=>s.connection?.state==='ready','desktop ready');
await app.evaluate(({dialog,BrowserWindow},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});dialog.showMessageBox=async()=>({response:1});BrowserWindow.getAllWindows()[0].setSize(1440,960);},workspace);
await page.evaluate(()=>window.arealDesktop.chooseProject());await until(s=>s.projects[0]?.state?.connected,'chosen project connected');
if(await button('返回应用').isVisible())await button('返回应用').click();await page.getByTestId('chat-input').waitFor();
const ready=await until(s=>s.projects[0]?.state?.connected,'project connected'),projectId=ready.projects[0].id;
await settings();await button('解析并预览来源').click();await page.getByText('我已核对以上来源、版本和内容摘要',{exact:true}).click();await button('安装到用户').click();await button('卸载插件').waitFor();
await page.getByText('我信任此已安装快照并允许启动其 MCP 服务器',{exact:true}).click();await button('信任并连接').click();
await waitEvents(events=>events.some(event=>event.method==='tools/list'),'real MCP transport started');
await page.getByRole('dialog').getByRole('button',{name:/关闭/}).first().click();await page.getByRole('tab',{name:'应用',exact:true}).click();
await button('刷新应用').click();await button('Extension App').first().click();
let inner=await appFrame();const ownerThread=await page.getByTestId('areal-workbench').getAttribute('data-thread-id');assert(ownerThread);
const selectedFile=join(scratch,'selected.txt'),selectedDirectory=join(scratch,'selected-directory');
await writeFile(selectedFile,'SELECTED_FILE_SNAPSHOT_MARKER');await mkdir(selectedDirectory);await writeFile(join(selectedDirectory,'child.txt'),'SELECTED_DIRECTORY_SNAPSHOT_MARKER');
async function choose(paths,canceled=false,confirm=1){await app.evaluate(({dialog},{paths,canceled,confirm})=>{dialog.showOpenDialog=async()=>({canceled,filePaths:paths});dialog.showMessageBox=async()=>({response:confirm});},{paths,canceled,confirm});}
const form=kind=>page.locator('form').filter({has:page.getByText('Fixture upload '+kind,{exact:true})});
async function settled(kind){const add=form(kind).getByRole('button',{name:kind==='file'?'添加文件':'添加目录',exact:true});const end=Date.now()+30_000;while(Date.now()<end){if(await add.isEnabled())return;await new Promise(r=>setTimeout(r,75));}throw Error('picker did not settle');}
await inner.locator('#file').click();await form('file').waitFor();
// Observe the owner identity, then send adversarial requests through the actual narrow Main boundary.
// These negative IPC probes do not replace any positive UI selection or form submission.
const formOwner=await page.evaluate(async({projectId,threadId})=>{const result=await window.arealDesktop.command('manage',{operation:'mcpForms',projectId,threadId});if(!result.ok)throw Error('form list failed');return result.value.data[0];},{projectId,threadId:ownerThread});
assert(formOwner?.requestId);
const negative=await page.evaluate(async({projectId,threadId,requestId,path})=>{
 const owner={projectId,threadId,requestId,fieldName:'upload'};
 const rejects=async request=>{try{await window.arealDesktop.mcpFormResource('pick',request);return false;}catch{return true;}};
 const generic=await window.arealDesktop.command('manage',{operation:'mcpFormResourceStage',projectId,selectionToken:'forged',requestId:'c71b2b27-fc6d-49c9-94e8-b53a6843279c',paths:[path]});
 return {injected:await rejects({...owner,paths:[path]}),wrongField:await rejects({...owner,fieldName:'not-declared'}),genericDenied:generic.ok===false};
},{projectId,threadId:ownerThread,requestId:formOwner.requestId,path:selectedFile});
assert.deepEqual(negative,{injected:true,wrongField:true,genericDenied:true});
checks.push('actual Main rejects renderer path injection/private stage and Core rejects wrong owning form field');
await choose([],true);await form('file').getByRole('button',{name:'添加文件',exact:true}).click();await settled('file');assert.equal(await form('file').getByText('selected.txt',{exact:true}).count(),0);assert.equal((await transportEvents()).filter(e=>e.result?.action).length,0);
checks.push('native picker cancellation does not add or submit a resource');
await choose([selectedFile]);await form('file').getByRole('button',{name:'添加文件',exact:true}).click();await form('file').getByText('selected.txt',{exact:true}).waitFor();
assert(!(await form('file').innerText()).includes(scratch));
await form('file').getByRole('button',{name:'移除 selected.txt',exact:true}).click();await form('file').getByText('selected.txt',{exact:true}).waitFor({state:'detached'});
checks.push('uploaded resource can be removed through its owning field without submitting the form');
await form('file').getByRole('button',{name:'添加文件',exact:true}).click();await form('file').getByText('selected.txt',{exact:true}).waitFor();
await writeFile(selectedFile,'MUTATED_ORIGINAL_MUST_NOT_REACH_SERVER');
await form('file').getByRole('button',{name:'提交',exact:true}).click();
if(modern){const next=page.locator('form').filter({has:page.getByText('Confirm upload file',{exact:true})});await next.waitFor();assert.equal((await transportEvents()).filter(e=>e.event==='snapshot-read').length,0);await next.getByRole('textbox').fill('ALLOW_SNAPSHOT');await next.getByRole('button',{name:'提交',exact:true}).click();}
let events=await waitEvents(es=>es.some(e=>e.event==='snapshot-read'),'stdio server reads selected snapshot');const fileRead=events.find(e=>e.event==='snapshot-read');assert.deepEqual(fileRead.texts,['SELECTED_FILE_SNAPSHOT_MARKER']);assert(fileRead.uris.every(uri=>uri.startsWith('file://')&&fileURLToPath(uri)!==selectedFile&&fileURLToPath(uri)!==selectedDirectory));await form('file').waitFor({state:'detached'});
checks.push('actual stdio MCP server reads immutable selected file snapshot and receives no original path');
await inner.locator('#directory').click();await form('directory').waitFor();await choose([selectedDirectory],false,0);await form('directory').getByRole('button',{name:'添加目录',exact:true}).click();await settled('directory');assert.equal(await form('directory').getByText('selected-directory',{exact:true}).count(),0);
assert.equal((await transportEvents()).filter(e=>e.event==='snapshot-read').length,1);
checks.push('directory confirmation cancel does not deliver resources to the server');
await choose([selectedDirectory]);await form('directory').getByRole('button',{name:'添加目录',exact:true}).click();await form('directory').getByText('selected-directory',{exact:true}).waitFor();
await form('directory').getByRole('button',{name:'提交',exact:true}).click();if(modern){const next=page.locator('form').filter({has:page.getByText('Confirm upload directory',{exact:true})});await next.waitFor();assert.equal((await transportEvents()).filter(e=>e.event==='snapshot-read').length,1);await next.getByRole('textbox').fill('ALLOW_SNAPSHOT');await next.getByRole('button',{name:'提交',exact:true}).click();}events=await waitEvents(es=>es.filter(e=>e.event==='snapshot-read').length===2,'stdio reads directory snapshot');assert.deepEqual(events.filter(e=>e.event==='snapshot-read')[1].texts,['SELECTED_DIRECTORY_SNAPSHOT_MARKER']);
checks.push('actual directory snapshot is readable by local stdio only after native confirmation and form submit');
await inner.locator('#file').click();await form('file').waitFor();await choose([selectedFile]);await form('file').getByRole('button',{name:'添加文件',exact:true}).click();await form('file').getByText('selected.txt',{exact:true}).waitFor();await form('file').getByRole('button',{name:'取消',exact:true}).click();await waitEvents(es=>es.some(e=>e.result?.action==='cancel'||e.event==='form-action'&&e.action==='cancel'),'form cancellation');assert.equal((await transportEvents()).filter(e=>e.event==='snapshot-read').length,2);
checks.push('form cancel after selection produces no server-visible file grant');
const expired=await page.evaluate(async owner=>{try{await window.arealDesktop.mcpFormResource('pick',owner);return false;}catch{return true;}},{projectId,threadId:ownerThread,requestId:formOwner.requestId,fieldName:'upload'});assert.equal(expired,true);
checks.push('settled form owner cannot reopen a native resource selection');
if(modern){const wire=(await transportEvents()).filter(e=>e.event==='wire');assert(wire.some(e=>e.method==='server/discover'));assert(!wire.some(e=>e.method==='initialize'));const calls=wire.filter(e=>e.method==='tools/call'&&e.params.name==='fixture.form');for(const kind of ['file','directory']){const completed=calls.filter(e=>e.params.arguments.kind===kind&&e.params.requestState?.startsWith('confirm-'));assert(completed.length);const last=completed.at(-1),rounds=calls.filter(e=>e.params.arguments.kind===kind&&(!e.params.requestState||e.params.requestState.endsWith(last.params.requestState.slice(8))));assert(rounds.length>=3);assert.equal(new Set(rounds.map(e=>e.id)).size,rounds.length);assert(rounds.every(e=>JSON.stringify(e.params.arguments)===JSON.stringify(last.params.arguments)));}checks.push('actual modern MCP discovery and two native human form rounds retain arguments with fresh request IDs; file grants survive until logical completion');}
await page.screenshot({path:join(scratch,'uploads-completed.png'),animations:'disabled'});
assert.equal(requests.length,0);
assert.deepEqual(errors,[]);passed=true;
}catch(e){failure={message:e.message,stack:e.stack};process.exitCode=1;if(page)await captureSmokeFailure(page,scratch,e);}
finally{
if(app){
await app.close().catch(e=>errors.push('close GUI: '+e.message));
try{const {ServiceConnection}=require('../app/src/core/service-client.cjs');const connection=new ServiceConnection();
try{const metadata=JSON.parse(await readFile(join(scratch,'core/service.json'),'utf8'));await connection.connect(metadata);await connection.request('stopService',{protocol:metadata.protocol},true);}
finally{connection.close();}}
catch(e){errors.push('stop service: '+e.message);}
}
await new Promise(r=>model.close(r));
if(errors.length){passed=false;process.exitCode=1;}
const manifest={passed,protocol:modern?'2026-07-28/MRTR':'2025-11-25/legacy',checks,errors,failure,scratch,source:execFileSync('git',['rev-parse','HEAD'],{cwd:gui,encoding:'utf8'}).trim(),
sourceFiles,sourceDiffSha256,core:{binary:coreBinary,sha256:coreSha256,unchanged:createHash('sha256').update(await readFile(coreBinary)).digest('hex')===coreSha256},
modelRequests:requests.length,transportEvents:await transportEvents(), gaps:['OS chooser selections and directory confirmation responses are scripted; physical picker UX is not asserted','remote upload capability, plugin revocation during picker and UNKNOWN receipt recovery require separate boundary acceptance','no real provider/GitHub/OAuth or packaged acceptance'], scope:'actual source Electron/Core desktop file/directory form uploads with local stdio snapshot reads; scripted native dialogs; no direct Core substitute'};
await writeFile(join(scratch,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
}
