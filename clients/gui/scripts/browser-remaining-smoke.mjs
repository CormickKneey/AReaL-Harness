import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// Remaining M1 synthetic Native boundaries: popup, storage, policy, and quota.
const mode = process.argv[2] ?? 'full';
assert.ok(['full', 'projection', 'background', 'lifecycle', 'download', 'windowClose', 'policy'].includes(mode));
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const workerObserver = { enabled: mode === 'download', playwrightVersion: null,
  rootAutoAttachFiltered: 0 };
let restoreWorkerObserver = () => {};
if (workerObserver.enabled) {
  const playwrightRoot=dirname(require.resolve('playwright-core/package.json'));
  workerObserver.playwrightVersion=require(join(playwrightRoot,'package.json')).version;
  assert.equal(workerObserver.playwrightVersion,'1.57.0');
  const { CRSession }=require(join(playwrightRoot,'lib/server/chromium/crConnection.js'));
  const originalSend=CRSession.prototype.send;
  CRSession.prototype.send=function(method,params) {
    if (this._parentSession===null && this._sessionId==='' && method==='Target.setAutoAttach'
      && params?.autoAttach===true) {
      workerObserver.rootAutoAttachFiltered++;
      params={...params,filter:[{type:'service_worker',exclude:true},
        ...(params.filter??[{type:'browser',exclude:true},{type:'tab',exclude:true},{}])]};
    }
    return originalSend.call(this,method,params);
  };
  restoreWorkerObserver=()=>{ CRSession.prototype.send=originalSend; };
}
const scratch = await mkdtemp('/private/tmp/areal-browser-human-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const siteFacts = { posts: 0, documentGets: 0, cookieOnGets: [], getRequests: [], redirects: 0, sameOriginRedirects: 0,
  forbiddenRequests: 0, serviceWorkerGets: 0, downloadStarts: 0, downloadCloses: 0, activeDownloads: 0,
  controlRedirects: 0 };
