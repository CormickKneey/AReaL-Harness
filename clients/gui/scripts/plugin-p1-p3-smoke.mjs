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
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-plugin-gui-"),
  workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
// Planned failures, before fixture/driver implementation:
// install starts transport; unreviewed digest installs; sandbox receives Node/product bridge;
// app handshake notifications precede initialized; tools bypass Core or cross server;
// response loss replays an effect; send:false drops human text/typed blocks;
// background owner changes active thread; revoke leaves token able to call tools.
// Native form uploads/MRTR, signed package and real services are explicit non-goals of this fixture.
const source = join(workspace, "packages", "hello"),
  transportLog = join(scratch, "mcp.jsonl");
await mkdir(source, { recursive: true });
await writeFile(
  join(source, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "hello",
    version: "1.0.0",
    description: "Native Apps acceptance fixture.",
    extensions: { "com.openai": { interface: { displayName: "Hello Apps" } } },
  }),
);
const appHtml = `<!doctype html><html><body><h1>Native Apps fixture</h1><output id="ready">waiting</output><output id="result"></output><output id="raw"></output><button id="tool">Call tool</button><button id="draft">Add draft</button><button id="context">Set model context</button><button id="cross">Cross server</button><button id="entry">Call model-only entry</button><script>
let seq=0;const pending=new Map();const log=[];window.fixtureLog=log;
function call(method,params,id){return new Promise((resolve,reject)=>{id=id||++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
window.fixtureCall=call;
addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m.jsonrpc!=='2.0')return;log.push(m);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='ui/notifications/tool-result')document.getElementById('raw').textContent=m.params?._meta?.privateMarker||'';});
const show=async(action)=>{try{document.getElementById('result').textContent=JSON.stringify(await action());}catch(e){document.getElementById('result').textContent='ERROR: '+e.message;}};
document.getElementById('tool').onclick=()=>show(()=>call('tools/call',{name:'fixture.echo',arguments:{value:'native-tool'}}));
document.getElementById('entry').onclick=()=>show(()=>call('tools/call',{name:'fixture.open',arguments:{}}));
document.getElementById('cross').onclick=()=>show(()=>call('tools/call',{name:'other-server.secret',arguments:{}}));
document.getElementById('draft').onclick=()=>show(()=>call('ui/message',{role:'user',content:[{type:'text',text:'APP_DRAFT_TEXT'},{type:'text',text:'TITLED_CONTENT',_meta:{'openai/title':'Fixture attachment'}},{type:'resource_link',uri:'fixture://document/1',name:'Fixture document',mimeType:'text/plain'}],_meta:{'openai/message':{target:'active',send:false}}}));
document.getElementById('context').onclick=()=>show(()=>call('ui/update-model-context',{content:[{type:'text',text:'MODEL_CONTEXT_PUBLIC',_meta:{privateMarker:'MODEL_META_PRIVATE'}}],structuredContent:{nested:{value:'CONTEXT_VALUE',_meta:{secret:'NESTED_META_PRIVATE'}}}}));
call('ui/initialize',{appInfo:{name:'fixture',version:'1'},protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline','fullscreen']}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.getElementById('ready').textContent='initialized';});
</script></body></html>`;
await writeFile(join(source, "app.html"), appHtml);
const fixtureServer = String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const log=value=>appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(value)+'\n');
log({event:'started'});let setting=true;
const tools=[{name:'fixture.open',title:'Fixture App',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://fixture/app',visibility:['model']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'},{type:'file',extensions:['.txt']}]}}},{name:'fixture.echo',title:'Fixture echo',inputSchema:{type:'object',properties:{value:{type:'string'}}},annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}},{name:'fixture.settings.read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'fixture.settings.update',inputSchema:{type:'object',properties:{set:{type:'object'}}},annotations:{readOnlyHint:false}},{name:'fixture.mentions',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}}];
const result=text=>({content:[{type:'text',text}],_meta:{privateMarker:'RAW_UI_ONLY_PRIVATE'}});
for await(const line of createInterface({input:process.stdin})){let q;try{q=JSON.parse(line);log({event:'request',method:q.method,params:q.params,id:q.id});if(q.id===undefined)continue;let value;
switch(q.method){case'initialize':value={protocolVersion:q.params.protocolVersion,serverInfo:{name:'native-fixture',version:'1'},capabilities:{tools:{},resources:{subscribe:true},extensions:{'io.modelcontextprotocol/ui':{},'openai/settings':{readTool:'fixture.settings.read',updateTool:'fixture.settings.update'},'openai/mentions':{searchTool:'fixture.mentions'}}}};break;
case'ping':value={};break;case'tools/list':value={tools};break;case'resources/list':value={resources:[{uri:'ui://fixture/app',name:'Fixture App',mimeType:'text/html;profile=mcp-app'}]};break;case'resources/templates/list':value={resourceTemplates:[]};break;
case'resources/read':value={contents:[q.params.uri==='ui://fixture/app'?{uri:q.params.uri,mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':{availableDisplayModes:['inline','fullscreen']}}}:{uri:q.params.uri,mimeType:'text/plain',text:'FIXTURE_RESOURCE'}]};break;
case'tools/call':if(q.params.name==='fixture.open')value=result('OPEN_TOOL_PUBLIC');else if(q.params.name==='fixture.echo')value=result('ECHO_'+q.params.arguments.value);else if(q.params.name==='fixture.settings.read')value={content:[],structuredContent:{schema:{type:'object',properties:{enabled:{type:'boolean',title:'Enabled'}}},values:{enabled:setting}}};else if(q.params.name==='fixture.settings.update'){setting=q.params.arguments.set.enabled;value=result('updated');}else if(q.params.name==='fixture.mentions')value={content:[{type:'resource_link',uri:'fixture://document/1',name:'Fixture document'}]};else throw Error('unknown tool');break;
case'resources/subscribe':case'resources/unsubscribe':value={};break;default:throw Error('unsupported method');}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:value})+'\n');}catch(e){if(q?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:e.message}})+'\n');}}
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
await writeFile(join(workspace, "sample.txt"), "FILE_CAS_INITIAL\n");
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
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
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
  checks = [],
  errors = [];
