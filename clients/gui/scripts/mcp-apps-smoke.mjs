// Failure cases captured before implementation: wrong window/thread/generation;
// stale asynchronous open/reply; undeclared networks; malformed JSON-RPC;
// cross-server selection; raw file paths; ETag conflict; close during request.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { McpAppsHost, appCsp, parseDeepLink } = require("../app/src/core/mcp-apps.cjs");
assert.throws(() => appCsp({ connectDomains: ["https://ok.test; script-src *"] }));
assert.match(appCsp({}), /connect-src 'none'/);
assert.match(appCsp({ resourceDomains: ["https://*.example.com"] }), /https:\/\/\*.example.com/);
assert.throws(() => parseDeepLink("codex://plugins/x/app/y?path=https%3A%2F%2Fevil.test"));
assert.throws(() => parseDeepLink("codex://plugins/x/app/y?path=%2F%2Fevil.test"));
assert.equal(
  parseDeepLink("codex://plugins/p@apps/app/t?path=%2Fparts%3Fa%3D1").path,
  "/parts?a=1",
);
let owner = true,
  pending,
  calls = [];
const backend = {
  ownsThread: () => owner,
  command: async (_name, value) => {
    calls.push(value);
    if (value.operation === "mcpAppOpen")
      return {
        instanceId: "i",
        serverId: "s",
        generation: "g",
        resource: {
          mimeType: "text/html;profile=mcp-app",
          html: '<script>parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize"},"*")</script>',
        },
        initialArguments: {},
        initialResult: { content: [] },
      };
    if (value.operation === "mcpAppRequest")
      return new Promise((resolve) => {
        pending = resolve;
      });
    return {};
  },
};
const host = new McpAppsHost({ backend, ownerId: 5 });
const app = await host.open(
  { projectId: "p", threadId: "t", serverId: "s", expectedGeneration: "g", toolName: "app" },
  5,
);
assert.ok(app.frameUrl.startsWith("areal-mcp://"));
assert.equal(app.resource, undefined);
assert.throws(() => host.get(app.token, 6));
await assert.rejects(
  host.request(app.token, { jsonrpc: "2.0", id: 1, method: "arbitrary/method" }, 5),
);
await assert.rejects(host.request(app.token,{jsonrpc:"2.0",id:"private",method:"ui/host-file",params:{request:{}}},5),/unsupported/);
const response = await host.resource(new Request(app.frameUrl));
assert.equal(response.status, 200);
assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
const waiting = host.request(
  app.token,
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: {} } },
  5,
);
const repeated = host.request(
  app.token,
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: {} } },
  5,
);
assert.equal(calls.filter((call) => call.operation === "mcpAppRequest").length, 1);
await assert.rejects(
  host.request(
    app.token,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write", arguments: {} } },
    5,
  ),
  /reused/,
);
const repeatedRejected = assert.rejects(repeated, /closed|stale/i);
const rejected = assert.rejects(waiting, /closed|stale/i);
await host.close(app.token, 5);
pending({ jsonrpc: "2.0", id: 2, result: { content: [] } });
await rejected;
await repeatedRejected;
assert.equal((await host.resource(new Request(app.frameUrl))).status, 404);
owner = false;
await assert.rejects(
  host.open(
    { projectId: "p", threadId: "t", serverId: "s", expectedGeneration: "g", toolName: "app" },
    5,
  ),
);

