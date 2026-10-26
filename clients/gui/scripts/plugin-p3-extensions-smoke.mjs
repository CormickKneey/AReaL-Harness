import { makeTempDir } from "./support/temp.mjs";
// Actual Electron/Core package workflow. External inference alone is deterministic.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  captureSmokeFailure,
  createProjectConversation,
  selectConversation,
} from "./smoke-navigation.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-plugin-extensions-"),
  workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
// Failure boundaries planned before implementation:
// settings capability never renders; a save changes unrelated fields or replays;
// mention search loses resource identity or sends a draft to inference;
// legacy reverse request never reaches its owning thread, leaks into another thread,
// accept/cancel replies use a different request ID or fail to settle the original call;
// file entrypoint bypasses native context grant or exposes an absolute path to the app.
// This script does not claim file writes/CAS/ancestor-race, uploads, MRTR or real providers.
const source = join(workspace, "packages", "hello"),
  transportLog = join(scratch, "mcp.jsonl");
await mkdir(source, { recursive: true });
await writeFile(
  join(source, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "hello",
    version: "1.0.0",
    description: "Desktop extension acceptance fixture.",
    extensions: { "com.openai": { interface: { displayName: "Extensions Fixture" } } },
  }),
);
const appHtml = `<!doctype html><html><body><h1>Extensions fixture</h1><output id="ready">waiting</output><output id="result"></output><output id="input"></output><button id="form-accept">Request accept form</button><button id="form-cancel">Request cancel form</button><button id="read-file">Read opened file</button><script>
let seq=0,input={};const pending=new Map();const log=[];window.fixtureLog=log;
function call(method,params){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
addEventListener('message',event=>{if(event.source!==parent)return;const value=event.data;if(value.jsonrpc!=='2.0')return;log.push(value);if(value.method==='ui/notifications/tool-input'){input=value.params.arguments;document.getElementById('input').textContent=JSON.stringify(input);}if(pending.has(value.id)){const p=pending.get(value.id);pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);}});
const show=async action=>{document.getElementById('result').textContent='pending';try{document.getElementById('result').textContent=JSON.stringify(await action());}catch(error){document.getElementById('result').textContent='ERROR: '+error.message;}};
for(const kind of ['accept','cancel'])document.getElementById('form-'+kind).onclick=()=>show(()=>call('tools/call',{name:'fixture.form',arguments:{kind}}));
document.getElementById('read-file').onclick=()=>show(()=>call('resources/read',{uri:input.file.resourceUri,_meta:{'openai/resource':{representation:'text'}}}));
call('ui/initialize',{appInfo:{name:'extensions-fixture',version:'1'},protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline','fullscreen']}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.getElementById('ready').textContent='initialized';});
</script></body></html>`;
await writeFile(join(source, "app.html"), appHtml);
const fixtureServer = String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const log=value=>appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(value)+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
log({event:'started'});let enabled=true;const awaiting=new Map();let reverseId=0;
const appMeta=entrypoints=>({ui:{resourceUri:'ui://fixture/extensions',visibility:['model']},'openai/ui':{entrypoints}});
const tools=[{name:'fixture.open',title:'Extension App',inputSchema:{type:'object'},annotations:{readOnlyHint:true},_meta:appMeta([{type:'global'},{type:'thread'}])},{name:'fixture.file',title:'Fixture File Viewer',inputSchema:{type:'object',properties:{file:{type:'object',properties:{name:{type:'string'},resourceUri:{type:'string'}},required:['name','resourceUri']}},required:['file']},annotations:{readOnlyHint:true},_meta:appMeta([{type:'file',extensions:['.txt']}])},{name:'fixture.form',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['accept','cancel']}},required:['kind']},annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}},{name:'fixture.settings.read',inputSchema:{type:'object'},annotations:{readOnlyHint:true},outputSchema:{type:'object',properties:{schema:{type:'object'},values:{type:'object'},layout:{type:'array',items:{type:'object'}}},required:['schema','values']}},{name:'fixture.settings.update',inputSchema:{type:'object',properties:{set:{type:'object'}},required:['set']},annotations:{readOnlyHint:true}},{name:'fixture.mentions',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}}];
for await(const line of createInterface({input:process.stdin})){let q;try{q=JSON.parse(line);log({event:'wire',...q});if(!q.method){const call=awaiting.get(q.id);if(call){awaiting.delete(q.id);send({jsonrpc:'2.0',id:call.id,result:{content:[{type:'text',text:'FORM_SETTLED_'+call.kind+'_'+q.result?.action}]}});}continue;}if(q.id===undefined)continue;let result;
switch(q.method){case'initialize':result={protocolVersion:q.params.protocolVersion,serverInfo:{name:'extensions-fixture',version:'1'},capabilities:{tools:{},resources:{},extensions:{'io.modelcontextprotocol/ui':{},'openai/settings':{readTool:'fixture.settings.read',updateTool:'fixture.settings.update'},'openai/mentions':{searchTool:'fixture.mentions'}}}};break;
case'ping':result={};break;case'tools/list':result={tools};break;case'resources/list':result={resources:[{uri:'ui://fixture/extensions',name:'Extensions app',mimeType:'text/html;profile=mcp-app'}]};break;case'resources/templates/list':result={resourceTemplates:[]};break;
case'resources/read':result={contents:[{uri:q.params.uri,mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};break;
case'tools/call':switch(q.params.name){case'fixture.open':case'fixture.file':result={content:[{type:'text',text:'APP_OPENED'}]};break;case'fixture.settings.read':result={content:[],structuredContent:{schema:{type:'object',properties:{enabled:{type:'boolean',title:'Enabled'},label:{type:'string',title:'Unchanged label'}},required:['enabled','label']},values:{enabled,label:'KEEP_LABEL'},layout:[{kind:'group',title:'Fixture settings',items:[{kind:'property',property:'enabled'},{kind:'property',property:'label'}]}]}};break;case'fixture.settings.update':if(typeof q.params.arguments.set.enabled!=='boolean'||Object.keys(q.params.arguments.set).length!==1)throw Error('Only the changed field may be sent');enabled=q.params.arguments.set.enabled;result={content:[{type:'text',text:'SETTINGS_SAVED'}]};break;case'fixture.mentions':result={content:[],structuredContent:{items:[{type:'resource_link',uri:'fixture://issues/42',name:'Fixture issue 42',title:'Extension issue 42',mimeType:'text/plain',_meta:{'openai/title':'Issue reference'}}]}};break;case'fixture.form':{const id='legacy-form-'+(++reverseId),kind=q.params.arguments.kind;awaiting.set(id,{id:q.id,kind});log({event:'form-issued',id,callId:q.id,kind});send({jsonrpc:'2.0',id,method:'elicitation/create',params:{mode:'form',message:'Fixture legacy '+kind,requestedSchema:{type:'object',properties:{answer:{type:'string',title:'Fixture answer',minLength:1}},required:['answer']}}});continue;}default:throw Error('unknown tool');}break;default:throw Error('unsupported method');}
send({jsonrpc:'2.0',id:q.id,result});}catch(error){if(q?.id!==undefined)send({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:error.message}});}}
`;
await writeFile(join(source, "server.mjs"), fixtureServer);
await writeFile(
  join(source, "mcp.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      fixture: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/server.mjs"],
        env: { FIXTURE_LOG: transportLog },
      },
    },
  }),
);
await writeFile(join(workspace, "sample.txt"), "OPAQUE_FILE_READ_MARKER\n");
await writeFile(
  join(workspace, ".agents", "plugins", "marketplace.json"),
  JSON.stringify({
    name: "gui-p0",
    plugins: [
      {
        name: "hello",
        source: { source: "local", path: "./packages/hello" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  }),
);
async function transportEvents() {
  try {
    return (await readFile(transportLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
const sourceRoot = resolve(gui, "../..");
const sourceFiles = {};
for (const path of new Set(
  execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], {
    cwd: sourceRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean),
)) {
  if (/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path))
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(sourceRoot, path)))
      .digest("hex");
}
const sourceDiffSha256 = createHash("sha256")
  .update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: sourceRoot }))
  .digest("hex");
const requests = [],
  titleRequests = [],
  checks = [],
  errors = [];
const model = createServer(async (req, res) => {
  let body = "";
  for await (const p of req) body += p;
  const request = JSON.parse(body);
  const system = request.messages?.find((message) => message.role === "system")?.content;
  if (
    typeof system === "string" &&
    system.startsWith(
      "Generate a concise semantic session title in the user's language from the conversation data.",
    ) &&
    !request.tools?.length
  )
    titleRequests.push(request);
  else requests.push(request);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "GUI_PLUGIN_SETUP_OK" }, finish_reason: null }],
      }) +
      "\n\n" +
      "data: " +
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
await writeFile(
  join(userHome, ".areal", "config.toml"),
  'schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:' +
    model.address().port +
    '"\n',
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN ?? resolve(gui, "../../target/debug/areal"),
};
for (const k of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[k];
const coreBinary = env.AREAL_CORE_BIN,
  coreSha256 = createHash("sha256")
    .update(await readFile(coreBinary))
    .digest("hex");
const fixtureApp = join(scratch, "app"),
  mainErrorsPath = join(scratch, "main-errors.jsonl");
await mkdir(fixtureApp);
await writeFile(mainErrorsPath, "");
await writeFile(
  join(fixtureApp, "package.json"),
  JSON.stringify({ name: "plugin-extensions-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(fixtureApp, "bootstrap.cjs"),
  `
process.on('uncaughtExceptionMonitor',(error,origin)=>require('node:fs').appendFileSync(${JSON.stringify(mainErrorsPath)},JSON.stringify({pid:process.pid,origin,name:error.name,message:error.message,stack:error.stack})+'\\n'));
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
);
let app,
  page,
  appProcess,
  failure,
  passed = false;
