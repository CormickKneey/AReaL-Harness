import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const rendererRequire = createRequire(join(gui, 'renderer/package.json'));
const { chromium } = require('playwright-core');
const { createServer } = await import(pathToFileURL(rendererRequire.resolve('vite')).href);
const evidenceRoot = resolve(process.env.AREAL_EXECUTION_ARTIFACT_EVIDENCE ?? join(root, '.scratch/execution-artifact-ui'));
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, 'run-'));
const fixture = join(evidence, 'fixture.tsx');
const source = join(gui, 'renderer/src/ExecutionsPane.tsx');
const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
await writeFile(fixture, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ExecutionsPane} from '${source}';
import '${join(gui, 'renderer/src/styles.css')}';
const project={id:'artifact-project',state:{connected:true},core:{features:{executions:true}}};
const thread={id:'artifact-parent'};
const execution={executionId:'artifact-execution',parentThreadId:thread.id,title:'Artifact readiness acceptance',status:'completed',settled:true,resourcesReleased:true,text:'',error:null,verification:{status:'passed',kind:'project'},delivery:{status:'candidate'},artifact:{head:'candidate-head',workgroupId:'artifact-workgroup',available:true}};
let ready=false;
const calls=[];
const bytes=new TextEncoder().encode('FIRST_CHUNK_SENTINEL\\nSECOND_CHUNK_SENTINEL\\n');
const split=new TextEncoder().encode('FIRST_CHUNK_SENTINEL\\n').length;
window.executionArtifactFixture={calls,setReady(value=true){ready=value;},setHead(head){execution.artifact.head=head;}};
const action=async(name,params)=>{
  if(name!=='manage')throw Error('Unexpected command '+name);
  calls.push(structuredClone(params));
  if(params.projectId!==project.id||params.parentThreadId!==thread.id)throw Error('Incorrect execution ownership');
  if(params.operation==='executions')return {data:[execution],nextOffset:null};
  if(params.operation!=='executionArtifact')throw Error('Unexpected operation '+params.operation);
  if(!ready){const {parentThreadId,...view}=execution;return {ready:false,execution:{...view,settled:false,resourcesReleased:false,delivery:{status:'pending'},artifact:{...view.artifact,available:false}},nextAction:'wait for this execution to settle; no candidate bytes have been read'};}
  if(!params.path)return params.offset===0?{head:execution.artifact.head,paths:['main.txt'],nextOffset:1,complete:false}:{head:execution.artifact.head,paths:['second.txt'],nextOffset:2,complete:true};
  if(params.path!=='main.txt')throw Error('Unexpected artifact path '+params.path);
  const end=params.offset===0?split:bytes.length;
  return {path:params.path,head:execution.artifact.head,sha256:'fixture-main-sha256',bytes:bytes.length,offset:params.offset,nextOffset:end,complete:end===bytes.length,exists:true,dataBase64:btoa(String.fromCharCode(...bytes.slice(params.offset,end)))};
};
createRoot(document.getElementById('root')).render(<div style={{height:'100vh'}}><ExecutionsPane project={project} thread={thread} action={action} onOpen={()=>{}}/></div>);`);
const server = await createServer({
  root: join(gui, 'renderer'), configFile: join(gui, 'renderer/vite.config.ts'),
  mode: 'design-system', appType: 'custom',
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
});
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/execution-artifact-acceptance.html') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml(request.url, `<html><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`));
});
await server.listen();
let browser, page, passed = false, failure;
const checks = [], errors = [], consoleErrors = [];
const button = name => page.getByRole('button', { name, exact: true });
const artifactCalls = () => page.evaluate(() => window.executionArtifactFixture.calls.filter(call => call.operation === 'executionArtifact'));
async function capture(name) {
  await page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
  await writeFile(join(evidence, name + '.aria.txt'), await page.locator('body').ariaSnapshot());
}
async function settledRender() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function assertPending() {
  await settledRender();
  assert.deepEqual(errors, [], 'a legal Core ready=false response must not crash the renderer');
  await page.getByRole('status').filter({ hasText: /尚未就绪|未准备好|等待.*结算/ }).waitFor();
  assert.equal(await page.getByText(/交付文件读取失败/).count(), 0, 'not-ready is an ordinary observation rather than a read failure');
  await button('等待结果').waitFor();
  assert.equal(await button('查看交付文件').isEnabled(), false, 'the current receipt disables artifact reads until availability returns');
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1000, height: 850 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const origin = server.resolvedUrls.local[0];
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
  await page.goto(origin + 'execution-artifact-acceptance.html');
  await button('查看交付文件').waitFor();
  checks.push('production ExecutionsPane renders the stale candidate artifact action');
  await capture('01-stale-candidate');
  await button('查看交付文件').click();
  await assertPending();
  checks.push('ready=false file-list observation keeps the renderer alive and explains pending readiness');
  await capture('02-list-not-ready');
  await page.evaluate(() => window.executionArtifactFixture.setReady());
  await button('刷新子任务').click();
  await button('查看交付文件').click();
  await button('main.txt').waitFor();
  await button('更多交付文件').click();
  await button('second.txt').waitFor();
  assert.equal(await button('main.txt').count(), 1);
  assert.equal(await button('更多交付文件').count(), 0);
  checks.push('available artifact lists append the next page and retain the first page');
  await button('main.txt').click();
  await page.locator('pre').filter({ hasText: 'FIRST_CHUNK_SENTINEL' }).waitFor();
  await page.evaluate(() => window.executionArtifactFixture.setReady(false));
  await button('继续读取文件').click();
  await assertPending();
  assert.equal(await page.locator('pre').innerText(), 'FIRST_CHUNK_SENTINEL\n', 'same-head pending retains the bytes already read');
  assert.equal(await button('main.txt').count(), 1);
  assert.equal(await button('second.txt').count(), 1);
  assert.equal(await button('继续读取文件').isEnabled(), false);
  checks.push('ready=false file continuation remains a pending observation');
  await capture('03-file-not-ready');
  await page.evaluate(() => window.executionArtifactFixture.setReady());
  await button('刷新子任务').click();
  await button('继续读取文件').click();
  await page.locator('pre').filter({ hasText: 'SECOND_CHUNK_SENTINEL' }).waitFor();
  assert.equal(await page.locator('pre').innerText(), 'FIRST_CHUNK_SENTINEL\nSECOND_CHUNK_SENTINEL\n');
  assert.equal(await button('继续读取文件').count(), 0);
  assert.equal(await button('main.txt').count(), 1);
  assert.equal(await button('second.txt').count(), 1);
  const calls = await artifactCalls();
  assert.deepEqual(calls.filter(call => !call.path).map(call => call.offset), [0, 0, 1]);
  assert.deepEqual(calls.filter(call => call.path).map(call => call.offset), [0, 21, 21]);
  assert.deepEqual(errors, []);
  checks.push('available file continuation preserves the prior bytes and offset across not-ready without replay');
  await capture('04-recovered-complete');
  await page.evaluate(() => {
    window.executionArtifactFixture.setReady(false);
    window.executionArtifactFixture.setHead('replacement-head');
  });
  await button('查看交付文件').click();
  await assertPending();
  assert.equal(await page.locator('pre').count(), 0, 'a changed pending head invalidates the old preview');
  assert.equal(await button('main.txt').count(), 0, 'a changed pending head invalidates the old list');
  assert.equal(await button('second.txt').count(), 0);
  await page.evaluate(() => window.executionArtifactFixture.setReady());
  await button('刷新子任务').click();
  await button('查看交付文件').click();
  await button('main.txt').click();
  await page.locator('pre').filter({ hasText: 'FIRST_CHUNK_SENTINEL' }).waitFor();
  assert.equal(await page.locator('pre').innerText(), 'FIRST_CHUNK_SENTINEL\n');
  assert.equal((await artifactCalls()).at(-1).offset, 0, 'a replacement artifact starts from its first byte');
  checks.push('a changed readiness head clears old list and preview state before a fresh offset-zero read');
  await capture('05-replacement-head');
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) await capture('failure');
} finally {
  const calls = page ? await artifactCalls().catch(() => []) : [];
  await browser?.close();
  await server.close();
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({
    passed, failure, checks, errors, consoleErrors, calls, source, sourceHash,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirtyFiles: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
    scope: 'Production ExecutionsPane and buttons in Chrome. Deterministic Core management RPC boundary. No Electron, actual Core, provider, or package acceptance.',
  }, null, 2));
  console.log(JSON.stringify({ passed, evidence, failure, checks, errors }, null, 2));
}
