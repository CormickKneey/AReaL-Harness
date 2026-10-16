// Production renderer acceptance. Management is a deterministic external fixture;
// real install/receipt behavior is covered by plugin-p0-smoke.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const rendererRequire = createRequire(join(gui, 'renderer/package.json'));
const { chromium } = require('playwright-core');
const { createServer } = await import(pathToFileURL(rendererRequire.resolve('vite')).href);
const evidence = resolve(process.env.AREAL_PLUGIN_DETAIL_EVIDENCE ?? join(root, '.scratch/plugin-detail-implementation/ui-' + Date.now()));
await mkdir(evidence, { recursive: true });
const fixture = join(evidence, 'fixture.tsx');
await writeFile(fixture, `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PluginCenter} from '${join(gui, 'renderer/src/settings/PluginCenter.tsx')}';
import {UnsavedChangesProvider} from '${join(gui, 'renderer/src/settings/UnsavedChanges.tsx')}';
import '${join(gui, 'renderer/src/styles.css')}';
let mode='uninstalled',digest='a'.repeat(64),installed=false,auth='notStarted',state='disconnected',revision=1,lose=false;
const calls=[]; let receipt;
const detail=()=>({revision,id:'github@official',name:'github',displayName:'GitHub',description:'在对话中使用 GitHub。',version:null,installed,installedVersion:null,installedDigest:installed?digest:null,installedSkills:[],installedOnboardingSkill:null,enabled:installed,source:'/fixture/github',sourceDigest:digest,catalogSource:{type:'local',path:'/fixture/github'},components:['mcp'],diagnostics:['MCP declarations require explicit digest trust and connection'],skills:[],onboardingSkill:null});
const connection=()=>({pluginId:'github@official',installedDigest:digest,state:state==='connected'?'connected':auth==='ready'?'disconnected':'authRequired',trusted:state==='connected',authenticationTiming:'ON_INSTALL',servers:[{serverId:'github-mcp',state:state==='connected'?'connected':auth==='ready'?'disconnected':'authRequired',authentication:'required',config:{title:'GitHub MCP',authentication:{},authenticationRequirements:{}}}],connectors:[],diagnostics:[]});
const action=async(_name,p)=>{calls.push({...p});switch(p.operation){
case'pluginCapabilities':return {enabled:true};
case'plugins':return {revision,data:[detail()],marketplaces:[{name:'official',root:'/fixture',sourceUrl:'https://github.com/openai/plugins'}],errors:[]};
case'plugin':return detail();case'pluginResolve':case'pluginArchiveImport':return detail();case'pluginArchivePick':return {canceled:false,fileName:'github.zip',selectionToken:'fixture-archive'};
case'pluginHooks':return {data:installed?[{pluginId:'github@official',installedDigest:digest,definitionDigest:'hooks',definitions:[],diagnostics:[]}]:[]};
case'pluginMcp':return {data:installed?[connection()]:[]};
case'pluginInstall':installed=true;return detail();
case'pluginAuth':if(mode==='auth-unknown'&&p.authOperation==='status')throw Error('Injected auth read failure');if(p.authOperation==='start')auth='pending';if(p.authOperation==='cancel')auth='cancelled';return auth==='notStarted'?null:{status:auth};
case'pluginConnection':state=p.connect?'connected':'disconnected';if(!p.connect)auth='ready';receipt={confirmed:true,accepted:true,result:{}};if(lose){lose=false;throw Object.assign(new Error('连接回执丢失'),{submissionUnknown:true,requestId:p.requestId});}return {data:[connection()]};
case'pluginSubmission':return receipt;default:throw Error('Unexpected fixture operation '+p.operation);}};
function App(){const [epoch,setEpoch]=useState(0);window.pluginFixture={calls,reset(next){mode=next;installed=next!=='uninstalled';auth=next==='pending'?'pending':next==='ready'||next==='connected'||next==='unknown'?'ready':'notStarted';state=next==='connected'?'connected':'disconnected';lose=next==='unknown';revision++;setEpoch(x=>x+1);},swapDigest(){digest='b'.repeat(64);revision++;window.dispatchEvent(new Event('areal-plugins-changed'));},setReady(){auth='ready';mode='ready';},};
const project={id:'fixture',name:'workspace',root:'/fixture',state:{connected:true},pending:[]};return <UnsavedChangesProvider><div style={{height:'100vh',display:'flex'}}><PluginCenter key={epoch} project={project} projects={[project]} action={action} active surface="workspace" marketRequest={0} onSettings={()=>{}} onMarket={()=>{}} onChooseProject={()=>{}} onSelectProject={()=>{}} onStartDraft={async()=>{calls.push({operation:'startDraft'});}} /></div></UnsavedChangesProvider>;}
createRoot(document.getElementById('root')).render(<App/>);`);
const server = await createServer({ root: join(gui, 'renderer'), configFile: join(gui, 'renderer/vite.config.ts'), mode: 'design-system', appType: 'custom', server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } } });
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/plugin-detail-acceptance.html') return next();
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`));
});
await server.listen();
const origin = server.resolvedUrls.local[0];
let browser, page, passed = false, failure;
const errors = [], checks = [];
const button = name => page.getByRole('button', { name, exact: true });
async function open(mode) {
  await page.evaluate(mode => window.pluginFixture.reset(mode), mode);
  await page.getByRole('tablist', { name: '市场范围', exact: true }).waitFor();
  await button('查看插件 github@official').click();
  await page.getByTestId('plugin-detail-page').waitFor();
}
async function capture(name) {
  await page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
  await writeFile(join(evidence, name + '.aria.txt'), await page.locator('body').ariaSnapshot());
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + 'plugin-detail-acceptance.html');
  await page.waitForFunction(() => !!window.pluginFixture);
  await page.getByRole('tablist', { name: '市场范围', exact: true }).waitFor();await button('添加资源').click();
  await page.getByRole('menuitem', { name: '上传插件包', exact: true }).click();await button('导入并预览').click();
  await page.getByRole('checkbox', { name: '我已核对以上来源、版本和内容摘要', exact: true }).waitFor();
  assert.equal(await button('安装到用户').isEnabled(), false);await button('取消安装').click();await button('核对来源并安装').waitFor();
  checks.push('archive preview survives detail navigation and still requires explicit review');
  await open('uninstalled');await page.getByRole('heading', { name: '尚未安装', exact: true }).waitFor();
  assert.equal(await page.getByText('已安装 Skills（0）').count(), 0);
  await button('查看详情').focus();await page.keyboard.press('Enter');await button('收起详情').waitFor();await page.keyboard.press('Enter');
  assert.equal(await button('查看详情').evaluate(el => el === document.activeElement), true);
  await capture('01-uninstalled');await button('核对来源并安装').click();
  await page.getByRole('checkbox', { name: '我已核对以上来源、版本和内容摘要', exact: true }).waitFor();
  assert.equal(await button('安装到用户').isEnabled(), false);
  await page.getByRole('checkbox', { name: '我已核对以上来源、版本和内容摘要', exact: true }).check();
  await button('安装到用户').click();await page.getByRole('heading', { name: '需要认证', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '插件钩子', exact: true }).count(), 0);
  checks.push('source review gates install; empty hooks/skills hidden; details keyboard/focus');
  await button('在浏览器中认证').click();await button('核对认证状态').waitFor();
  assert.equal(await button('在浏览器中认证').count(), 0);await capture('02-auth-pending');
  await page.evaluate(() => window.pluginFixture.setReady());await button('核对认证状态').click();await button('审阅并连接').waitFor();
  assert.equal(await page.evaluate(() => window.pluginFixture.calls.filter(c => c.operation === 'pluginConnection').length), 0);
  await button('审阅并连接').click();const consent = page.getByRole('checkbox', { name: '我信任当前安装快照，并允许启动其 MCP 服务。', exact: true });
  assert.equal(await consent.isChecked(), false);assert.equal(await button('信任并连接').isEnabled(), false);
  await consent.check();await capture('03-trust-review');
  const alignment = await consent.evaluate(el => {const a=el.getBoundingClientRect(),b=el.parentElement.querySelector('span').getBoundingClientRect();return {width:a.width,gap:b.left-a.right,top:Math.abs(a.top-b.top)};});
  assert(alignment.width>=18 && alignment.gap>=8 && alignment.gap<=16 && alignment.top<8);
  await page.evaluate(() => window.pluginFixture.swapDigest());await button('审阅并连接').waitFor();await button('审阅并连接').click();assert.equal(await consent.isChecked(), false);
  checks.push('auth start/status are separate; auth ready never connects; consent is readable and resets on digest change');
  await consent.check();await button('信任并连接').click();await page.getByRole('heading', { name: '已连接', exact: true }).waitFor();
  await button('开始对话').waitFor();await button('断开并撤销信任').waitFor();await capture('04-connected');
  await button('查看详情').click();await button('收起详情').waitFor();await capture('06-details-expanded');
  await button('断开并撤销信任').click();await button('审阅并连接').waitFor();
  checks.push('connected actions and disconnect/revoke transition');
  await open('unknown');await button('审阅并连接').click();await consent.check();await button('信任并连接').click();
  await page.getByRole('heading', { name: '连接结果待核对', exact: true }).waitFor();await capture('05-submission-unknown');
  assert.equal(await button('信任并连接').count(), 0);assert.equal(await button('管理启用范围').isEnabled(), false);
  const before = await page.evaluate(() => window.pluginFixture.calls.filter(c => c.operation === 'pluginConnection').length);
  await button('核对连接结果').click();await page.getByRole('heading', { name: '已连接', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.pluginFixture.calls.filter(c => c.operation === 'pluginConnection').length), before);
  checks.push('UNKNOWN blocks writes and recovers original receipt without replay');
  await open('auth-unknown');await page.getByRole('heading', { name: '认证结果待核对', exact: true }).waitFor();
  assert.equal(await button('在浏览器中认证').count(), 0);assert.equal(await button('取消本次认证').count(), 0);
  await page.evaluate(() => window.pluginFixture.setReady());await button('核对认证状态').click();await button('审阅并连接').waitFor();
  checks.push('auth read failure is UNKNOWN, not an active attempt; only status query recovers it');
  await page.setViewportSize({ width: 900, height: 850 });await page.evaluate(() => document.documentElement.classList.add('dark'));await capture('07-narrow-dark');
  const overflow = await page.getByTestId('plugin-detail-page').evaluate(el => el.scrollWidth > el.clientWidth + 1);assert.equal(overflow, false);
  assert.deepEqual(errors, []);checks.push('narrow/dark has no detail overflow or renderer errors');passed=true;
} catch (error) {failure={message:error.message,stack:error.stack};process.exitCode=1;if(page)await capture('failure');}
finally {
  await browser?.close();await server.close();
  const hashes={};for(const file of ['settings/PluginCenter.tsx','settings/PluginConnectionPanel.tsx','settings/PluginCenter.css'])hashes[file]=createHash('sha256').update(await readFile(join(gui,'renderer/src',file))).digest('hex');
  await writeFile(join(evidence,'manifest.json'),JSON.stringify({passed,failure,checks,errors,hashes,scope:'production renderer, deterministic management fixture; no Core/provider/native acceptance'},null,2));
  console.log(JSON.stringify({passed,evidence,failure,checks,errors},null,2));
}