// Main file-resource integration tests grant/delegation only. Core descriptor-anchored
// reads, CAS writes, and ancestor-swap races require the real Runtime acceptance test.
const { mkdtemp, writeFile, readFile, rm, symlink } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { authorizeFile, fileRequest } = require("../app/src/core/mcp-apps-files.cjs");
const directory = await mkdtemp(join(tmpdir(), "areal-mcp-apps-"));
try {
  await writeFile(join(directory, "document.txt"), "one");
  const fileBackend = { snapshot: () => ({ projects: [{ id: "p", root: directory }] }) };
  const file = await authorizeFile(fileBackend, "p", "document.txt");
  assert.ok(!file.uri.includes(directory));
  const delegated=[];
  const call = (method, params) => fileRequest(file,
    {jsonrpc:"2.0",id:42,method,params:{uri:file.uri,...params}},()=>{},()=>{},
    async request=>{delegated.push(request);return {jsonrpc:"2.0",id:request.id,result:{delegated:true}};});
  assert.deepEqual(await call("resources/read",{}),{delegated:true});
  assert.deepEqual(await call("openai/resources/write",{text:"two",ifMatch:"original-etag"}),{delegated:true});
  assert.deepEqual(delegated.map(request=>request.method),["resources/read","openai/resources/write"]);
  assert.equal(delegated[1].params.ifMatch,"original-etag");
  assert.equal(await readFile(join(directory,"document.txt"),"utf8"),"one","Main must not read/write resource bytes");
  await assert.rejects(fileRequest(file,{method:"resources/read",params:{uri:file.uri}},()=>{},()=>{},async()=>({error:{code:-32000,message:"rejected"}})),/Core file operation/);
  await assert.rejects(
    fileRequest(
      file,
      { method: "resources/read", params: { uri: "areal-file://another" } },
      () => {},
      () => {},
    ),
  );
  await symlink("/etc/hosts", join(directory, "escape"));
  await assert.rejects(authorizeFile(fileBackend, "p", "escape"));
  const boundaryCalls=[];
  const delegatedHost=new McpAppsHost({ownerId:5,backend:{...fileBackend,ownsThread:()=>true,command:async(_name,value)=>{
    boundaryCalls.push(value);
    if(value.operation==="mcpAppOpen")return {instanceId:"file-instance",serverId:"s",generation:"g",resource:{mimeType:"text/html;profile=mcp-app",html:"<p>file</p>"}};
    if(value.operation==="mcpAppClose")return {};
    return {jsonrpc:"2.0",id:value.request.id,result:{delegated:true}};
  }}});
  const ownedApp=await delegatedHost.open({projectId:"p",threadId:"t",serverId:"s",expectedGeneration:"g",toolName:"app",filePath:"document.txt"},5);
  const grant=boundaryCalls.find(value=>value.operation==="mcpAppOpen").fileResource;
  const original={jsonrpc:"2.0",id:"file-read",method:"resources/read",params:{uri:grant.uri}};
  assert.equal((await delegatedHost.request(ownedApp.token,original,5)).result.delegated,true);
  await delegatedHost.request(ownedApp.token,original,5);
  const privateCalls=boundaryCalls.filter(value=>value.request?.method==="ui/host-file");
  assert.equal(privateCalls.length,1,"duplicate app ID must not replay private Core operation");
  assert.deepEqual(privateCalls[0].request.params,{request:original});
  assert.equal(privateCalls[0].instanceId,"file-instance");assert.equal(privateCalls[0].generation,"g");
  assert.equal(privateCalls[0].threadId,"t");assert.equal(privateCalls[0].projectId,"p");
  assert.match(privateCalls[0].requestId,/^[0-9a-f-]{36}$/);
  assert(boundaryCalls.findIndex(value=>value.request?.method==="ui/host-authorize")<boundaryCalls.findIndex(value=>value.request?.method==="ui/host-file"));
  await delegatedHost.close(ownedApp.token,5);
  await call("resources/subscribe", {});
  assert.ok(file.watcher);
  await call("resources/unsubscribe", {});
  assert.equal(file.watcher, null);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "MCP Apps host integration passed: ownership, stale completion, CSP, deep links, opaque file grants, private Core file delegation, subscriptions, symlink escape. External Core transport is fake; CAS/ancestor-race/native sandbox remain separate gates.",
);

// Exercise the real official bridge protocol parser: SDK 2 moves request _meta into context.
const rendererRequire = createRequire(new URL("../renderer/package.json", import.meta.url));
const { AppBridge } = await import(
  rendererRequire.resolve("@modelcontextprotocol/ext-apps/app-bridge")
);
const messages = [];
let messageMetadata;
const transport = {
  start: async () => {},
  send: async (message) => {
    messages.push(message);
  },
  close: async () => {},
};
const bridge = new AppBridge(null, { name: "areal-test", version: "1" }, { message: { text: {} } });
bridge.onmessage = async (params, extra) => {
  messageMetadata = extra.mcpReq._meta;
  assert.equal(params.role, "user");
  return {};
};
await bridge.connect(transport);
transport.onmessage({
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: {
    appInfo: { name: "fixture", version: "1" },
    protocolVersion: "2026-01-26",
    appCapabilities: {},
  },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(messages[0].result.protocolVersion, "2026-01-26");
transport.onmessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
await new Promise((resolve) => setImmediate(resolve));
transport.onmessage({
  jsonrpc: "2.0",
  id: 2,
  method: "ui/message",
  params: {
    role: "user",
    content: [{ type: "text", text: "draft" }],
    _meta: { "openai/message": { target: "new", send: false } },
  },
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(messageMetadata, { "openai/message": { target: "new", send: false } });
await bridge.close();
console.log("Official AppBridge initialize/message metadata integration passed.");