let controlRedirectUrl = null;
const forbidden = createServer((_request, response) => { siteFacts.forbiddenRequests++; response.end('forbidden target reached'); });
forbidden.on('upgrade', (_request, socket) => { siteFacts.forbiddenRequests++; socket.destroy(); });
await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve));
const forbiddenUrl = `http://127.0.0.1:${forbidden.address().port}/target`;
const site = createServer(async (request, response) => {
  if (request.url === '/slow-download') {
    siteFacts.downloadStarts++; siteFacts.activeDownloads++;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="synthetic-download.txt"',
      'Content-Length': String(32 * 1024 * 1024) });
    response.write('SYNTHETIC_DOWNLOAD_05');
    const timer=setInterval(()=>response.write('x'),500);
    response.on('close',()=>{clearInterval(timer);siteFacts.activeDownloads--;siteFacts.downloadCloses++;});
    return;
  }
  if (request.url === '/sw.js') { siteFacts.serviceWorkerGets++; response.setHeader('Content-Type', 'text/javascript'); response.end('self.addEventListener("fetch",()=>{});'); return; }
  if (request.url === '/redirect-same') {
    siteFacts.sameOriginRedirects++;
    response.writeHead(302, { Location: '/?marker=first&redirect=same' }); response.end(); return;
  }
  if (request.url === '/redirect-control') {
    siteFacts.controlRedirects++;
    response.writeHead(302, { Location: controlRedirectUrl }); response.end(); return;
  }
  if (request.url === '/redirect') {
    siteFacts.redirects++;
    response.writeHead(302, { Location: forbiddenUrl }); response.end(); return;
  }
  if (request.method === 'POST') {
    siteFacts.posts++;
    for await (const _chunk of request) { /* never retain the synthetic body */ }
    response.end('ok');
    return;
  }
  if (request.url.startsWith('/?')) {
    siteFacts.documentGets++;
    siteFacts.cookieOnGets.push(request.headers.cookie?.includes('m1_session=synthetic_05') ?? false);
    siteFacts.getRequests.push({ url: request.url, cookie: siteFacts.cookieOnGets.at(-1) });
  }
  response.setHeader('Set-Cookie', 'm1_session=synthetic_05; HttpOnly; SameSite=Lax');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Human boundary fixture</title>
    <h1>HUMAN_BOUNDARY_05</h1>
    <button id="effect" onclick="fetch('/effect',{method:'POST'})">Submit once</button>
    <button id="same-origin-popup" onclick="window.open('/?marker=first&amp;popup=1','_blank')">Open sibling</button>
    <button id="cross-origin-popup" onclick="window.open('${forbiddenUrl}','_blank')">Open denied</button>
    <a id="slow-download" href="/slow-download" download>Download synthetic stream</a>
    <label>Password <input id="password" type="password"></label>
    <script>
    (async()=>{
      const marker=new URL(location.href).searchParams.get('marker');
      const beforeLocal=localStorage.getItem('m1_marker');
      if (marker && beforeLocal===null) localStorage.setItem('m1_marker',marker);
      const idb=await new Promise((resolve,reject)=>{
        const open=indexedDB.open('m1_scope',1);
        open.onupgradeneeded=()=>open.result.createObjectStore('state');
        open.onerror=()=>reject(open.error);
        open.onsuccess=()=>{
          const db=open.result, tx=db.transaction('state','readwrite'), store=tx.objectStore('state'), get=store.get('marker');
          get.onerror=()=>reject(get.error);
          get.onsuccess=()=>{
            const before=get.result??null;
            if (before===null && marker) store.put(marker,'marker');
            tx.oncomplete=()=>{ db.close(); resolve({before,current:before??marker}); };
            tx.onerror=()=>reject(tx.error);
          };
        };
      });
      const swBefore=(await navigator.serviceWorker.getRegistrations()).length;
      await navigator.serviceWorker.register('/sw.js');
      const swAfter=(await navigator.serviceWorker.getRegistrations()).length;
      window.m1Status={marker,beforeLocal,currentLocal:localStorage.getItem('m1_marker'),idb,swBefore,swAfter};
    })().catch(error=>{window.m1Status={error:String(error)};});
    window.m1PolicyProbes={worker:'unattempted',socket:'unattempted',frame:'scheduled'};
    try { const worker=new Worker(${JSON.stringify(forbiddenUrl)}); worker.onerror=()=>{};
      window.m1PolicyProbes.worker='created'; }
    catch(error) { window.m1PolicyProbes.worker=error.name; }
    try { const socket=new WebSocket(${JSON.stringify(forbiddenUrl.replace('http:', 'ws:'))});
      socket.onerror=()=>socket.close(); window.m1PolicyProbes.socket='created'; }
    catch(error) { window.m1PolicyProbes.socket=error.name; }
    const frame=document.createElement('iframe'); frame.src=${JSON.stringify(forbiddenUrl)};
    frame.hidden=true; document.body.append(frame);
    </script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?marker=first&page=0`;
const secondUrl = `http://127.0.0.1:${site.address().port}/?marker=second&page=0`;
const secret = 'SYNTHETIC_LOGIN_SECRET_05';
let pageId, snapshotId, targetRef, phase = 'initial', issued = false, navigateTarget;
const modelCalls = [];
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timeout: ${label}`);
}
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), last = body.messages.at(-1);
  modelCalls.push({ phase, lastRole: last?.role, browserToolAvailable: (body.tools ?? []).some(tool => tool.function?.name === 'browser_v1') });
  await until(() => pageId, 'claimed page');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!issued) {
    issued = true;
    const args = phase === 'agentNavigate'
      ? { operation: 'navigate', parameters: { pageId, url: navigateTarget } }
      : ['click', 'noClaimAct'].includes(phase)
      ? { operation: 'act', parameters: { pageId, snapshotId, action: { kind: 'click', ref: targetRef } } }
      : { operation: 'observe', parameters: { pageId } };
    send({ tool_calls: [{ index: 0, id: `human-${phase}`, type: 'function',
      function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
  } else { send({ content: `Fixture completed ${phase}` }); send({}, 'stop'); }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use requested tools.' }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
const startedAt = new Date().toISOString(), events = {}, checks = [], errors = [];
let app, page, passed = false, projectId, threadId, nativeId;
async function snapshot() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function thread() { return (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId]; }
async function terminalTurn(previous) {
  return until(async () => {
    const turns = (await thread())?.turns ?? [], last = turns.at(-1);
    return turns.length > previous && ['completed', 'failed', 'interrupted'].includes(last?.status) ? last : null;
  }, `terminal ${phase} turn`);
}
function browserItem(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1');
  assert.ok(item, `Core history includes browser_v1 for ${phase}`);
  return item;
}
async function controlState() {
  return page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }),
    { projectId, threadId });
}
try {
  try { app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env, timeout: 120000 }); }
  finally { restoreWorkerObserver(); }
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  console.log(JSON.stringify({ diagnostic:'launched', scratch, appPid:app.process()?.pid, appPath:join(gui,'app') }));
  page.on('pageerror', error => errors.push(error.message));
  events.runtime = await app.evaluate(({ app }) => ({ product: app.getVersion(), electron: process.versions.electron,
    chromium: process.versions.chrome, node: process.versions.node }));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === 'ready', 'desktop ready');
  await app.evaluate(({ dialog, BrowserWindow }, { path, origin }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options?.title === '允许本地开发站点' && options.message === `允许此浏览工作区访问 ${origin}？`) {
        globalThis.__m1OriginPrompt = { origin, title: options.title, count: (globalThis.__m1OriginPrompt?.count ?? 0) + 1 };
        return { response: 1, checkboxChecked: false };
      }
      return original(...args);
    };
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, { path: workspace, origin: new URL(siteUrl).origin });
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(async () => (await snapshot()).projects.find(item => item.root === workspace && item.state?.connected), 'project ready');
  projectId = project.id;
  const first = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  threadId = first.threadId;
  await selectConversation(page, threadId);
  await page.keyboard.press('Meta+t'); await page.locator('.preview-panel').waitFor();
  await page.bringToFront();
  await app.evaluate(({ app, BrowserWindow }) => { const win=BrowserWindow.getAllWindows()[0]; win.show(); win.restore(); app.focus({steal:true}); win.focus(); });
  console.log(JSON.stringify({ diagnostic:'awaiting-focus', appPid:app.process()?.pid }));
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt', 120000);
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId, threadId, url: siteUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
  events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  nativeId = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(item => item.getURL() === url)?.id, siteUrl), 'native page');
  async function pv(tid, request) {
    return page.evaluate(({ projectId, threadId, request }) => window.arealDesktop.preview({ ...request, projectId, threadId }),
      { projectId, threadId:tid, request });
  }
  async function stateFor(tid) { return pv(tid,{operation:'state'}); }
  async function nativeCount() { return app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.length); }
  async function wcByUrl(url) { return until(()=>app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(c=>c.getURL()===url && !c.isDestroyed())?.id,url),`Native ${url}`); }
  async function nativeClick(id,selector) {
    await app.evaluate(async({webContents,BrowserWindow},{id,selector})=>{
      const c=webContents.fromId(id),win=BrowserWindow.getAllWindows()[0];
      win.show();win.focus();c.focus();
      const point=await c.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
      c.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      c.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    },{id,selector});
  }
  async function siteStatus(url) {
    return until(()=>app.evaluate(({webContents},url)=>{
      const c=webContents.getAllWebContents().find(item=>item.getURL()===url && !item.isDestroyed());
      return c?.executeJavaScript('window.m1Status');
    },url),`site status ${url}`);
  }
  async function makePinned(tid, id, url, navigateViaUI=false) {
    const index=(await stateFor(tid)).workspace.pages.findIndex(item=>item.pageId===id);
    assert.ok(index>=0);
    await until(async()=>
      await page.getByRole('tablist',{name:'浏览页面'}).getByRole('tab').nth(index).getAttribute('aria-selected')==='true',
    `public selected tab ${id}`);
    // The Renderer owns the display handoff; allow its next update before
    // asking Main for the focused exact-Origin prompt on a blank new Page.
    await new Promise(resolve=>setTimeout(resolve,600));
    if (tid!==threadId) {
      const publicState=await stateFor(tid);
      const renderer=await page.evaluate(()=>{
        const box=document.querySelector('.preview-panel .preview-webview');
        const rect=box?.getBoundingClientRect();
        return {threadId:document.querySelector('[data-testid="areal-workbench"]')?.getAttribute('data-thread-id'),
          selectedTabs:[...document.querySelectorAll('[role="tablist"][aria-label="浏览页面"] [role="tab"]')]
            .map(item=>({label:item.textContent,selected:item.getAttribute('aria-selected')})),
          box:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null};
      });
      const native=await app.evaluate(({BrowserWindow})=>{
        const win=BrowserWindow.getAllWindows()[0];
        return {focused:win.isFocused(),visible:win.isVisible(),views:win.contentView.children.map(view=>({
          id:view.webContents?.id,url:view.webContents?.getURL(),visible:view.getVisible(),bounds:view.getBounds()}))};
      });
      console.log(JSON.stringify({diagnostic:'before-second-origin',requestedPageId:id,
        selectedPageId:publicState.browser?.pageId,control:publicState.browser?.control,
        resource:publicState.browser?.resource,renderer,native}));
    }
    if (navigateViaUI) {
      await page.getByTestId('browser-address-input').fill(url);
      await page.getByTestId('browser-address-input').press('Enter');
    } else await pv(tid,{operation:'navigate',pageId:id,url});
    const wc=await wcByUrl(url);
    await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id).isLoading(),wc),`loaded ${url}`);
    const status=await siteStatus(url);
    assert.ok(!status.error,JSON.stringify(status));
    const claimed=await pv(tid,{operation:'claim',pageId:id});
    assert.equal(claimed.browser.control,'agent');
    return {id,url,wc,status};
  }
  const firstPages=[];
  pageId=(await controlState()).browser.pageId;
  assert.ok(pageId);
  const firstLoad=await siteStatus(siteUrl);
  assert.equal(firstLoad.beforeLocal,null);
  assert.equal(firstLoad.idb.before,null);
  assert.equal(firstLoad.swBefore,0);
  events.firstLoad=firstLoad;
  if (mode === 'policy') {
    const entries=await readdir(join(scratch,'registry','services'));
    const service=JSON.parse(await readFile(join(scratch,'registry','services',entries[0],'service.json'),'utf8'));
    const adapter=JSON.parse(await readFile(join(scratch,'core','service.json'),'utf8'));
    const coreTarget=new URL(service.endpoint); coreTarget.protocol='http:';
    const adapterTarget=new URL(adapter.endpoint); adapterTarget.protocol='http:';
    controlRedirectUrl=coreTarget.href;
    const candidates=[
      {name:'Core control',url:coreTarget.href},
      {name:'adapter control',url:adapterTarget.href},
      {name:'private address',url:'http://10.255.255.1/'},
      {name:'metadata address',url:'http://169.254.169.254/latest/meta-data/'},
    ];
    const before={nativeUrl:await app.evaluate(({webContents},id)=>webContents.fromId(id).getURL(),nativeId),
      documentGets:siteFacts.documentGets,pages:(await stateFor(threadId)).workspace.pages.length};
    const denials=[];
    for (const candidate of candidates) {
      const outcome=await pv(threadId,{operation:'navigate',pageId,url:candidate.url})
        .then(()=>({accepted:true}),error=>({accepted:false,error:error.message}));
      denials.push({name:candidate.name,...outcome});
      assert.equal(outcome.accepted,false,`${candidate.name} must be refused before Native navigation`);
      assert.match(outcome.error,/浏览安全策略拒绝该地址/);
    }
    const after={nativeUrl:await app.evaluate(({webContents},id)=>webContents.fromId(id).getURL(),nativeId),
      documentGets:siteFacts.documentGets,pages:(await stateFor(threadId)).workspace.pages.length};
    events.policy={before,denials,after,controlPortKind:'task-owned exact Core/adapter'};
    assert.deepEqual(after,before,'denied targets never change the owned Native page');
    checks.push('B-08: exact task-owned Core and adapter control ports plus private and metadata IP targets are refused before Native navigation');
  } else if (mode === 'windowClose') {
    await app.evaluate(({BrowserWindow})=>{
      globalThis.__m1ShowEvents=[];
      BrowserWindow.getAllWindows()[0].on('show',()=>globalThis.__m1ShowEvents.push(Date.now()));
    });
    const before={pageId,nativeId,workspace:(await stateFor(threadId)).workspace,
      nativeCount:await nativeCount()};
    assert.equal(before.nativeCount,1);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    const afterClose=await until(async()=>{
      const native=await app.evaluate(({BrowserWindow,webContents},id)=>{
        const win=BrowserWindow.getAllWindows()[0];
        return {windowVisible:win.isVisible(),nativeCount:win.contentView.children.length,
          oldNativeExists:!!webContents.fromId(id),
          views:win.contentView.children.map(view=>({id:view.webContents?.id,
            visible:view.getVisible(),bounds:view.getBounds()}))};
      },nativeId);
      events.windowClosePoll=native;
      if (native.windowVisible || native.nativeCount || native.oldNativeExists) return null;
      return {...native,workspace:(await stateFor(threadId)).workspace};
    },'public Window.close disposed Native Browser',5000);
    assert.equal(afterClose.workspace.pages.length,0);
    await new Promise(resolve=>setTimeout(resolve,1200));
    const afterRendererCycle=await app.evaluate(({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows()[0];
      return {windowVisible:win.isVisible(),nativeCount:win.contentView.children.length};
    });
    assert.deepEqual(afterRendererCycle,{windowVisible:false,nativeCount:0},
      'closed window remains free of Browser views through Renderer update cycle');
    checks.push('B-09: public Window.close hides the window and disposes its existing Browser Native View');
    const lateShow=await pv(threadId,{operation:'show',pageId,visible:true,
      bounds:{x:100,y:100,width:500,height:500}}).then(value=>({accepted:true,
      pageId:value.browser?.pageId}),error=>({accepted:false,error:error.message}));
    const noPageShow=await pv(threadId,{operation:'show',visible:true,
      bounds:{x:100,y:100,width:500,height:500}}).then(()=>({accepted:true}),
      error=>({accepted:false,error:error.message}));
    const afterLate=await app.evaluate(({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows()[0];
      return {windowVisible:win.isVisible(),nativeCount:win.contentView.children.length,
        views:win.contentView.children.map(view=>({id:view.webContents?.id,
          visible:view.getVisible(),bounds:view.getBounds()}))};
    });
    events.windowClose={before,afterClose,afterRendererCycle,lateShow,noPageShow,afterLate,
      workspaceAfterLate:(await stateFor(threadId)).workspace};
    assert.equal(lateShow.accepted,false);
    assert.equal(noPageShow.accepted,false);
    assert.equal(afterLate.nativeCount,0,'late old-Page show cannot recreate a hidden-window Native View');
    checks.push('B-09: late old-Page show cannot recreate a Native View after Window.close');
    await app.evaluate(({app,BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows()[0];win.show();app.focus({steal:true});win.focus();
    });
    await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),
      'public Window.show reopens Main');
    const showEvent=await until(()=>app.evaluate(()=>globalThis.__m1ShowEvents[0]??null),
      'Native Window.show event after reopen',5000);
    await new Promise(resolve=>setTimeout(resolve,1200));
    events.windowClose.reopenSignal={showEvent,
      windowVisible:await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())};
    const reopenState=await stateFor(threadId);
    const fresh=reopenState.workspace.pages.length
      ? reopenState.workspace.pages[0].pageId
      : (await pv(threadId,{operation:'newPage'})).browser.pageId;
    assert.notEqual(fresh,pageId,'reopening creates a fresh logical Page identity');
    await pv(threadId,{operation:'show',pageId:fresh,visible:true,
      bounds:{x:100,y:100,width:500,height:500}});
    const recovered=await until(async()=>{
      const current=await stateFor(threadId);
      const count=await nativeCount();
      return current.workspace.pages.length===1 && count===1
        ? {pageId:current.workspace.pages[0].pageId,nativeCount:count} : null;
    },'fresh Native Page after Window.show');
    events.windowClose.recovered=recovered;
    checks.push('B-09: public Window.show restores creation of a fresh Page and Native View');
  } else if (mode === 'projection') {
    const secondPageUrl = `${siteUrl}&projection=second`;
    navigateTarget = `${siteUrl}&projection=agent`;
    const firstNativeId = nativeId;
    const address = page.getByTestId('browser-address-input');
    async function exactFocusedAddress(expected) {
      await address.focus();
      await until(async()=>await address.inputValue()===expected,`focused address ${expected}`);
    }
    await pv(threadId,{operation:'navigate',pageId,url:secondPageUrl});
    await until(async()=>(await stateFor(threadId)).url===secondPageUrl,'public second URL');
    await exactFocusedAddress(secondPageUrl);
    await page.getByTestId('browser-back-button').click();
    await until(async()=>(await stateFor(threadId)).url===siteUrl,'public back URL');
    await exactFocusedAddress(siteUrl);
    await page.getByTestId('browser-forward-button').click();
    await until(async()=>(await stateFor(threadId)).url===secondPageUrl,'public forward URL');
    const beforeRefresh = siteFacts.documentGets;
    await page.getByTestId('browser-refresh-button').click();
    await until(()=>siteFacts.documentGets>beforeRefresh,'public refresh GET');
    assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id)?.getURL(),firstNativeId),secondPageUrl);
    await exactFocusedAddress(secondPageUrl);
    events.publicProjection = { firstNativeId, back:siteUrl, forward:secondPageUrl,
      refreshGets:siteFacts.documentGets-beforeRefresh };
    checks.push('B-07: public back, forward, and refresh retain one Native Controller and update visible URL');

    phase='initial'; issued=false;
    await page.getByRole('button',{name:'让 Agent 检查当前页'}).click();
    await until(async()=>(await stateFor(threadId)).browser?.control==='agent','projection Agent claim');
    const observed = browserItem(await terminalTurn(0));
    assert.equal(observed.success,true);
    const observation=JSON.parse(observed.contentItems[0].text);
    snapshotId=observation.observationId;
    targetRef=observation.nodes.find(node=>node.name==='Submit once'&&node.ref)?.ref;
    assert.match(targetRef,/^r\d+$/);
    phase='agentNavigate'; issued=false;
    await command('send',{projectId,threadId,text:'Navigate this synthetic page to the other same-Origin fixture URL'});
    const approval=page.locator('[data-interaction="approval"]');
    await approval.waitFor({timeout:60000});
    await approval.getByRole('button',{name:'允许一次'}).click();
    const navigated=browserItem(await terminalTurn(1));
    assert.equal(navigated.success,true);
    await until(async()=>(await stateFor(threadId)).url===navigateTarget,'Agent navigated public URL');
    await exactFocusedAddress(navigateTarget);
    events.agentProjection={nativeId:firstNativeId,url:navigateTarget,itemId:navigated.id,
      publicUrl:(await stateFor(threadId)).url};
    checks.push('B-07: approved Core Agent navigation projects into the same visible Native Controller');

    await pv(threadId,{operation:'takeover',pageId});
    await until(async()=>(await stateFor(threadId)).browser?.control==='human','public takeover before prepare refusal');
    phase='noClaimAct'; issued=false;
    await command('send',{projectId,threadId,text:'Try the old synthetic Ref after public takeover'});
    const refused=browserItem(await terminalTurn(2));
    assert.equal(refused.success,false);
    assert.match(JSON.stringify(refused),/browser prepare (host_unavailable|human_control|wrong_page); dispatch is not_sent/);
    assert.equal(siteFacts.posts,0);
    events.prepareRefusal={item:refused,posts:siteFacts.posts};
    checks.push('B-04: prepare without an authorized claim returns a named refusal and not_sent before input');
  } else if (mode === 'background') {
    const foregroundThreadId=threadId,foregroundPageId=pageId,foregroundNativeId=nativeId;
    const second=await command('create',{projectId,browserEnabled:true,profile:{id:'fixture',revision:'v1'}});
    threadId=second.threadId;
    await selectConversation(page,threadId);
    await page.keyboard.press('Meta+t'); await page.locator('.preview-panel').waitFor();
    const currentSecond=await stateFor(threadId);
    const secondPageId=currentSecond.workspace?.selectedPageId
      ?? (await pv(threadId,{operation:'newPage'})).browser.pageId;
    await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});
    await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),
      'second Thread exact Origin focus',120000);
    await pv(threadId,{operation:'navigate',pageId:secondPageId,url:secondUrl});
    await until(async()=>(await stateFor(threadId)).url===secondUrl,'second Thread Browser URL');
    const secondNativeId=await wcByUrl(secondUrl);
    pageId=secondPageId; phase='initial'; issued=false;
    await page.getByRole('button',{name:'让 Agent 检查当前页'}).click();
    await until(async()=>(await stateFor(threadId)).browser?.control==='agent','background page claimed');
    const initialBackground=browserItem(await terminalTurn(0));
    assert.equal(initialBackground.success,true);

    await selectConversation(page,foregroundThreadId);
    await until(async()=>await page.evaluate(id=>document.querySelector('[data-testid="areal-workbench"]')
      ?.getAttribute('data-thread-id')===id,foregroundThreadId),'foreground Thread visible');
    await until(async()=>(await stateFor(foregroundThreadId)).workspace.selectedPageId===foregroundPageId,
      'foreground Browser Page selected');
    await nativeClick(foregroundNativeId,'h1');
    const focusFacts=()=>app.evaluate(({app,BrowserWindow,webContents})=>({
      windowFocused:BrowserWindow.getAllWindows()[0].isFocused(),
      nativeFocused:webContents.getFocusedWebContents()?.id,
      windowCount:BrowserWindow.getAllWindows().length,
    }));
    const before=await focusFacts();
    assert.equal(before.nativeFocused,foregroundNativeId);
    phase='backgroundObserve'; issued=false;
    await command('send',{projectId,threadId,text:'Observe the synthetic background page without changing the foreground chat'});
    const backgroundItem=browserItem(await terminalTurn(1));
    assert.equal(backgroundItem.success,true);
    const after=await focusFacts();
    const foregroundStillSelected=await page.evaluate(id=>document.querySelector('[data-testid="areal-workbench"]')
      ?.getAttribute('data-thread-id')===id,foregroundThreadId);
    assert.equal(foregroundStillSelected,true);
    assert.equal(after.windowFocused,before.windowFocused);
    assert.equal(after.nativeFocused,foregroundNativeId);
    assert.equal(after.windowCount,before.windowCount);
    events.backgroundFocus={foregroundThreadId,backgroundThreadId:threadId,foregroundPageId,
      secondPageId,foregroundNativeId,secondNativeId,before,after,itemId:backgroundItem.id,
      foregroundStillSelected};
    checks.push('B-07: background Thread Core Browser observation leaves foreground chat and Native focus intact');
  } else if (mode === 'lifecycle') {
    const originalNativeId=nativeId;
    const beforeGets=siteFacts.documentGets;
    const before=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`(()=>{
      const input=document.createElement('input');input.id='m1-hold';input.value='harmless-draft';document.body.append(input);
      const filler=document.createElement('div');filler.style.height='3000px';document.body.append(filler);
      window.scrollTo(0,700);return {value:input.value,scrollY:window.scrollY,url:location.href};})()`),nativeId);
    assert.ok(before.scrollY>0);
    await pv(threadId,{operation:'hide',pageId});
    const hidden=await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].contentView.children
      .find(view=>view.webContents?.id===id)?.getVisible(),originalNativeId);
    assert.equal(hidden,false);
    await pv(threadId,{operation:'show',pageId,visible:true});
    const shown=await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].contentView.children
      .find(view=>view.webContents?.id===id)?.getVisible(),originalNativeId);
    assert.equal(shown,true);
    const after=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`({
      value:document.querySelector('#m1-hold')?.value,scrollY:window.scrollY,url:location.href})`),originalNativeId);
    assert.deepEqual(after,before);
    assert.equal(siteFacts.documentGets,beforeGets,'hide/show must not navigate');
    events.hideShow={originalNativeId,before,after,documentGets:siteFacts.documentGets-beforeGets};
    checks.push('B-09: public hide and show preserve same Native view, harmless draft, scroll, and URL without navigation');

    await app.evaluate(({webContents},id)=>{globalThis.__m1OldSession=webContents.fromId(id).session;},originalNativeId);
    await page.getByRole('button',{name:'关闭面板'}).click();
    await pv(threadId,{operation:'release',pageId,userIntent:true});
    await until(async()=>(await stateFor(threadId)).workspace.pages.length===0,'last Page released');
    await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id),originalNativeId),'old Native view closed');
    await page.keyboard.press('Meta+t'); await page.locator('.preview-panel').waitFor();
    const selected=(await stateFor(threadId)).workspace?.selectedPageId;
    const reopenedPageId=selected??(await pv(threadId,{operation:'newPage'})).browser.pageId;
    await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});
    await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),
      'reopened Workspace Origin focus',120000);
    const reopenedUrl=`${siteUrl}&reopened=1`;
    await pv(threadId,{operation:'navigate',pageId:reopenedPageId,url:reopenedUrl});
    const reopenedNativeId=await wcByUrl(reopenedUrl);
    const reopenedStatus=await siteStatus(reopenedUrl);
    assert.equal(reopenedStatus.beforeLocal,null);
    assert.equal(reopenedStatus.idb.before,null);
    assert.equal(reopenedStatus.swBefore,0);
    const sessionChanged=await app.evaluate(({webContents},id)=>
      webContents.fromId(id).session!==globalThis.__m1OldSession,reopenedNativeId);
    assert.equal(sessionChanged,true);
    events.reopened={originalNativeId,reopenedNativeId,reopenedPageId,reopenedStatus,sessionChanged,
      originPromptCount:(await app.evaluate(()=>globalThis.__m1OriginPrompt))?.count};
    checks.push('B-08: reopening after last Page release starts a fresh Native Session with empty localStorage, IndexedDB, and Service Worker state');
  } else if (mode === 'download') {
    assert.ok(workerObserver.rootAutoAttachFiltered>0,'test driver root auto-attach filter applied');
    events.workerObserver={...workerObserver,
      playwrightWorkersBefore:app.context().serviceWorkers().map(worker=>worker.url())};
    assert.equal(events.workerObserver.playwrightWorkersBefore.length,0,
      'test driver must not attach the synthetic Service Worker');
    events.workerObserver.electronWorkersBefore=await app.evaluate(({webContents},id)=>
      Object.entries(webContents.fromId(id).session.serviceWorkers.getAllRunning())
        .map(([key,worker])=>({key,scope:worker.scope,scriptUrl:worker.scriptUrl,
          versionId:worker.versionId,renderProcessId:worker.renderProcessId})),nativeId);
    assert.equal(firstLoad.swAfter,1,'synthetic Service Worker registration remains active');
    await app.evaluate(({app,BrowserWindow,webContents},id)=>{
      const win=BrowserWindow.getAllWindows()[0];win.show();app.focus({steal:true});win.focus();
      webContents.fromId(id).focus();
      globalThis.__m1DownloadSession=webContents.fromId(id).session;
      globalThis.__m1DownloadEvents=[];
    },nativeId);
    await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),
      'download Main focused');
    const allowed=await pv(threadId,{operation:'allowNextDownload',pageId,userIntent:true});
    assert.ok(allowed.browser.downloadIntentExpiresAt);
    await app.evaluate(({webContents},{id,path})=>{
      const session=webContents.fromId(id).session;
      session.on('will-download',(_event,item,source)=>{
        if(source!==webContents.fromId(id))return;
        globalThis.__m1DownloadItem=item;
        item.on('updated',(_event,state)=>globalThis.__m1DownloadEvents.push({kind:'updated',state}));
        item.on('done',(_event,state)=>globalThis.__m1DownloadEvents.push({kind:'done',state}));
        // Task-only path stub verifies cancellation; it is not an OS Save dialog acceptance.
        item.setSavePath(path);
      });
    },{id:nativeId,path:join(scratch,'synthetic-download.txt')});
    await nativeClick(nativeId,'#slow-download');
    await until(()=>siteFacts.downloadStarts===1&&siteFacts.activeDownloads===1,'hanging synthetic download started');
    await until(()=>app.evaluate(()=>!!globalThis.__m1DownloadItem),'DownloadItem observed');
    const beforeClose=(await stateFor(threadId)).workspace.fileReceipts;
    await page.getByRole('button',{name:'关闭面板'}).click();
    await until(async()=>await page.locator('.preview-panel').count()===0,
      'public Preview closed before download Page release');
    await pv(threadId,{operation:'release',pageId,userIntent:true});
    await until(async()=>(await stateFor(threadId)).workspace.pages.length===0,
      'last download Page released');
    await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id),nativeId),'download Page Native view closed');
    await until(()=>siteFacts.activeDownloads===0,'hanging download network connection closed');
    await until(()=>app.evaluate(()=>globalThis.__m1DownloadEvents.some(event=>event.kind==='done')),
      'DownloadItem done after Page close');
    const finalEvents=await app.evaluate(()=>globalThis.__m1DownloadEvents);
    assert.equal(finalEvents.filter(event=>event.kind==='done').at(-1).state,'cancelled');
    const afterClose=(await stateFor(threadId)).workspace.fileReceipts;
    assert.ok(afterClose.some(record=>record.reason==='page_closed_after_dispatch'));
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.deepEqual((await stateFor(threadId)).workspace.fileReceipts,afterClose,
      'late DownloadItem callback cannot revive or rewrite the closed Page receipt');
    assert.equal(siteFacts.downloadStarts,1);
    events.downloadCleanup={nativeId,beforeClose,afterClose,finalEvents,
      releasedPages:(await stateFor(threadId)).workspace.pages.length,
      downloadStarts:siteFacts.downloadStarts,downloadCloses:siteFacts.downloadCloses,
      activeDownloads:siteFacts.activeDownloads,savePath:'task-only synthetic stub',
      playwrightWorkersAfter:app.context().serviceWorkers().map(worker=>worker.url())};
    assert.equal(events.downloadCleanup.playwrightWorkersAfter.length,0,
      'test driver remains detached from the synthetic Service Worker');
    const workerTimeline=[];
    for (const elapsedMs of [0,5000,15000,30000,55000]) {
      const waitMs=elapsedMs-(workerTimeline.at(-1)?.elapsedMs??0);
      if (waitMs>0) await new Promise(resolve=>setTimeout(resolve,waitMs));
      const running=await app.evaluate(()=>Object.entries(
        globalThis.__m1DownloadSession.serviceWorkers.getAllRunning()).map(([key,worker])=>({
        key,scope:worker.scope,scriptUrl:worker.scriptUrl,versionId:worker.versionId,
        renderProcessId:worker.renderProcessId})));
      workerTimeline.push({elapsedMs,running});
      events.downloadCleanup.workerTimeline=workerTimeline;
      if (running.length===0) break;
    }
    checks.push('B-09: closing a Page cancels its hanging synthetic DownloadItem and network stream, and preserves a conservative stable unknown receipt');
    assert.equal(workerTimeline.at(-1).running.length,0,'old temporary Session has no running workers');
    checks.push('B-08/B-09: old temporary Session has no running Service Worker after final Page release');
  } else {
  const sameOriginTarget = new URL('/?marker=first&redirect=same', siteUrl).href;
  await pv(threadId,{operation:'navigate',pageId,url:new URL('/redirect-same',siteUrl).href});
  await until(async()=>(await stateFor(threadId)).url===sameOriginTarget,'same-Origin redirect target');
  assert.equal(siteFacts.sameOriginRedirects,1);
  assert.ok(siteFacts.getRequests.some(item=>item.url==='/?marker=first&redirect=same'));
  events.sameOriginRedirect={count:siteFacts.sameOriginRedirects,target:sameOriginTarget,
    forbiddenRequests:siteFacts.forbiddenRequests};
  checks.push('B-23: granted synthetic same-Origin redirect reaches its target through Native policy');
  await pv(threadId,{operation:'navigate',pageId,url:siteUrl});
  await until(async()=>(await stateFor(threadId)).url===siteUrl,'initial site restored after redirect');
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(siteFacts.forbiddenRequests,0,'forbidden Worker, WebSocket, and Frame targets receive no request');
  events.policyProbes=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(
    'window.m1PolicyProbes'),nativeId);
  checks.push('B-23: granted synthetic top-level Origin cannot reach unapproved Worker, WebSocket, or Frame target');
  firstPages.push(await makePinned(threadId,pageId,siteUrl));
  await pv(threadId,{operation:'takeover',pageId});
  await until(async()=>(await stateFor(threadId)).browser?.control==='human','human popup owner');
  const topLevelBeforePopup=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
  await nativeClick(firstPages[0].wc,'#same-origin-popup');
  const popup=await until(async()=>{
    const state=await stateFor(threadId);
    return state.workspace.pages.find(item=>item.openerId===pageId&&item.pageId!==pageId)??null;
  },'same-Origin Native popup');
  assert.equal(popup.origin,'human');
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),topLevelBeforePopup);
  assert.equal((await stateFor(threadId)).workspace.pages.length,2);
  events.popup={openerId:pageId,childId:popup.pageId,origin:popup.origin,
    topLevelWindowsBefore:topLevelBeforePopup,
    topLevelWindowsAfter:await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)};
  await pv(threadId,{operation:'release',pageId:popup.pageId,userIntent:true});
  await until(async()=>(await stateFor(threadId)).workspace.pages.length===1,'popup child released');
  await until(async()=>await page.getByRole('tablist',{name:'浏览页面'}).getByRole('tab').first()
    .getAttribute('aria-selected')==='true','opener selected after popup close');
  await nativeClick(firstPages[0].wc,'#cross-origin-popup');
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal((await stateFor(threadId)).workspace.pages.length,1);
  assert.equal(siteFacts.forbiddenRequests,0);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),topLevelBeforePopup);
  checks.push('B-20: focused Native user popup into a different unapproved Origin creates no child or request');
  await pv(threadId,{operation:'claim',pageId});
  assert.equal((await stateFor(threadId)).browser.control,'agent');
  checks.push('B-20: focused Native user popup creates one same-Origin child with opener in the same workspace and no top-level window');
  for(let i=1;i<4;i++) {
    const next=await pv(threadId,{operation:'newPage',pageId});
    firstPages.push(await makePinned(threadId,next.browser.pageId,`${siteUrl}&page=${i}`));
  }
  assert.equal((await stateFor(threadId)).workspace.pages.length,4);
  const second=await command('create',{projectId,browserEnabled:true,profile:{id:'fixture',revision:'v1'}});
  await selectConversation(page,second.threadId);
  await page.keyboard.press('Meta+t'); await page.locator('.preview-panel').waitFor();
  await page.bringToFront();
  await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});
  await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),'second workspace focused',120000);
  const secondPages=[];
  for(let i=0;i<4;i++) {
    // Opening the public Preview already creates Page 1 for this Thread.
    if (i>0) await page.getByRole('button',{name:'新建浏览页面'}).click();
    const next=await until(async()=>{
      const value=await stateFor(second.threadId);
      return value.workspace.pages.length===i+1 ? value : null;
    },`second workspace page ${i+1}`);
    secondPages.push(await makePinned(second.threadId,next.browser.pageId,`${secondUrl}&page=${i}`));
  }
  assert.equal((await stateFor(second.threadId)).workspace.pages.length,4);
  assert.equal(await nativeCount(),8);
  events.storage={first:firstPages.map(item=>item.status),second:secondPages.map(item=>item.status),serviceWorkerGets:siteFacts.serviceWorkerGets};
  assert.equal(firstPages[0].status.beforeLocal,'first');
  assert.equal(firstPages[0].status.idb.before,'first');
  assert.ok(firstPages[0].status.swBefore>=1);
  assert.equal(firstPages[1].status.beforeLocal,'first');
  assert.equal(firstPages[1].status.idb.before,'first');
  assert.ok(firstPages[1].status.swBefore>=1);
  assert.equal(secondPages[0].status.beforeLocal,null);
  assert.equal(secondPages[0].status.idb.before,null);
  assert.equal(secondPages[0].status.swBefore,0);
  assert.equal(secondPages[1].status.beforeLocal,'second');
  assert.equal(secondPages[1].status.idb.before,'second');
  assert.ok(secondPages[1].status.swBefore>=1);
  checks.push('B-21/B-22: same-workspace Native pages share localStorage, IndexedDB, and Service Worker; separate Thread workspace starts empty');
  const third=await command('create',{projectId,browserEnabled:true,profile:{id:'fixture',revision:'v1'}});
  const allPinnedAttempt=await pv(third.threadId,{operation:'newPage'}).then(()=>({accepted:true}),error=>({accepted:false,message:error.message}));
  assert.equal(allPinnedAttempt.accepted,false);
  assert.match(allPinnedAttempt.message,/8页/);
  assert.equal(await nativeCount(),8,'all-pinned rejection occurs before Native View creation');
  assert.equal((await stateFor(third.threadId)).workspace.pages.length,0);
  events.allPinned={attempt:allPinnedAttempt,nativeCount:await nativeCount()};
  checks.push('B-24: global eight-page cap rejects ninth before Native create when all eight are Agent-pinned');
  await pv(threadId,{operation:'takeover',pageId:firstPages[0].id});
  assert.equal((await stateFor(threadId)).workspace.pages.find(item=>item.pageId===firstPages[0].id).control,'human');
  const ninth=await pv(third.threadId,{operation:'newPage'});
  assert.ok(ninth.browser?.pageId);
  assert.equal(await nativeCount(),8);
  const firstAfter=(await stateFor(threadId)).workspace.pages.find(item=>item.pageId===firstPages[0].id);
  assert.equal(firstAfter.resource,'suspended');
  events.eviction={oldPageId:firstPages[0].id,oldPage:firstAfter,newPageId:ninth.browser.pageId,nativeCount:await nativeCount()};
  checks.push('B-24: unpinned hidden old Page is suspended to admit ninth; logical Page ID and state-loss message remain');

  const cleanupBefore=await app.evaluate(({webContents},{first,second,url})=>{
    const a=webContents.fromId(first)?.session,b=webContents.fromId(second)?.session;
    if (!a || !b || a===b) throw Error('two live Workspace Sessions required before cleanup');
    globalThis.__m1CleanupSessions=[a,b];
    return Promise.all([a.cookies.get({url}),b.cookies.get({url})]).then(items=>items.map(value=>value.map(cookie=>cookie.name)));
  },{first:firstPages[1].wc,second:secondPages[0].wc,url:siteUrl});
  assert.ok(cleanupBefore.every(names=>names.includes('m1_session')));
  await page.getByRole('button',{name:'关闭面板'}).click();
  await until(async()=>await page.locator('.preview-panel').count()===0,'public Preview closed before final Page release');
  for(const tid of [threadId,second.threadId,third.threadId]) {
    const ids=(await stateFor(tid)).workspace.pages.map(item=>item.pageId);
    for(const id of ids) await pv(tid,{operation:'release',pageId:id,userIntent:true});
    assert.equal((await stateFor(tid)).workspace.pages.length,0);
    if (tid===threadId) {
      const other=await app.evaluate(async({webContents},id)=>{
        const c=webContents.fromId(id);
        return {localMarker:await c.executeJavaScript('localStorage.getItem("m1_marker")'),
          registrations:await c.executeJavaScript('navigator.serviceWorker.getRegistrations().then(items=>items.length)'),
          cookies:(await c.session.cookies.get({url:c.getURL()})).map(cookie=>cookie.name)};
      },secondPages[0].wc);
      assert.equal(other.localMarker,'second');
      assert.ok(other.cookies.includes('m1_session'));
      events.otherWorkspaceAfterFirstClose=other;
      checks.push('B-22: closing first Workspace leaves second Workspace storage and cookie live');
    }
  }
  await until(async()=>await nativeCount()===0,'all Browser Native Views released');
  const cleanupAfter=await until(()=>app.evaluate(async(_electron,url)=>{
    const sessions=globalThis.__m1CleanupSessions;
    const cookies=await Promise.all(sessions.map(item=>item.cookies.get({url})));
    return cookies.every(items=>items.length===0)?cookies.map(items=>items.length):null;
  },siteUrl),'temporary Workspace Session cookies cleared',10000);
  events.cleanup={beforeCookieNames:cleanupBefore,afterCookieCounts:cleanupAfter,nativeCount:await nativeCount()};
  checks.push('B-22/B-26: explicit Page closure releases both temporary Workspace Sessions and all owned Native Views');

  }

  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); model.closeAllConnections(); forbidden.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve)),
    new Promise(resolve => forbidden.close(resolve))]);
  const files = ['app/src/core/preview.cjs', 'app/src/core/main.cjs', 'app/src/core/backend.cjs', 'app/src/core/service-protocol.cjs',
    'renderer/src/Preview.tsx', 'renderer/src/UnknownToolInspection.tsx', 'scripts/browser-remaining-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, endedAt: new Date().toISOString(), mode, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    runtimeBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime'),
    runtimeBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime'))).digest('hex'),
    reaperBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-reaper'),
    reaperBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-reaper'))).digest('hex'),
    runtimeFsBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-fs'),
    runtimeFsBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-fs'))).digest('hex'),
    scope: 'source Electron + independent adapter + Core/Runtime + deterministic local model + synthetic site; OS chooser and exact-Origin bootstrap stubbed',
    entrypoint: 'node clients/gui/scripts/browser-remaining-smoke.mjs' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