const model = createServer(async (req, res) => {
  let body = "";
  for await (const p of req) body += p;
  requests.push(JSON.parse(body));
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
let app,
  page,
  failure,
  passed = false;
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
async function call(name, params) {
  const r = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), {
    name,
    params,
  });
  assert(r.ok, JSON.stringify(r));
  return r.value;
}
async function _pluginState(predicate, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const row = (
      await call("manage", {
        projectId: await page.getByTestId("areal-workbench").getAttribute("data-project-id"),
        operation: "plugins",
      })
    ).data.find((x) => x.id === "hello@gui-p0");
    if (predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw Error("timeout: " + label);
}
async function settings() {
  await button("设置").click();
  await page
    .getByLabel("集成", { exact: true })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  await page.getByRole("heading", { name: "插件", exact: true }).waitFor();
  await page.getByRole("button", { name: "查看插件 hello@gui-p0", exact: true }).click();
}
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120_000,
  });
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
  await createProjectConversation(page, "workspace");
  await until((s) => s.projects[0]?.state?.connected, "chosen project connected");
  if (await button("返回应用").isVisible()) await button("返回应用").click();
  await page.getByTestId("chat-input").waitFor();
  const ready = await until((s) => s.projects[0]?.state?.connected, "project connected"),
    projectId = ready.projects[0].id;
  await settings();
  assert.equal(await button("安装到用户").isEnabled(), false, "install requires digest preview");
  await button("解析并预览来源").click();
  await page.getByText("我已核对以上来源、版本和内容摘要", { exact: true }).click();
  await button("安装到用户").click();
  await button("卸载插件").waitFor();
  assert.equal((await transportEvents()).length, 0, "install must not start MCP");
  assert.equal(requests.length, 0, "install must not invoke inference");
  checks.push(
    "GUI authoritative preview + digest confirmation installs immutable source without MCP/model startup",
  );
  assert.equal(
    await button("信任并连接").isEnabled(),
    false,
    "connect requires explicit installed digest trust",
  );
  await page.getByText("我信任此已安装快照并允许启动其 MCP 服务器", { exact: true }).click();
  await button("信任并连接").click();
  let connectedApps;
  for (let n = 0; n < 120; n++) {
    connectedApps = await call("manage", { projectId, operation: "mcpApps" });
    if (
      connectedApps.data.some((server) => server.tools.some((tool) => tool.name === "fixture.open"))
    )
      break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(
    connectedApps.data.some((server) => server.tools.some((tool) => tool.name === "fixture.open")),
  );
  checks.push("GUI explicitly trusts installed digest and connects actual portable stdio server");
  await page.getByRole("dialog").getByRole("button", { name: "Fixture App", exact: true }).click();
  await page.getByTestId("chat-input").waitFor();
  const ownerThread = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert(ownerThread);
  await page.waitForFunction(() => document.querySelector('iframe[src^="areal-mcp://"]'));
  let inner;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    inner = page.frames().find((frame) => /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url()));
    if (inner) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(inner, "actual sandbox inner frame exists");
  await inner.locator("#ready").filter({ hasText: "initialized" }).waitFor();
  const frameBoundary = await inner.evaluate(() => ({
    node: typeof process,
    require: typeof require,
    desktop: typeof window.arealDesktop,
    origin: location.origin,
    raw: document.getElementById("raw").textContent,
  }));
  assert.equal(frameBoundary.node, "undefined");
  assert.equal(frameBoundary.require, "undefined");
  assert.equal(frameBoundary.desktop, "undefined");
  assert(frameBoundary.origin.startsWith("areal-mcp://"));
  await inner.locator("#raw").filter({ hasText: "RAW_UI_ONLY_PRIVATE" }).waitFor();
  assert.equal(requests.length, 0);
  checks.push(
    "explicit GUI Profile opens model-only declared entrypoint in an isolated Electron frame with private UI metadata and no inference",
  );
  await inner.locator("#entry").click();
  await inner.locator("#result").filter({ hasText: "ERROR:" }).waitFor();
  assert.equal(
    (await transportEvents()).filter(
      (e) => e.method === "tools/call" && e.params.name === "fixture.open",
    ).length,
    1,
  );
  checks.push(
    "entrypoint visibility exception does not let the App call a model-only tool afterward",
  );
  await inner.locator("#tool").click();
  await inner.locator("#result").filter({ hasText: "ECHO_native-tool" }).waitFor();
  assert.equal(
    (await transportEvents()).filter(
      (e) => e.method === "tools/call" && e.params.name === "fixture.echo",
    ).length,
    1,
  );
  await inner.locator("#cross").click();
  await inner.locator("#result").filter({ hasText: "ERROR:" }).waitFor();
  assert.equal(
    (await transportEvents()).filter(
      (e) => e.method === "tools/call" && e.params.name === "other-server.secret",
    ).length,
    0,
  );
  checks.push(
    "app-only same-server tool reaches actual Core/server; cross-server tool rejected before transport",
  );
  const input = page.getByTestId("chat-input");
  await input.fill("HUMAN_DRAFT");
  await inner.locator("#draft").click();
  await inner.locator("#result").filter({ hasText: "{}" }).waitFor();
  assert((await input.innerText()).includes("HUMAN_DRAFT"));
  assert((await input.innerText()).includes("APP_DRAFT_TEXT"));
  await page.getByText("Fixture attachment", { exact: true }).waitFor();
  await page.getByText("Fixture document", { exact: true }).waitFor();
  assert.equal(
    await page.getByTestId("areal-workbench").getAttribute("data-thread-id"),
    ownerThread,
  );
  assert.equal(requests.length, 0, "send:false cannot invoke model");
  checks.push(
    "send:false preserves editable human text and typed titled/resource blocks in same ordinary thread",
  );
  await inner.locator("#context").click();
  await inner.locator("#result").filter({ hasText: "{}" }).waitFor();
  await page.getByRole("button", { name: "移除应用上下文", exact: true }).waitFor();
  await page.getByTestId("chat-send-button").click();
  await page.getByText("GUI_PLUGIN_SETUP_OK", { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  const modelInput = JSON.stringify(requests[0]);
  assert(modelInput.includes("MODEL_CONTEXT_PUBLIC"));
  assert(modelInput.includes("CONTEXT_VALUE"));
  for (const privateValue of ["RAW_UI_ONLY_PRIVATE", "MODEL_META_PRIVATE", "NESTED_META_PRIVATE"])
    assert(!modelInput.includes(privateValue), "private metadata leaked: " + privateValue);
  checks.push(
    "normal user send consumes app context through real Core while stripping nested _meta from model projection",
  );
  await page.screenshot({
    path: join(scratch, "native-app-draft-and-model.png"),
    animations: "disabled",
  });
  const frameUrl = inner.url(),
    token = new URL(frameUrl).hostname;
  await settings();
  await button("断开连接").click();
  const revokeDeadline = Date.now() + 30_000;
  let revoked = false;
  while (Date.now() < revokeDeadline) {
    const catalog = await call("manage", {
      projectId,
      threadId: ownerThread,
      operation: "mcpApps",
    });
    if (!catalog.data.some((server) => server.pluginId === "hello@gui-p0")) {
      revoked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(revoked, "disconnect did not remove live server generation");
  const stale = await page.evaluate(async (token) => {
    try {
      return await window.arealDesktop.mcpApp({
        operation: "request",
        token,
        request: {
          jsonrpc: "2.0",
          id: "after-revoke",
          method: "tools/call",
          params: { name: "fixture.echo", arguments: { value: "revoked" } },
        },
      });
    } catch (e) {
      return { rejected: e.message };
    }
  }, token);
  assert(stale.rejected || stale.error, "stale capability must fail");
  assert.equal(
    (await transportEvents()).filter(
      (e) => e.method === "tools/call" && e.params.name === "fixture.echo",
    ).length,
    1,
  );
  checks.push(
    "disconnect revokes old Main/Core capability; captured token cannot execute another tool",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (e) {
  failure = { message: e.message, stack: e.stack };
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, e);
} finally {
  if (app) {
    await app.close().catch((e) => errors.push("close GUI: " + e.message));
    try {
      const { ServiceConnection } = require("../app/src/core/service-client.cjs");
      const connection = new ServiceConnection();
      try {
        const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
        await connection.connect(metadata);
        await connection.request("stopService", { protocol: metadata.protocol }, true);
      } finally {
        connection.close();
      }
    } catch (e) {
      errors.push("stop service: " + e.message);
    }
  }
  await new Promise((r) => model.close(r));
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  const manifest = {
    passed,
    checks,
    errors,
    failure,
    scratch,
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
    modelRequests: requests.length,
    transportEvents: await transportEvents(),
    gaps: [
      "mutation approval ask and completed-response UNKNOWN replay need separate controlled effect scenario",
      "file CAS is covered only by non-native host smoke, not this native journey",
      "native form uploads and modern MRTR unsupported",
      "no real provider/GitHub, OAuth or packaged acceptance",
    ],
    scope:
      "source Electron/Core P1/P3 Apps; deterministic external model and self-owned stdio MCP server; no packaged/provider acceptance",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
