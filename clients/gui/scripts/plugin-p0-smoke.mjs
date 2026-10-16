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
const scratch=await mkdtemp('/private/tmp/areal-plugin-gui-'),workspace=join(scratch,'workspace'),userHome=join(scratch,'user');
await mkdir(join(workspace,'.agents','plugins'),{recursive:true});await mkdir(join(userHome,'.areal'),{recursive:true});
execFileSync('git',['init','-b','main'],{cwd:workspace,stdio:'ignore'});
const source=join(workspace,'packages','hello');await mkdir(join(source,'skills','setup'),{recursive:true});
await writeFile(join(source,'plugin.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
name:'hello',version:'1.0.0',description:'A local package fixture.',extensions:{'com.openai':{interface:{displayName:'Hello Plugin'},onboardingSkill:'./skills/setup/SKILL.md'}}}));
await writeFile(join(source,'skills','setup','SKILL.md'),'---\nname: setup\ndescription: Configure the hello fixture.\n---\nGUI_PLUGIN_SETUP_BODY_MARKER\n');
await writeFile(join(workspace,'.agents','plugins','marketplace.json'),JSON.stringify({name:'gui-p0',plugins:[{name:'hello',source:{source:'local',path:'./packages/hello'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}]}));
const sourceRoot=resolve(gui,'../..');
const sourceFiles={};
for(const path of new Set(execFileSync('git',['ls-files','--modified','--others','--exclude-standard','-z'],{cwd:sourceRoot}).toString().split('\0').filter(Boolean))){
if(/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path)){try{sourceFiles[path]=createHash('sha256').update(await readFile(join(sourceRoot,path))).digest('hex');}catch(error){if(error.code!=='ENOENT')throw error;sourceFiles[path]=null;}}}
const sourceDiffSha256=createHash('sha256').update(execFileSync('git',['diff','--binary','HEAD'],{cwd:sourceRoot,maxBuffer:32*1024*1024})).digest('hex');
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
async function call(name,params){const r=await page.evaluate(({name,params})=>window.arealDesktop.command(name,params),{name,params});assert(r.ok,JSON.stringify(r));return r.value;}
async function pluginState(predicate,label){const end=Date.now()+30_000;while(Date.now()<end){
const row=(await call('manage',{projectId:await page.getByTestId('areal-workbench').getAttribute('data-project-id'),operation:'plugins'})).data.find(x=>x.id==='hello@gui-p0');
if(predicate(row))return row;await new Promise(r=>setTimeout(r,75));}throw Error('timeout: '+label);}
async function settings(){await page.getByRole('navigation',{name:'应用导航',exact:true}).getByRole('button',{name:'插件',exact:true}).click();await page.getByRole('tablist',{name:'市场范围',exact:true}).getByRole('tab',{name:'个人',exact:true}).click();await page.getByRole('button',{name:'查看插件 hello@gui-p0',exact:true}).click();}
const { builtinSkill, BUILTIN_SKILL_ID } = require('../app/src/core/builtin-skills.cjs');
// Provision verified product bytes once; this runner tests plugins, not concurrent first-run cache creation.
await builtinSkill(join(scratch, 'core'), BUILTIN_SKILL_ID);
try{
app=await electron.launch({executablePath:require('electron'),args:[join(gui,'app')],env,timeout:120_000});
page=await app.firstWindow();page.setDefaultTimeout(20_000);page.on('pageerror',e=>errors.push(e.message));
await page.getByTestId('areal-workbench').waitFor({timeout:120_000});await until(s=>s.connection?.state==='ready','desktop ready');
await app.evaluate(({dialog,BrowserWindow},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});dialog.showMessageBox=async()=>({response:1});BrowserWindow.getAllWindows()[0].setSize(1440,960);},workspace);
await page.evaluate(()=>window.arealDesktop.chooseProject());await createProjectConversation(page,'workspace');
const ready=await until(s=>s.projects.find(p=>p.root===workspace)?.state?.connected,'project connected'),projectId=ready.projects.find(p=>p.root===workspace).id;
await settings();
await page.getByRole('heading',{name:'尚未安装',exact:true}).waitFor();
assert.equal(await page.getByText('已安装 Skills（0）',{exact:true}).count(),0);
await button('查看详情').focus();await page.keyboard.press('Enter');await button('收起详情').waitFor();await page.keyboard.press('Enter');assert.equal(await button('查看详情').evaluate(el=>el===document.activeElement),true);
await page.screenshot({path:join(scratch,'uninstalled-plugin.png'),animations:'disabled'});
await button('核对来源并安装').click();
await page.getByRole('checkbox',{name:'我已核对以上来源、版本和内容摘要',exact:true}).check();
await button('安装到用户').click();
await page.getByRole('heading',{name:'已安装',exact:true}).waitFor();assert.equal(requests.length,0,'installation cannot run setup/model');
checks.push('GUI discovers unmodified package and installs through Core without model execution');
await page.screenshot({path:join(scratch,'installed-plugin.png'),animations:'disabled'});
// Lose a completed response only at the Main-to-renderer boundary. Core executes unchanged.
await app.evaluate(({ipcMain})=>{const channel='areal-core:command',original=ipcMain._invokeHandlers.get(channel);let lose=true;
ipcMain.removeHandler(channel);ipcMain.handle(channel,async(event,name,params)=>{const result=await original(event,name,params);
if(lose&&name==='manage'&&params.operation==='pluginSetup'&&result.ok){lose=false;return {ok:false,error:{message:'Injected response loss',submissionUnknown:true,requestId:params.requestId}};}return result;});});
await button('运行设置').click();
await page.getByTestId('plugin-detail-page').getByRole('button',{name:'核对插件提交',exact:true}).click();
await button('打开设置对话').waitFor();await button('打开设置对话').click();
await page.getByTestId('chat-input').waitFor();await page.getByText('GUI_PLUGIN_SETUP_OK',{exact:true}).waitFor();
const setupThread=await page.getByTestId('areal-workbench').getAttribute('data-thread-id');
assert(setupThread);await page.getByTestId('task-item-'+setupThread).waitFor();
assert(requests.some(r=>JSON.stringify(r.messages).includes('GUI_PLUGIN_SETUP_BODY_MARKER')));
await selectConversation(page,setupThread);assert.equal(requests.length,1,'receipt recovery must not replay setup');
checks.push('explicit setup enters ordinary accessible chat with packaged skill body and sidebar navigation');
checks.push('GUI recovers completed setup after injected Main-to-renderer response loss using real Core receipt without replay');
await page.screenshot({path:join(scratch,'setup-chat.png'),animations:'disabled'});
await settings();
await button('管理启用范围').click();await button('在用户范围停用').click();await pluginState(r=>r?.enabled===false,'disable committed');
const current=await call('manage',{projectId,operation:'plugins'});
assert.equal(current.data.find(x=>x.id==='hello@gui-p0').enabled,false);
checks.push('GUI disable reaches same Core state');
await button('在用户范围启用').click();await pluginState(r=>r?.enabled===true,'enable committed');
await button('更多插件操作').click();await page.getByRole('menuitem',{name:'卸载插件',exact:true}).click();await pluginState(r=>!r?.installed,'uninstall committed');
const removed=await call('manage',{projectId,operation:'plugins'});assert.equal(removed.data.some(x=>x.id==='hello@gui-p0'&&x.installed),false);
checks.push('GUI enable/uninstall completes through management receipts');
assert.deepEqual(errors,[]);passed=true;
}catch(e){failure={message:e.message,stack:e.stack};process.exitCode=1;if(page)await captureSmokeFailure(page,scratch,e);}
finally{
if(app){
await app.close().catch(e=>errors.push('close GUI: '+e.message));
try{const {ServiceConnection,waitForServiceExit}=require('../app/src/core/service-client.cjs');const connection=new ServiceConnection();
try{const metadata=JSON.parse(await readFile(join(scratch,'core/service.json'),'utf8'));await connection.connect(metadata);await connection.request('stopService',{protocol:metadata.protocol},true);await waitForServiceExit(join(scratch,'core'),metadata);}
finally{connection.close();}}
catch(e){errors.push('stop service: '+e.message);}
}
await new Promise(r=>model.close(r));
if(errors.length){passed=false;process.exitCode=1;}
const manifest={passed,checks,errors,failure,scratch,source:execFileSync('git',['rev-parse','HEAD'],{cwd:gui,encoding:'utf8'}).trim(),
sourceFiles,sourceDiffSha256,core:{binary:coreBinary,sha256:coreSha256,unchanged:createHash('sha256').update(await readFile(coreBinary)).digest('hex')===coreSha256},
modelRequests:requests.length,scope:'source Electron/Core P0 plugins; deterministic external model; no packaged/provider acceptance'};
await writeFile(join(scratch,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
}