const cleanup = {};
const button = (n) => page.getByRole("button", { name: n, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function until(fn, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const s = await state();
    if (fn(s)) return s;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw Error("timeout: " + label);
}
async function waitEvents(predicate, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const events = await transportEvents();
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("timeout: " + label);
}
async function appFrame() {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const active = page.getByRole("region", { name: "MCP 应用", exact: true }).locator("iframe");
    const source = (await active.count()) ? await active.getAttribute("src") : null;
    const token = source ? new URL(source).hostname : null;
    const frame = page.frames().find((frame) => frame.url() === `areal-mcp://${token}/view`);
    if (frame) {
      await frame.locator("#ready").filter({ hasText: "initialized" }).waitFor();
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("sandbox app frame missing");
}
async function settings() {
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  const installed = page
    .getByRole("complementary", { name: "插件导航", exact: true })
    .getByRole("button", { name: "Extensions Fixture", exact: true });
  if (await installed.isVisible()) {
    await installed.click();
    return;
  }
  if (await button("返回插件列表").isVisible()) await button("返回插件列表").click();
  await page
    .getByRole("tablist", { name: "市场范围", exact: true })
    .getByRole("tab", { name: "个人", exact: true })
    .click();
  await button("查看插件 hello@gui-p0").click();
}
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixtureApp],
    env,
    timeout: 120_000,
  });
  appProcess = app.process();
  await writeFile(
    join(scratch, "run.json"),
    JSON.stringify({ pid: appProcess.pid, scratch, coreBinary }),
  );
  console.log("Electron " + appProcess.pid + " " + scratch);
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120_000 });
  await until((s) => s.connection?.state === "ready", "desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await until((s) => s.projects[0]?.state?.connected, "chosen project connected");
  if (await button("返回应用").isVisible()) await button("返回应用").click();
  await page.getByTestId("chat-input").waitFor();
  const ready = await until((s) => s.projects[0]?.state?.connected, "project connected"),
    _projectId = ready.projects[0].id;
  await settings();
  await button("核对来源并安装").click();
  await page
    .getByRole("checkbox", { name: "我已核对以上来源、版本和内容摘要", exact: true })
    .check();
  await button("安装到用户").click();
  await button("审阅并连接").waitFor();
  await button("审阅并连接").click();
  await page
    .getByRole("checkbox", { name: "我信任当前安装快照，并允许启动其 MCP 服务。", exact: true })
    .check();
  await button("信任并连接").click();
  await waitEvents(
    (events) => events.some((event) => event.method === "tools/list"),
    "real MCP transport started",
  );
  await button("刷新应用").click();
  await button("Extension App").first().click();
  let inner = await appFrame();
  const ownerThread = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert(ownerThread);
  // Settings through product controls, with transport observation only.
  await settings();
  await button("打开应用设置").click();
  await page.getByLabel("Enabled", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Enabled", { exact: true }).isChecked(), true);
  await page.getByLabel("Enabled", { exact: true }).uncheck();
  await button("保存设置").click();
  await waitEvents(
    (events) =>
      events.some(
        (event) => event.method === "tools/call" && event.params.name === "fixture.settings.update",
      ),
    "settings update",
  );
  await button("保存设置").waitFor();
  assert.equal(await page.getByLabel("Enabled", { exact: true }).isChecked(), false);
  assert.equal(
    await page.getByLabel("Unchanged label", { exact: true }).inputValue(),
    "KEEP_LABEL",
  );
  const updates = (await transportEvents()).filter(
    (event) => event.method === "tools/call" && event.params.name === "fixture.settings.update",
  );
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params.arguments, { set: { enabled: false } });
  checks.push(
    "declared settings read/update render and save through UI; only changed field is sent exactly once",
  );
  await button("Extension App").first().click();
  inner = await appFrame();
  // Mentions remain an editable typed reference in the active ordinary composer.
  const input = page.getByTestId("chat-input");
  await input.fill("HUMAN_PREFIX @");
  await page.getByLabel("搜索引用", { exact: true }).fill("42");
  await button("Extension issue 42").click();
  assert((await input.innerText()).includes("HUMAN_PREFIX"));
  await page.getByText("Extension issue 42", { exact: true }).waitFor();
  assert.equal(requests.length, 0);
  const mentionEvents = await waitEvents(
    (events) =>
      events.some(
        (event) =>
          event.method === "tools/call" &&
          event.params.name === "fixture.mentions" &&
          event.params.arguments.query === "42",
      ),
    "mention query",
  );
  assert(mentionEvents.some((event) => event.params?.arguments?.query === "42"));
  checks.push(
    "@ search uses declared mention tool and preserves resource identity without sending conversational inference",
  );
  // A server reverse request is created only by the visible app button.
  await inner.locator("#form-accept").click();
  const acceptForm = page
    .locator("form")
    .filter({ has: page.getByText("Fixture legacy accept", { exact: true }) });
  await acceptForm.waitFor();
  await acceptForm.getByLabel("Fixture answer", { exact: true }).fill("ACCEPT_VALUE");
  await page.screenshot({ path: join(scratch, "legacy-form-owned.png"), animations: "disabled" });
  await createProjectConversation(page, "workspace");
  const otherThread = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.notEqual(otherThread, ownerThread);
  assert.equal(
    await page.getByText("Fixture legacy accept", { exact: true }).count(),
    0,
    "pending form leaked to another thread",
  );
  await selectConversation(page, ownerThread);
  await acceptForm.waitFor();
  await acceptForm.getByLabel("Fixture answer", { exact: true }).fill("ACCEPT_VALUE");
  await acceptForm.getByRole("button", { name: "提交", exact: true }).click();
  let events = await waitEvents(
    (events) => events.some((event) => event.result?.action === "accept"),
    "accept response",
  );
  let issued = events.find((event) => event.event === "form-issued" && event.kind === "accept");
  let response = events.find(
    (event) => event.id === issued.id && event.result?.action === "accept",
  );
  assert.deepEqual(response.result, { action: "accept", content: { answer: "ACCEPT_VALUE" } });
  await acceptForm.waitFor({ state: "detached" });
  checks.push(
    "legacy form keeps original thread/request ownership through navigation and accepts via UI",
  );
  // Reopen the existing global app tab after navigation; then cancel a second request.
  await button("Extension App").first().click();
  inner = await appFrame();
  await inner.locator("#form-cancel").click();
  const cancelForm = page
    .locator("form")
    .filter({ has: page.getByText("Fixture legacy cancel", { exact: true }) });
  await cancelForm.waitFor();
  await cancelForm.getByRole("button", { name: "取消", exact: true }).click();
  events = await waitEvents(
    (events) => events.some((event) => event.result?.action === "cancel"),
    "cancel response",
  );
  issued = events.find((event) => event.event === "form-issued" && event.kind === "cancel");
  response = events.find((event) => event.id === issued.id && event.result?.action === "cancel");
  assert.equal(response.result.action, "cancel");
  assert(!response.result.content);
  await cancelForm.waitFor({ state: "detached" });
  checks.push("second native legacy form cancellation settles its original reverse request");
  // File entrypoint originates from the product file tree, never a scripted app-open IPC.
  await button("任务操作").click();
  await page.getByRole("menuitem", { name: "文件", exact: true }).click();
  await page.getByTestId("workspace-file-tree").locator('[data-file-path="sample.txt"]').click();
  await button("Fixture File Viewer").click();
  inner = await appFrame();
  await inner.locator("#input").filter({ hasText: "areal-file://" }).waitFor();
  const fileInput = JSON.parse(await inner.locator("#input").innerText());
  assert.equal(fileInput.file.name, "sample.txt");
  assert.match(fileInput.file.resourceUri, /^areal-file:\/\//);
  assert(!JSON.stringify(fileInput).includes(workspace));
  await inner.locator("#read-file").click();
  await inner.locator("#result").filter({ hasText: "OPAQUE_FILE_READ_MARKER" }).waitFor();
  assert.equal(await readFile(join(workspace, "sample.txt"), "utf8"), "OPAQUE_FILE_READ_MARKER\n");
  assert.equal(
    await page.getByTestId("areal-workbench").getAttribute("data-thread-id"),
    ownerThread,
  );
  assert.equal(requests.length, 0);
  checks.push(
    "real file-panel entrypoint grants opaque resource; sandbox reads through Main/Core without raw path or mutation",
  );
  await page.screenshot({
    path: join(scratch, "opaque-file-entrypoint.png"),
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  passed = true;
} catch (e) {
  failure = { message: e.message, stack: e.stack };
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, e);
} finally {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") errors.push("read cleanup identity: " + error.message);
  }
  if (app) {
    let quitTimer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_resolve, reject) => {
          quitTimer = setTimeout(() => reject(Error("owned Electron quit timed out")), 15000);
        }),
      ]);
      if (appProcess.exitCode === null && appProcess.signalCode === null)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("owned Electron did not exit")), 15000);
          appProcess.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      assert.equal(appProcess.exitCode, 0, "owned Electron quit exit code");
      assert.equal(appProcess.signalCode, null, "owned Electron quit signal");
      cleanup.electronExited = true;
    } catch (error) {
      errors.push("close GUI: " + error.message);
    } finally {
      clearTimeout(quitTimer);
    }
  }
  if (metadata) {
    try {
      await assertApplicationStopped(coreBinary, env, metadata);
      cleanup.applicationStopped = true;
    } catch (error) {
      errors.push("verify application cleanup: " + error.message);
    }
  }
  if (errors.length && metadata) {
    const { ServiceConnection } = require("../app/src/core/service-client.cjs");
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      const packet = await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      await connection.request(
        "stopService",
        {
          protocol: metadata.protocol,
          cancel: true,
          expectedDesktopGeneration: metadata.desktopGeneration,
          expectedTargets: packet.service.targets,
        },
        true,
      );
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED" && error.code !== "ESRCH")
        errors.push("fallback stop service: " + error.message);
    } finally {
      connection.close();
    }
  }
  if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
    appProcess.kill("SIGKILL");
    await new Promise((resolve) => appProcess.once("exit", resolve));
    cleanup.forcedElectronExit = true;
  }
  const mainErrors = (await readFile(mainErrorsPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const error of mainErrors)
    errors.push("uncaught Main " + error.origin + ": " + error.message);
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  try {
    const instances = JSON.parse(
      execFileSync(coreBinary, ["service", "list", "--json"], { env, encoding: "utf8" }),
    );
    cleanup.instances = instances.map((instance) => ({
      serviceId: instance.serviceId,
      hostPid: instance.hostPid,
      corePid: instance.corePid,
      state: instance.state,
    }));
    assert(
      instances.every((instance) => instance.state === "stopped"),
      "owned Core remains live",
    );
  } catch (error) {
    errors.push("verify Core cleanup: " + error.message);
  }
  await writeFile(
    join(scratch, "model-requests.json"),
    JSON.stringify({ conversation: requests, sessionNames: titleRequests }, null, 2),
  );
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  const manifest = {
    passed,
    checks,
    errors,
    mainErrors,
    failure,
    scratch,
    cleanup,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
    sourceFiles,
    sourceDiffSha256,
    core: {
      binary: coreBinary,
      sha256: coreSha256,
      unchanged:
        createHash("sha256")
          .update(await readFile(coreBinary))
          .digest("hex") === coreSha256,
    },
    modelRequests: requests.length + titleRequests.length,
    conversationModelRequests: requests.length,
    sessionNameModelRequests: titleRequests.length,
    transportEvents: await transportEvents(),
    gaps: [
      "file writes/CAS and native Runtime ancestor-race acceptance are outside this read-only journey",
      "native form file/directory uploads and modern MRTR are unsupported",
      "no real provider/GitHub/OAuth or packaged acceptance",
    ],
    scope:
      "actual source Electron/Core desktop settings, mentions, legacy forms and opaque file read; self-owned stdio MCP server; deterministic local inference endpoint; known session-name requests recorded separately",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
