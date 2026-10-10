import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// Public Core tool calls, independent desktop adapter, real Electron and a synthetic site.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const startedAt = new Date().toISOString();
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-evidence-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const sentinel = 'EVIDENCE_PAGE_03';
const siteFacts = { gets: 0, posts: 0 };
const sibling = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<button>Cross origin child</button>'); });
await new Promise(resolve => sibling.listen(0, '127.0.0.1', resolve));
const childUrl = `http://127.0.0.1:${sibling.address().port}/`;
const site = createServer((request, response) => {
  if (request.method === 'POST') { siteFacts.posts++; response.end('ok'); return; }
  siteFacts.gets++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url.startsWith('/frame')) { response.end('<button>Same origin child</button><input name="token" value="HIDDEN_FRAME_TOKEN_03">'); return; }
  response.end(`<!doctype html><title>Evidence fixture</title><h1>${sentinel}</h1>
    <button id="replace">Duplicate target</button><button>Duplicate target</button><button disabled>Disabled action</button>
    <label>Password <input id="password" type="password" value="HIDDEN_CANARY_03"></label>
    <input id="session" name="token" aria-label="Session credential" value="HIDDEN_TOKEN_03">
    <div id="otp">One-time code: HIDDEN_OTP_03</div>
    <iframe id="same" src="/frame"></iframe><iframe id="cross" src="${childUrl}"></iframe>
    <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow target</button><input name="secret" value="HIDDEN_SHADOW_SECRET_03">';</script>
    <div style="height:2000px"></div>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?token=SYNTHETIC_SECRET_03`;
let pageId, rootRef, scenario = 'observe';
const modelCalls = [];
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1);
  modelCalls.push({ scenario, hadImage: JSON.stringify(body.messages).includes('data:image/png;base64,'), tools: (body.tools ?? []).map(t => t.function?.name) });
  await until(() => pageId, 'page identity');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (last?.role !== 'tool') {
    const parameters = { pageId };
    if (scenario === 'stale') parameters.rootRef = rootRef;
    if (scenario === 'budget') parameters.budget = { nodes: 1, textBytes: 256 };
    if (scenario === 'capture') parameters.scope = 'viewport';
    send({ tool_calls: [{ index: 0, id: `${scenario}-03`, type: 'function', function: {
      name: 'browser_v1', arguments: JSON.stringify({ operation: scenario === 'capture' ? 'capture' : 'observe', parameters }),
    } }] });
    send({}, 'tool_calls');
  } else { send({ content: `Fixture checked ${scenario}` }); send({}, 'stop'); }
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
let app, page, passed = false;
const checks = [], errors = [], events = {};
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timeout: ${label}`);
}
async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function thread(id) { return Object.values((await state()).projects[0]?.state?.threads ?? {}).find(item => item.id === id); }
async function nextTurn(id, previous = 0) {
  return until(async () => { const value = await thread(id); return value?.turns?.length > previous && value.turns.at(-1)?.status === 'completed' ? value.turns.at(-1) : null; }, 'Core browser turn');
}
function toolResult(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1');
  assert.ok(item, 'Core history contains browser tool');
  return item;
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  events.runtime = await app.evaluate(() => ({ versions: process.versions, platform: process.platform, arch: process.arch }));
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === 'ready', 'desktop ready');
  events.coreChildProbe = await app.evaluate(({ app }, binary) => {
    const { spawnSync } = process.getBuiltinModule('node:child_process');
    const output = spawnSync(binary, ['--version'], { env: { ...process.env, HOME: process.env.AREAL_CORE_USER_HOME }, encoding: 'utf8' });
    const plain = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    const system = spawnSync('/usr/bin/true', [], { encoding: 'utf8' });
    return { exit: output.status, signal: output.signal, stdout: output.stdout, stderr: output.stderr,
      plain: { exit: plain.status, signal: plain.signal }, system: { exit: system.status, signal: system.signal },
      electronSandbox: app.isPackaged, homeExists: process.getBuiltinModule('node:fs').existsSync(process.env.AREAL_CORE_USER_HOME) };
  }, env.AREAL_CORE_BIN);
  await app.evaluate(({ dialog, BrowserWindow }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); BrowserWindow.getAllWindows()[0].setSize(1440, 960); }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(async () => (await state()).projects.find(item => item.root === workspace), 'project ready');
  const first = await command('create', { projectId: project.id, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  await selectConversation(page, first.threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }), { projectId: project.id, threadId: first.threadId, url: siteUrl });
  const nativeId = await until(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url)?.id, siteUrl), 'native page');
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id), trace = { capturePage: 0, fullAXTree: 0 };
    const capture = contents.capturePage.bind(contents), send = contents.debugger.sendCommand.bind(contents.debugger);
    contents.capturePage = (...args) => { trace.capturePage++; return capture(...args); };
    contents.debugger.sendCommand = (method, ...args) => {
      if (method === 'Accessibility.getFullAXTree') trace.fullAXTree++;
      return send(method, ...args);
    };
    contents.__browserEvidenceTrace = trace;
  }, nativeId);
  const nativeTrace = () => app.evaluate(({ webContents }, id) => ({ ...webContents.fromId(id).__browserEvidenceTrace }), nativeId);
  const traceBeforeObserve = await nativeTrace();
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => { const value = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId: project.id, threadId: first.threadId }); return value.browser?.control === 'agent' ? value : null; }, 'claim')).browser.pageId;
  const initial = toolResult(await nextTurn(first.threadId));
  let completedTurns = 1;
  async function runScenario(nextScenario, prompt) {
    scenario = nextScenario;
    await command('send', { projectId: project.id, threadId: first.threadId, text: prompt });
    return toolResult(await nextTurn(first.threadId, completedTurns++));
  }
  const observation = JSON.parse(initial.contentItems[0].text);
  rootRef = observation.nodes.find(node => node.name === 'Duplicate target')?.ref;
  assert.match(rootRef, /^r\d+$/);
  assert.equal(observation.nativeWebContentsId, nativeId);
  assert.equal(observation.frameCoverage.childFrames.length, 2);
  assert.ok(observation.frameCoverage.childFrames.every(frame => ['covered', 'unavailable'].includes(frame.coverage)));
  assert.equal(observation.shadowCoverage, 'not-distinguished-by-accessibility-tree');
  assert.ok(observation.text.includes(sentinel));
  assert.ok(!JSON.stringify(observation).includes('SYNTHETIC_SECRET_03'));
  assert.ok(!JSON.stringify(observation).includes('HIDDEN_CANARY_03'));
  assert.ok(!JSON.stringify(observation).includes('HIDDEN_TOKEN_03'));
  assert.ok(!JSON.stringify(observation).includes('HIDDEN_FRAME_TOKEN_03'));
  assert.ok(!JSON.stringify(observation).includes('HIDDEN_SHADOW_SECRET_03'));
  assert.ok(!JSON.stringify(observation).includes('HIDDEN_OTP_03'));
  assert.ok(observation.nodes.every(node => node.id && node.role && typeof node.state === 'object'));
  assert.ok(observation.nodes.some(node => node.parent), 'AX observation preserves association hierarchy');
  assert.ok(observation.nodes.some(node => node.role === 'button' && node.name === 'Duplicate target'));
  assert.equal(observation.nodes.find(node => node.name === 'Disabled action')?.state.disabled, 'true');
  events.initial = { threadId: first.threadId, callId: initial.callId, observation };
  const initialTrace = await nativeTrace();
  assert.ok(initialTrace.fullAXTree > 0);
  assert.equal(initialTrace.capturePage, traceBeforeObserve.capturePage, 'observe must not generate a screenshot');
  const originalRef = rootRef;
  const partial = JSON.parse((await runScenario('budget', 'Observe one node only')).contentItems[0].text);
  assert.equal(partial.nodes.length, 1);
  assert.ok(!partial.nodes.some(node => node.ref === originalRef), 'budget omits the original target');
  const retained = JSON.parse((await runScenario('stale', 'Observe the unchanged target after a partial snapshot')).contentItems[0].text);
  assert.equal(retained.nodes.find(node => node.name === 'Duplicate target')?.ref, originalRef);
  events.partialIdentity = { partial, retainedRef: originalRef };
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#replace').outerHTML='<button id="replace">Duplicate target</button>'`), nativeId);
  const stale = await runScenario('stale', 'Observe old Ref after replacement');
  assert.match(JSON.stringify(stale), /stale_ref/);
  events.stale = { callId: stale.callId, contentItems: stale.contentItems };
  const refreshed = JSON.parse((await runScenario('refresh', 'Refresh semantic Ref')).contentItems[0].text);
  rootRef = refreshed.nodes.find(node => node.name === 'Duplicate target')?.ref;
  assert.match(rootRef, /^r\d+$/);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#same').src='/frame?revision=2'`), nativeId);
  await until(async () => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#same').contentWindow.location.search === '?revision=2'`), nativeId), 'frame document replaced');
  const frameStale = await runScenario('stale', 'Observe old Ref after frame document navigation');
  assert.match(JSON.stringify(frameStale), /stale_ref/);
  events.frameStale = { callId: frameStale.callId, contentItems: frameStale.contentItems };
  checks.push('B-07: duplicate-name replacement and Frame document navigation invalidate old Refs through Core without fallback');
  const bounded = JSON.parse((await runScenario('budget', 'Observe bounded page')).contentItems[0].text);
  assert.equal(bounded.nodes.length, 1); assert.equal(bounded.truncated, true);
  assert.equal(bounded.truncationReason, 'budget');
  events.budget = bounded;
  const beforeCaptureTrace = await nativeTrace();
  assert.equal(beforeCaptureTrace.capturePage, traceBeforeObserve.capturePage, 'all observe calls remain semantic-only');
  events.surfaceTraceBeforeCapture = beforeCaptureTrace;
  checks.push('B-08: real iframe and Shadow fixture has explicit coverage, bounded observation reports truncation');
  async function pageScript(script) {
    return app.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id: nativeId, script });
  }
  const locations = () => pageScript(`({
    root: !!document.querySelector('#password, #session'),
    frame: !!document.querySelector('#same').contentDocument.querySelector('input'),
    shadow: !!document.querySelector('#shadow').shadowRoot.querySelector('input'),
    otp: !!document.querySelector('#otp'), cross: !!document.querySelector('#cross')
  })`);
  await pageScript(`document.querySelector('#password').remove();document.querySelector('#session').remove();
    document.querySelector('#same').contentDocument.querySelector('input').remove();
    document.querySelector('#shadow').shadowRoot.querySelector('input').remove();
    document.querySelector('#otp').remove();document.querySelector('#cross').remove()`);
  assert.deepEqual(await locations(), { root: false, frame: false, shadow: false, otp: false, cross: false });
  await pageScript(`(() => {
    document.body.insertAdjacentHTML('beforeend', '<input id="spoof-secret" type="password" value="SPOOFED_SECRET_03">');
    const originals = {
      documentQuery: Document.prototype.querySelector, documentAll: Document.prototype.querySelectorAll,
      elementQuery: Element.prototype.querySelector, elementAll: Element.prototype.querySelectorAll,
      width: Object.getOwnPropertyDescriptor(window, 'innerWidth')
    };
    Document.prototype.querySelector = Element.prototype.querySelector = () => null;
    Document.prototype.querySelectorAll = Element.prototype.querySelectorAll = () => [];
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1 });
    window.__restoreBrowserEvidence = () => {
      Document.prototype.querySelector = originals.documentQuery;
      Document.prototype.querySelectorAll = originals.documentAll;
      Element.prototype.querySelector = originals.elementQuery;
      Element.prototype.querySelectorAll = originals.elementAll;
      if (originals.width) Object.defineProperty(window, 'innerWidth', originals.width);
      else delete window.innerWidth;
    };
  })()`);
  const spoofedCapture = await runScenario('capture', 'Capture while page scripts hide a password field');
  assert.match(JSON.stringify(spoofedCapture), /evidence_unavailable/);
  const spoofedObservation = JSON.parse((await runScenario('refresh', 'Observe while page scripts spoof viewport width')).contentItems[0].text);
  assert.ok(spoofedObservation.viewport.width > 100, 'trusted viewport ignores main-world width spoof');
  await pageScript(`window.__restoreBrowserEvidence();document.querySelector('#spoof-secret').remove();delete window.__restoreBrowserEvidence`);
  events.mainWorldSpoof = { capture: spoofedCapture.contentItems, trustedWidth: spoofedObservation.viewport.width };
  const captureOnlyTrace = await nativeTrace();
  const safeBaseline = await runScenario('capture', 'Capture the safe baseline before isolated refusals');
  assert.ok(safeBaseline.contentItems.some(part => part.type === 'arealMedia'), 'baseline page must be capturable');
  events.safeBaseline = { callId: safeBaseline.callId };
  const cases = [
    ['root', `document.body.insertAdjacentHTML('beforeend','<input id="password" type="password" value="ROOT_SECRET_03">')`, `document.querySelector('#password').remove()`],
    ['frame', `document.querySelector('#same').contentDocument.body.insertAdjacentHTML('beforeend','<input name="token" value="FRAME_SECRET_03">')`, `document.querySelector('#same').contentDocument.querySelector('input').remove()`],
    ['shadow', `document.querySelector('#shadow').shadowRoot.innerHTML += '<input name="secret" value="SHADOW_SECRET_03">'`, `document.querySelector('#shadow').shadowRoot.querySelector('input').remove()`],
    ['otp', `document.body.insertAdjacentHTML('beforeend','<div id="otp">One-time code: OTP_SECRET_03</div>')`, `document.querySelector('#otp').remove()`],
    ['cross', `document.body.insertAdjacentHTML('beforeend','<iframe id="cross" src="${childUrl}"></iframe>')`, `document.querySelector('#cross').remove()`],
  ];
  events.sensitiveCapture = {};
  for (const [kind, add, remove] of cases) {
    await pageScript(add);
    if (kind === 'cross') await until(() => pageScript(`document.querySelector('#cross').contentDocument === null`), 'cross origin iframe loaded');
    assert.deepEqual(Object.entries(await locations()).filter(([, present]) => present).map(([name]) => name), [kind], `${kind} is the only denying condition`);
    const denied = await runScenario('capture', `Capture with only ${kind} sensitive condition`);
    assert.match(JSON.stringify(denied), /evidence_unavailable/);
    events.sensitiveCapture[kind] = denied.contentItems;
    await pageScript(remove);
    assert.deepEqual(Object.values(await locations()), [false, false, false, false, false]);
  }
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id), original = contents.capturePage;
    contents.capturePage = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      await contents.executeJavaScript('scrollTo(0, 500)');
      return original(...args);
    };
    contents.__captureBeforeViewport = original;
  }, nativeId);
  const movedViewportCapture = await runScenario('capture', 'Capture while the viewport changes');
  assert.match(JSON.stringify(movedViewportCapture), /evidence_unavailable/);
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    contents.capturePage = contents.__captureBeforeViewport;
    delete contents.__captureBeforeViewport;
    return contents.executeJavaScript('scrollTo(0, 0)');
  }, nativeId);
  events.movedViewportCapture = movedViewportCapture.contentItems;
  await pageScript(`(async () => {
    const canvas = document.createElement('canvas'); canvas.id = 'noise';
    canvas.width = Math.ceil(innerWidth * devicePixelRatio);
    canvas.height = Math.ceil(innerHeight * devicePixelRatio);
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '9999' });
    const context = canvas.getContext('2d'), pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 0x12345678;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255;
      pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0); document.body.append(canvas);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const largeImageBytes = await app.evaluate(async ({ webContents }, id) =>
    (await webContents.fromId(id).capturePage()).toPNG().length, nativeId);
  assert.ok(largeImageBytes > 2 * 1024 * 1024, `fixture must produce an oversized native PNG; got ${largeImageBytes} bytes`);
  const oversizedCapture = await runScenario('capture', 'Capture an image above the encoded byte budget');
  assert.match(JSON.stringify(oversizedCapture), /evidence_unavailable/);
  events.oversizedCapture = { nativePngBytes: largeImageBytes, contentItems: oversizedCapture.contentItems };
  await pageScript(`(async () => {
    document.querySelector('#noise').remove();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const captured = await runScenario('capture', 'Capture after sensitive conditions are removed');
  const afterCaptureTrace = await nativeTrace();
  assert.ok(afterCaptureTrace.capturePage > beforeCaptureTrace.capturePage);
  assert.equal(afterCaptureTrace.fullAXTree, captureOnlyTrace.fullAXTree, 'capture must not request the accessibility tree');
  events.surfaceTraceAfterCapture = afterCaptureTrace;
  const image = captured.contentItems.find(part => part.type === 'arealMedia');
  assert.ok(image?.media?.uri?.startsWith('areal://blob/'));
  assert.ok(modelCalls.some(call => call.scenario === 'capture' && call.hadImage), 'model request must contain image bytes');
  await page.locator(`[data-tool-id="${captured.id}"]`).getByRole('button').first().click();
  await page.locator(`[data-tool-id="${captured.id}"] img`).waitFor();
  await page.screenshot({ path: join(scratch, 'gui-image.png'), animations: 'disabled' });
  const nativePng = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), nativeId);
  await writeFile(join(scratch, 'native-page.png'), Buffer.from(nativePng, 'base64'));
  const second = await command('create', { projectId: project.id, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  const metadata = JSON.parse(await readFile(join(scratch, 'core', 'service.json'), 'utf8'));
  const url = new URL(metadata.endpoint); url.protocol = 'http:'; url.pathname = `/areal/blobs/${image.media.uri.split('/').at(-1)}`; url.searchParams.set('threadId', second.threadId);
  const denied = await fetch(url, { headers: { Authorization: `Bearer ${metadata.token}` } });
  assert.notEqual(denied.status, 200, 'different Thread must not read screenshot Blob');
  events.image = { threadId: first.threadId, callId: captured.callId, nativeId, media: image.media, crossThreadStatus: denied.status, siteFacts: structuredClone(siteFacts) };
  checks.push('B-09: Core tool image reaches deterministic model and GUI, Blob rejects another Thread');
  assert.equal(siteFacts.posts, 0);
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); sibling.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => sibling.close(resolve)), new Promise(resolve => model.close(resolve))]);
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/backend.cjs', 'app/src/core/service-protocol.cjs',
    'app/src/core/preview.cjs', 'app/src/core/main.cjs', 'renderer/src/Messages.tsx', 'renderer/src/ToolEvent.tsx',
    'scripts/browser-evidence-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, finishedAt: new Date().toISOString(), command: 'node clients/gui/scripts/browser-evidence-smoke.mjs',
    fixture: 'synthetic site and deterministic local chat-completions model in this script',
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    scope: 'source Electron + Core/Runtime + independent adapter + deterministic model + synthetic sites' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
