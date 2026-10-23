import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const rendererRequire = createRequire(join(gui, 'renderer/package.json'));
const { chromium } = require('playwright-core');
const { build, loadConfigFromFile } = await import(pathToFileURL(rendererRequire.resolve('vite')).href);
const evidence = resolve(process.env.AREAL_MCP_PLATFORM_EVIDENCE ?? join(root, '.scratch/mcp-platform-renderer-' + Date.now()));
await mkdir(evidence, { recursive: true });
const fixture = join(evidence, 'fixture.tsx');
const html = join(evidence, 'fixture.html');
const outDir = join(evidence, 'dist');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['renderer/src/services.ts', 'renderer/src/mcp-app-services.ts', 'renderer/src/McpAppsWorkspace.tsx', 'renderer/src/McpAppHost.tsx', 'renderer/src/McpAppIcon.tsx', 'renderer/src/McpAppForm.tsx', 'renderer/src/settings/McpAppsSettings.tsx', 'scripts/mcp-platform-renderer-smoke.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(join(gui, file)))])));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const diffSha256 = sha(execFileSync('git', ['diff', 'HEAD'], { cwd: root }));
const source = file => JSON.stringify(join(gui, 'renderer/src', file));
await writeFile(fixture, `import React,{useLayoutEffect,useState} from ${JSON.stringify(rendererRequire.resolve('react'))};
import {createRoot} from ${JSON.stringify(rendererRequire.resolve('react-dom/client'))};
import {ApplicationIntlProvider} from ${source('i18n/IntlProvider.tsx')};
import {McpAppIcon} from ${source('McpAppIcon.tsx')};
import {McpAppEntrypoints} from ${source('settings/McpAppsSettings.tsx')};
import {McpAppHost} from ${source('McpAppHost.tsx')};
import {useMcpAppsWorkspace} from ${source('McpAppsWorkspace.tsx')};
const image='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
const icon={src:'https://fixture.invalid/icon.svg'};
const server={serverId:'server',generation:1,tools:[{name:'tool',icons:[icon],_meta:{'openai/ui':{entrypoints:[{type:'global'}]}}}]};
const choice={requestId:'choice',threadId:'thread',serverId:'server',generation:1,message:'Thumbnail form',requestedSchema:{type:'object',properties:{color:{type:'string',oneOf:[{const:'red',title:'Red','x-openai-thumbnail':icon}]}},additionalProperties:false}};
const upload={requestId:'upload',threadId:'thread',serverId:'server',generation:1,message:'Upload form',requestedSchema:{type:'object',properties:{file:{type:'string','x-openai-input':{type:'file',options:[],userOptions:{kind:'file'}}}},additionalProperties:false}};
const project={id:'project',desktopCapabilities:{currentCommands:true},state:{connected:true,threads:{thread:{id:'thread',turns:[]}}}};
const legacyProject={id:'legacy',desktopCapabilities:{currentCommands:false},state:{connected:true,threads:{thread:{id:'thread',turns:[]}}}};
const app={token:'host-token',frameUrl:'about:blank',instanceId:'host',serverId:'server',generation:1,projectId:'project',threadId:'thread',initialArguments:{},hostContext:{displayMode:'inline'},toolMetadata:{name:'tool',icons:[icon]}};
const names=['full','no-command','no-event','no-deeplink','no-form','none'];
const state={poisonCalls:0,cases:{},workspaces:{},loaders:{},loaderChanged:false};
window.arealDesktop={mcpApp:async()=>{state.poisonCalls++;throw Error('Global platform bypass');},mcpFormResource:async()=>{state.poisonCalls++;throw Error('Global resource bypass');},onMcpAppEvent:()=>{state.poisonCalls++;throw Error('Global subscription bypass');}};
for(const name of names){const record=state.cases[name]={requests:[],actions:[],eventSubscriptions:0,eventUnsubscribes:0,deepSubscriptions:0,deepUnsubscribes:0,resourceCalls:[]};
const services={mcpApp:async request=>{record.requests.push(request);if(request.operation==='metadataImage')return image;if(request.operation==='open')return {...app,token:name+'-token',instanceId:name};return {};},onMcpAppEvent:()=>{record.eventSubscriptions++;return ()=>record.eventUnsubscribes++;},onMcpAppDeepLink:()=>{record.deepSubscriptions++;return ()=>record.deepUnsubscribes++;},mcpFormResource:async(operation,request)=>{record.resourceCalls.push({operation,...request});return {resources:[]};}};
if(name==='no-command')delete services.mcpApp;if(name==='no-event')delete services.onMcpAppEvent;if(name==='no-deeplink')delete services.onMcpAppDeepLink;if(name==='no-form')delete services.mcpFormResource;if(name==='none')for(const key of Object.keys(services))delete services[key];record.services=services;
record.action=async(name,params)=>{record.actions.push({name,...params});if(params.operation==='mcpApps')return {data:[server]};if(params.operation==='mcpForms')return {data:[choice,upload]};throw Error('Unexpected action '+name);};}
function Case({name,epoch,legacy}){const record=state.cases[name];const selectedProject=name==='full'&&legacy?legacyProject:project;const workspace=useMcpAppsWorkspace({services:record.services,project:selectedProject,projects:[project,legacyProject],deepLinksEnabled:true,activeTab:'',threadId:'thread',action:record.action,onOpenThread:async()=>{},onReveal:()=>{},onRemoveTab:()=>{},onError:message=>{record.error=message;}});state.workspaces[name]=workspace;
useLayoutEffect(()=>{if(Object.hasOwn(state.loaders,name)&&state.loaders[name]!==workspace.loadMetadataImage)state.loaderChanged=true;state.loaders[name]=workspace.loadMetadataImage;},[workspace.loadMetadataImage]);
return <section data-case={name}><output data-supported>{String(workspace.supported)}</output><div data-icon><McpAppIcon icon={icon} loadMetadataImage={workspace.loadMetadataImage}/></div><div data-entrypoints><McpAppEntrypoints servers={[server]} kind="global" loadMetadataImage={workspace.loadMetadataImage} onOpen={()=>{}}/></div><div data-forms>{workspace.formsView}</div><button onClick={()=>workspace.openApp(server,server.tools[0]).catch(error=>{record.openError=error.message;})}>Open {name}</button>{name==='full'&&<div data-host><McpAppHost app={app} services={record.services} loadMetadataImage={workspace.loadMetadataImage} closeOnUnmount={false} onClose={()=>{}}/></div>}</section>;}
function App(){const [epoch,setEpoch]=useState(0);const [legacy,setLegacy]=useState(false);state.selectLegacy=()=>setLegacy(true);state.pulse=()=>setEpoch(value=>value+1);state.epoch=epoch;return <ApplicationIntlProvider>{names.map(name=><Case key={name} name={name} epoch={epoch} legacy={legacy}/>)}</ApplicationIntlProvider>;}
window.mcpPlatformTest=state;createRoot(document.getElementById('root')).render(<App/>);`);
await writeFile(html, '<html><meta charset="UTF-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
const loaded = await loadConfigFromFile({ command: 'build', mode: 'design-system' }, join(gui, 'renderer/vite.config.ts'));
await build({ ...loaded.config, configFile: false, root: evidence, publicDir: false, resolve: { ...loaded.config.resolve, alias: { ...loaded.config.resolve.alias, 'react/jsx-runtime': rendererRequire.resolve('react/jsx-runtime') } }, mode: 'production', logLevel: 'warn', build: { ...loaded.config.build, outDir, emptyOutDir: true, rollupOptions: { ...loaded.config.build.rollupOptions, input: html } } });
const server = createServer(async (req, res) => {
  try {
    const target = resolve(outDir, '.' + new URL(req.url, 'http://fixture').pathname);
    if (!target.startsWith(outDir + sep)) throw Error('Invalid fixture path');
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(target)] ?? 'application/octet-stream');
    res.end(await readFile(target));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page, passed = false, failure;
const errors = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/fixture.html');
  await page.waitForFunction(() => ['full','no-command','no-event','no-deeplink','no-form','none'].every(name => window.mcpPlatformTest?.workspaces[name]));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-case="full"] img')].length === 4 && [...document.querySelectorAll('[data-case="full"] img')].every(image => image.naturalWidth === 8));
  checks.push('production workspace loader reaches Icon, entrypoint, thumbnail form and host icon');
  for (const name of ['no-command', 'none']) assert.equal(await page.locator('[data-case="' + name + '"] [data-icon] img').count(), 0, 'missing command keeps placeholder');
  for (const name of ['no-command', 'no-event', 'none']) {
    await page.getByRole('button', { name: 'Open ' + name, exact: true }).click();
    await page.waitForFunction(name => !!window.mcpPlatformTest.cases[name].openError, name);
    const record = await page.evaluate(name => { const r = window.mcpPlatformTest.cases[name]; return { supported: window.mcpPlatformTest.workspaces[name].supported, events: r.eventSubscriptions, deepLinks: r.deepSubscriptions, opens: r.requests.filter(request => request.operation === 'open').length, creates: r.actions.filter(action => action.name === 'create').length }; }, name);
    assert.deepEqual(record, { supported: false, events: 0, deepLinks: 0, opens: 0, creates: 0 });
  }
  checks.push('missing command or app events prevents subscriptions, open and thread creation');
  await page.waitForFunction(() => window.mcpPlatformTest.cases.full.deepSubscriptions > 0 && window.mcpPlatformTest.cases['no-form'].deepSubscriptions > 0);
  assert.equal(await page.evaluate(() => window.mcpPlatformTest.cases['no-deeplink'].deepSubscriptions), 0);
  assert.equal(await page.locator('[data-case="no-deeplink"] [data-supported]').innerText(), 'true');
  await page.locator('[data-case="full"] [data-forms]').getByRole('button', { name: '添加文件', exact: true }).waitFor();
  assert.equal(await page.locator('[data-case="no-form"] [data-forms]').getByRole('button', { name: '添加文件', exact: true }).count(), 0);
  checks.push('missing optional deep link leaves hosting available; missing form capability leaves no native picker');
  const before = await page.evaluate(() => Object.fromEntries(Object.entries(window.mcpPlatformTest.cases).map(([name,r]) => [name,{ metadata:r.requests.filter(request=>request.operation==='metadataImage').length, events:r.eventSubscriptions, deepLinks:r.deepSubscriptions, unmounts:r.requests.filter(request=>request.operation==='pageToolsUnmount').length }])));
  await page.evaluate(() => window.mcpPlatformTest.pulse());
  await page.waitForFunction(() => window.mcpPlatformTest.epoch === 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await page.evaluate(() => Object.fromEntries(Object.entries(window.mcpPlatformTest.cases).map(([name,r]) => [name,{ metadata:r.requests.filter(request=>request.operation==='metadataImage').length, events:r.eventSubscriptions, deepLinks:r.deepSubscriptions, unmounts:r.requests.filter(request=>request.operation==='pageToolsUnmount').length }])));
  assert.deepEqual(after, before, 'unrelated rerender preserves metadata loads and host subscription/mount');
  assert.equal(await page.evaluate(() => window.mcpPlatformTest.loaderChanged), false);
  assert.equal(await page.evaluate(() => window.mcpPlatformTest.poisonCalls), 0);
  checks.push('stable loader and services preserve effects across rerender and never consult poison global');
  const eventOwnership = await page.evaluate(() => { const r=window.mcpPlatformTest.cases.full; return {subscriptions:r.eventSubscriptions,unsubscribes:r.eventUnsubscribes}; });
  await page.evaluate(() => window.mcpPlatformTest.selectLegacy());
  await page.waitForFunction(() => window.mcpPlatformTest.workspaces.full.supported === false);
  assert.deepEqual(await page.evaluate(() => { const r=window.mcpPlatformTest.cases.full; return {subscriptions:r.eventSubscriptions,unsubscribes:r.eventUnsubscribes}; }), eventOwnership, 'window event attachment outlives active project compatibility');
  checks.push('switching active project compatibility preserves window app event attachment');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, 'consumers.png'), fullPage: true });
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  await page?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  for (const [file, hash] of Object.entries(sourceHashes)) if (sha(await readFile(join(gui, file))) !== hash) { passed = false; process.exitCode = 1; failure ??= { message: 'Tested source changed during run', file }; }
  const report = { passed, boundary: 'Production React consumers with external PlatformServices fake; no Electron IPC/Core/provider/package claim', commit, diffSha256, sourceHashes, checks, errors, failure, cleanup: { browserClosed: !browser?.isConnected(), serverClosed: !server.listening } };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed, evidence, checks, failure }));
}
