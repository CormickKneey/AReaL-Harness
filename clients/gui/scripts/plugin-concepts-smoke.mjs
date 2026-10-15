import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection, waitForServiceExit } = require("../app/src/core/service-client.cjs");
const scratch = await mkdtemp("/private/tmp/areal-plugin-concepts-");
const workspace = join(scratch, "workspace");
const userHome = join(scratch, "user");
const source = join(workspace, "packages/concepts");
const transportLog = join(scratch, "mcp.jsonl");
const fixture = {
  pluginId: "concepts@concept-market",
  pluginName: "Concept Plugin",
  skillId: "shared-concept",
  skillName: "Shared Concept",
  packageServer: "concept-package",
  standaloneServer: "concept-standalone",
};
const standaloneSkill = "---\nname: Shared Concept\ndescription: Standalone project instructions.\n---\nSTANDALONE_CONCEPT_BODY\n";
const checks = [];
const errors = [];
const requests = [];
const instances = [];
const sha = value => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
console.log(`Evidence: ${scratch}`);

for (const path of [join(workspace, ".agents/plugins"), join(workspace, ".agents/skills", fixture.skillId),
  join(source, "skills", fixture.skillId), join(userHome, ".areal")]) await mkdir(path, { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
await writeFile(join(workspace, ".agents/skills", fixture.skillId, "SKILL.md"), standaloneSkill);
await json(join(source, "plugin.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "concepts", version: "1.0.0", description: "Owner-aware resource acceptance fixture.",
  extensions: { "com.openai": { interface: { displayName: fixture.pluginName } } },
});
await writeFile(join(source, "skills", fixture.skillId, "SKILL.md"),
  "---\nname: Shared Concept\ndescription: Package-owned instructions.\n---\nPACKAGE_CONCEPT_BODY\n");
await json(join(workspace, ".agents/plugins/marketplace.json"), {
  name: "concept-market",
  plugins: [{ name: "concepts", source: { source: "local", path: "./packages/concepts" },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity" }],
});
await writeFile(join(source, "app.html"), `<!doctype html><html><body>
<h1>Concept App</h1><output id="ready">waiting</output><button id="echo">Echo literal</button><output id="result"></output>
<script>
let sequence=0;const pending=new Map();
function call(method,params){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
addEventListener('message',event=>{if(event.source!==parent)return;const message=event.data;if(message.jsonrpc!=='2.0')return;const request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(Error(message.error.message)):request.resolve(message.result);}});
call('ui/initialize',{appInfo:{name:'concept-app',version:'1'},protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline']}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.getElementById('ready').textContent='initialized';});
document.getElementById('echo').onclick=async()=>{try{const result=await call('tools/call',{name:'concept.echo',arguments:{value:'CONCEPT_LITERAL'}});document.getElementById('result').textContent=JSON.stringify(result);}catch(error){document.getElementById('result').textContent='ERROR: '+error.message;}};
</script></body></html>`);
await writeFile(join(source, "server.mjs"), String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const owner=process.argv[2],path=process.argv[3];
const log=value=>appendFileSync(path,JSON.stringify({owner,...value})+'\n');
log({event:'started',pid:process.pid});
const tools=[{name:'concept.echo',description:'Echo the supplied literal.',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},annotations:{readOnlyHint:true},...(owner==='package'?{_meta:{ui:{visibility:['app','model']}}}:{})}];
if(owner==='package')tools.unshift({name:'concept.open',title:'Concept App',description:'Open the local acceptance app.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://concept/app',visibility:['model']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}});
for await(const line of createInterface({input:process.stdin})){let request;try{request=JSON.parse(line);log({event:'request',method:request.method,params:request.params});if(request.id===undefined)continue;let result;
switch(request.method){case'initialize':result={protocolVersion:request.params.protocolVersion,serverInfo:{name:'concept-'+owner,version:'1'},capabilities:{tools:{},...(owner==='package'?{resources:{},extensions:{'io.modelcontextprotocol/ui':{}}}:{})}};break;
case'ping':result={};break;case'tools/list':result={tools};break;
case'resources/list':result={resources:owner==='package'?[{uri:'ui://concept/app',name:'Concept App',mimeType:'text/html;profile=mcp-app'}]:[]};break;
case'resources/templates/list':result={resourceTemplates:[]};break;
case'resources/read':if(request.params.uri!=='ui://concept/app')throw Error('unknown resource');result={contents:[{uri:'ui://concept/app',mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':{availableDisplayModes:['inline']}}}]};break;
case'tools/call':if(request.params.name==='concept.open')result={content:[{type:'text',text:'CONCEPT_APP_OPENED'}]};else if(request.params.name==='concept.echo')result={content:[{type:'text',text:'ECHO_'+request.params.arguments.value}]};else throw Error('unknown tool');break;
default:throw Error('unsupported method');}
log({event:'response',method:request.method,result});process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}catch(error){if(request?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:error.message}})+'\n');}}
`);
await json(join(source, "mcp.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { [fixture.packageServer]: { type: "stdio", command: "node",
    args: ["${PLUGIN_ROOT}/server.mjs", "package", transportLog] } },
});

const model = createServer(async (request, response) => {
  let body = "";
  for await (const part of request) body += part;
  requests.push(JSON.parse(body));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "CONCEPT_MODEL_REPLY" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
await writeFile(join(userHome, ".areal/config.toml"),
  `schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}"\n`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_GUI_USER_DATA: join(scratch, "electron"), AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: resolve(process.env.AREAL_CORE_BIN ?? join(root, "target/debug/areal")),
});
const coreSha256 = sha(await readFile(env.AREAL_CORE_BIN));
const sourceFiles = {};
for (const path of new Set(execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], { cwd: root })
  .toString().split("\0").filter(Boolean))) {
  if (/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path)) sourceFiles[path] = sha(await readFile(join(root, path)));
}
const sourceDiffSha256 = sha(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
let app, page, projectId, threadId, failure;
let passed = false;
let cleanup = {};
const button = name => page.getByRole("button", { name, exact: true });
const primaryTabs = () => page.getByRole("tablist", { name: "插件类型", exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function until(read, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw Error(`Timeout: ${label}`);
}
async function call(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const resources = operation => call("resources", { operation, projectId, scope: "project" });
const manage = operation => call("manage", { operation, projectId });
async function events() {
  try { return (await readFile(transportLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function capture(name) {
  await page.screenshot({ path: join(scratch, `${name}.png`), animations: "disabled" });
  await writeFile(join(scratch, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
}
async function launch() {
  app = await electron.launch({ executablePath: require("electron"), args: [join(gui, "app")], env, timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120_000 });
  await until(async () => (await state()).connection?.state === "ready", "desktop ready");
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    window.setSize(1440, 960);
    return { pid: process.pid, version: process.versions.electron, userData: app.getPath("userData"),
      sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.equal(identity.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(identity.sandbox, true);
  assert.equal(identity.contextIsolation, true);
  assert.equal(identity.nodeIntegration, false);
  const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  process.kill(metadata.pid, 0);
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
  } finally { connection.close(); }
  instances.push({ ...identity, servicePid: metadata.pid, serviceProtocol: metadata.protocol });
}
async function settings() {
  await button("设置").click();
  await page.getByLabel("集成", { exact: true }).getByRole("button", { name: "插件", exact: true }).click();
  await page.getByRole("heading", { name: "插件", exact: true }).waitFor();
  await primaryTabs().waitFor();
  assert.deepEqual(await primaryTabs().getByRole("tab").allTextContents(), ["插件", "Skills", "MCP"]);
}
async function scopeProject() {
  await button("资源范围").click();
  await page.getByRole("menuitemradio", { name: "当前项目", exact: true }).click();
}
async function tab(name) {
  await primaryTabs().getByRole("tab", { name, exact: true }).click();
}
function skillRow(owner) {
  return page.getByRole("article").filter({ has: page.getByText(fixture.skillName, { exact: true }) })
    .filter({ hasText: owner === "plugin" ? fixture.pluginName : "独立" });
}
function mcpRow(owner) {
  return page.getByRole("article").filter({ hasText: owner === "plugin" ? fixture.pluginName : fixture.standaloneServer });
}
async function detailFromResource(row) {
  await row.getByRole("button", { name: "管理插件", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: fixture.pluginName, exact: true }).waitFor();
  await dialog.getByText(fixture.pluginId, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "卸载插件", exact: true }).waitFor();
  return dialog;
}
async function closeDetail() {
  await page.getByRole("dialog").getByRole("button", { name: /关闭/ }).first().click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}
async function assertSkillOwners() {
  const packaged = skillRow("plugin"), standalone = skillRow("standalone");
  await packaged.waitFor();
  await standalone.waitFor();
  assert.equal(await packaged.count(), 1, "package Skill has one source-aware row");
  assert.equal(await standalone.count(), 1, "same-named standalone Skill has a distinct row");
  assert.match(await packaged.innerText(), /插件/);
  assert.match(await standalone.innerText(), /项目/);
  assert.equal(await packaged.getByRole("switch").count(), 0, "package Skill cannot use the standalone toggle");
  assert.equal(await packaged.getByRole("button", { name: `查看技能 ${fixture.skillId}`, exact: true }).count(), 0,
    "package Skill cannot use standalone skillRead");
  await packaged.getByRole("button", { name: "管理插件", exact: true }).waitFor();
  return { packaged, standalone };
}
async function stopService() {
  let metadata;
  try { metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (metadata) {
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
      await connection.request("stopService", { protocol: metadata.protocol }, true);
    } finally { connection.close(); }
    await waitForServiceExit(join(scratch, "core"), metadata);
    await until(async () => {
      try { process.kill(metadata.pid, 0); return false; }
      catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }, "owned desktop service exits");
  }
  const remaining = JSON.parse(execFileSync(env.AREAL_CORE_BIN, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 30_000 }));
  for (const service of remaining) assert.equal(service.workspace, workspace, "registry contains only this fixture workspace");
  assert.equal(remaining.every(service => service.state === "stopped"), true, "owned Core services stopped");
  return { desktopStopped: true, coreStopped: true, remaining };
}

try {
  await launch();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await createProjectConversation(page, "workspace");
  const ready = await until(async () => {
    const value = await state();
    return value.projects[0]?.state?.connected ? value : null;
  }, "fixture project connected");
  projectId = ready.projects[0].id;
  threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.equal(typeof threadId, "string");
  await settings();
  checks.push("exactly three primary tabs are visible in order: 插件, Skills, MCP");
  await button(`查看插件 ${fixture.pluginId}`).click();
  await scopeProject();
  assert.equal(await button("安装到当前项目").isEnabled(), false, "package install needs source review");
  await button("解析并预览来源").click();
  await page.getByRole("checkbox", { name: "我已核对以上来源、版本和内容摘要", exact: true }).check();
  await button("安装到当前项目").click();
  await button("卸载插件").waitFor();
  const installed = (await manage("plugins")).data.find(plugin => plugin.id === fixture.pluginId);
  assert.equal(installed.installed, true);
  assert.equal(installed.enabled, true);
  assert.equal(installed.installedVersion, "1.0.0");
  assert.equal((await events()).length, 0, "review and install cannot start MCP");
  assert.equal(requests.length, 0, "install cannot start model inference");
  checks.push("real GUI source preview and digest confirmation install the portable project package without MCP/model startup");
  await capture("01-installed-package");
  await closeDetail();
  await tab("Skills");
  await scopeProject();
  let skills = await assertSkillOwners();
  const before = await resources("skills");
  assert.equal(before.data.find(skill => skill.id === fixture.skillId && skill.scope === "project").enabled, true);
  await detailFromResource(skills.packaged);
  assert.equal(await readFile(join(workspace, ".agents/skills", fixture.skillId, "SKILL.md"), "utf8"), standaloneSkill);
  assert.equal((await resources("skills")).data.find(skill => skill.id === fixture.skillId && skill.scope === "project").enabled, true);
  checks.push("same-named Skills remain source-distinct and package management opens its owning plugin without standalone mutation");
  await closeDetail();
  await tab("Skills");
  skills = await assertSkillOwners();
  await skills.standalone.getByRole("switch", { name: `停用技能 ${fixture.skillId}`, exact: true }).click();
  await skills.standalone.getByRole("switch", { name: `启用技能 ${fixture.skillId}`, exact: true }).waitFor();
  await until(async () => (await resources("skills")).data.find(skill => skill.id === fixture.skillId && skill.scope === "project")?.enabled === false,
    "standalone project Skill toggle persisted");
  assert.equal(await skills.standalone.getByRole("switch", { name: `启用技能 ${fixture.skillId}`, exact: true }).getAttribute("aria-checked"), "false");
  assert.equal((await manage("plugins")).data.find(plugin => plugin.id === fixture.pluginId).enabled, true);
  checks.push("standalone Skill toggle persists through the public read while its same-named plugin stays enabled");
  await capture("02-source-aware-skills");
  await tab("MCP");
  await scopeProject();
  let packagedMcp = mcpRow("plugin");
  await packagedMcp.waitFor();
  assert.match(await packagedMcp.innerText(), /插件/);
  assert.match(await packagedMcp.innerText(), /未连接/);
  assert.equal(await packagedMcp.getByRole("switch").count(), 0, "package MCP cannot use the standalone connection switch");
  assert.equal(await packagedMcp.getByRole("button", { name: /^编辑 MCP/ }).count(), 0, "package MCP cannot use the standalone editor");
  const disconnected = (await manage("pluginMcp")).data.find(plugin => plugin.pluginId === fixture.pluginId);
  assert.equal(disconnected.servers.length, 1);
  assert.equal(disconnected.servers[0].state, "disconnected");
  assert.equal(disconnected.trusted, false);
  await button("新增 MCP").click();
  await page.getByLabel("服务 ID", { exact: true }).fill(fixture.standaloneServer);
  await page.getByLabel("命令", { exact: true }).fill(process.execPath);
  await page.getByLabel("参数（每行一个）", { exact: true }).fill([join(source, "server.mjs"), "standalone", transportLog].join("\n"));
  await button("保存 MCP 配置").click();
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).waitFor();
  const saved = await until(async () => (await resources("mcp")).data.find(server => server.id === fixture.standaloneServer), "standalone MCP configuration saved");
  assert.equal(saved.config.transport.type, "stdio");
  assert.equal(saved.config.transport.command, process.execPath);
  assert.deepEqual(saved.config.transport.args, [join(source, "server.mjs"), "standalone", transportLog]);
  assert.equal(saved.state, "disconnected");
  assert.equal((await events()).length, 0, "saving standalone configuration cannot start a server");
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).click();
  assert.equal(await page.getByLabel("命令", { exact: true }).inputValue(), process.execPath);
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByLabel("调用超时（毫秒）", { exact: true }).fill("20000");
  await button("保存 MCP 配置").click();
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).waitFor();
  await until(async () => (await resources("mcp")).data.find(server => server.id === fixture.standaloneServer)?.config.callTimeoutMs === 20000,
    "standalone MCP edit persisted");
  await mcpRow("standalone").getByRole("switch", { name: `连接 ${fixture.standaloneServer}`, exact: true }).click();
  await mcpRow("standalone").getByText("已连接", { exact: true }).waitFor();
  const connected = await until(async () => {
    const server = (await resources("mcp")).data.find(item => item.id === fixture.standaloneServer);
    return server?.state === "connected" ? server : null;
  }, "standalone MCP connected through GUI");
  assert.equal(connected.tools.some(tool => tool.description === "Echo the supplied literal."), true);
  assert.equal((await events()).some(event => event.owner === "standalone" && event.event === "response" && event.method === "tools/list" &&
    event.result.tools.some(tool => tool.name === "concept.echo")), true);
  assert.equal((await events()).some(event => event.owner === "package"), false, "standalone connect cannot start the package server");
  await mcpRow("standalone").getByText("已连接", { exact: true }).waitFor();
  checks.push("standalone project MCP creation, readback, editing and connection use the real UI and preserve the package connection boundary");
  packagedMcp = mcpRow("plugin");
  const dialog = await detailFromResource(packagedMcp);
  assert.equal(await dialog.getByRole("button", { name: "信任并连接", exact: true }).isEnabled(), false);
  await dialog.getByRole("checkbox", { name: "我信任此已安装快照并允许启动其 MCP 服务器", exact: true }).check();
  await dialog.getByRole("button", { name: "信任并连接", exact: true }).click();
  const packageConnection = await until(async () => {
    const plugin = (await manage("pluginMcp")).data.find(item => item.pluginId === fixture.pluginId);
    return plugin?.servers.length === 1 && plugin.servers[0].state === "connected" ? plugin : null;
  }, "explicit digest trust connects package MCP");
  assert.equal(packageConnection.trusted, true);
  assert.equal(packageConnection.installedDigest, installed.installedDigest);
  await capture("03-plugin-detail-connected");
  await closeDetail();
  await tab("MCP");
  await mcpRow("plugin").getByText("已连接", { exact: true }).waitFor();
  await mcpRow("standalone").getByText("已连接", { exact: true }).waitFor();
  await capture("04-source-aware-mcp");
  checks.push("package MCP is listed before connection, delegates management to the package, and shows the real connected state after explicit digest trust");
  const appDialog = await detailFromResource(mcpRow("plugin"));
  await appDialog.getByRole("button", { name: "Concept App", exact: true }).click();
  await page.getByTestId("chat-input").waitFor();
  const frame = await until(async () => page.frames().find(frame => /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url())), "actual MCP App frame");
  await frame.locator("#ready").filter({ hasText: "initialized" }).waitFor();
  await frame.getByRole("button", { name: "Echo literal", exact: true }).click();
  await frame.locator("#result").filter({ hasText: "ECHO_CONCEPT_LITERAL" }).waitFor();
  assert.deepEqual(JSON.parse(await frame.locator("#result").innerText()).content, [{ type: "text", text: "ECHO_CONCEPT_LITERAL" }]);
  assert.equal((await events()).some(event => event.owner === "package" && event.event === "request" && event.method === "tools/call" &&
    event.params.name === "concept.echo" && event.params.arguments.value === "CONCEPT_LITERAL"), true);
  assert.equal(requests.length, 0, "interactive App echo cannot invoke model inference");
  checks.push("interactive App remains reachable from plugin detail and returns the literal echo through an actual sandbox frame and MCP transport");
  await capture("05-plugin-interactive-app");
  await app.close();
  app = null;
  await launch();
  await until(async () => (await state()).projects.find(project => project.id === projectId)?.state?.connected, "reopened project connected");
  await settings();
  await tab("Skills");
  await scopeProject();
  skills = await assertSkillOwners();
  await skills.standalone.getByRole("switch", { name: `启用技能 ${fixture.skillId}`, exact: true }).waitFor();
  assert.equal((await resources("skills")).data.find(skill => skill.id === fixture.skillId && skill.scope === "project").enabled, false);
  await detailFromResource(skills.packaged);
  assert.equal((await manage("plugins")).data.find(plugin => plugin.id === fixture.pluginId).installedDigest, installed.installedDigest);
  await closeDetail();
  await tab("MCP");
  await mcpRow("plugin").getByRole("button", { name: "管理插件", exact: true }).waitFor();
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).waitFor();
  assert.equal(await mcpRow("plugin").getByRole("switch").count(), 0);
  const restoredMcp = (await resources("mcp")).data.find(server => server.id === fixture.standaloneServer);
  assert.equal(restoredMcp.config.transport.command, process.execPath);
  assert.equal(restoredMcp.config.callTimeoutMs, 20000);
  assert.equal(requests.length, 0);
  checks.push("GUI reopen retains package identity, standalone Skill toggle, MCP configuration and ownership-aware management paths");
  await capture("06-reopened-resources");
  assert.deepEqual(errors, []);
  assert.equal(sha(await readFile(env.AREAL_CORE_BIN)), coreSha256, "Core artifact cannot change during acceptance");
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  if (app) await app.close().catch(error => errors.push(`close GUI: ${error.message}`));
  try { cleanup = await stopService(); }
  catch (error) { cleanup = { error: error.message }; errors.push(`stop owned service: ${error.message}`); }
  await new Promise(resolve => model.close(resolve));
  if (errors.length) { passed = false; process.exitCode = 1; }
  const manifest = {
    passed, checks, errors, failure, scratch, workspace, projectId, threadId, fixture, instances, cleanup,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceFiles, sourceDiffSha256,
    core: { binary: env.AREAL_CORE_BIN, sha256: coreSha256, unchanged: sha(await readFile(env.AREAL_CORE_BIN)) === coreSha256 },
    modelRequests: requests.length,
    scope: "source Electron/Main/Core, portable local plugin, standalone project resources, stdio MCP and native App iframe; deterministic loopback model; no packaged or remote-provider acceptance",
    injectedBoundary: "native directory selection returns the isolated fixture workspace",
  };
  await json(join(scratch, "manifest.json"), manifest);
  await json(join(scratch, "model-requests.json"), requests);
  console.log(JSON.stringify(manifest, null, 2));
}
