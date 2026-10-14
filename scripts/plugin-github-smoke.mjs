// Actual GitHub MCP through Core. The model alone is deterministic; no GitHub writes.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {CoreClient} from '../clients/gui/packages/runtime-client/core.js';
const exec=promisify(execFile),require=createRequire(new URL('../clients/gui/app/package.json',import.meta.url)),WebSocket=require('ws');
const bin=resolve(process.env.AREAL_TEST_BIN_DIR??'target/debug','areal');
const scratch=await mkdtemp('/private/tmp/areal-plugin-github-'),workspace=join(scratch,'workspace'),checks=[];
let service,client,passed=false,phase='credentials',failure,toolName,login,modelRounds=0;
let secret=process.env.AREAL_GITHUB_MCP_TOKEN;
if(!secret){try{secret=(await exec('gh',['auth','token'],{timeout:15000})).stdout.trim();}catch{throw Error('GitHub credential unavailable; configure gh or AREAL_GITHUB_MCP_TOKEN');}}
const env={...process.env,AREAL_HARNESS_HOME:join(scratch,'home'),AREAL_HARNESS_SERVICE_HOME:join(scratch,'registry'),AREAL_CREDENTIAL_GITHUB_MCP:secret,OTEL_SDK_DISABLED:'true'};
function sanitized(value){return String(value).split(secret).join('[redacted]').slice(0,2048);}
const model=createServer(async(req,res)=>{try{let body='';for await(const p of req)body+=p;const request=JSON.parse(body);modelRounds++;assert(toolName,'tool must be discovered before turn');
const completed=request.messages.some(m=>m.role==='tool');res.writeHead(200,{'Content-Type':'text/event-stream'});
const chunks=completed?[{content:'GITHUB_READONLY_OK'}]:[{tool_calls:[{index:0,id:'github-readonly-1',type:'function',function:{name:toolName,arguments:'{}'}}]}];
for(const delta of chunks)res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:completed?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n');}catch{res.writeHead(500);res.end('Fixture failed');}});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
async function cli(args){return JSON.parse((await exec(bin,args,{env,timeout:120000,maxBuffer:2*1024*1024})).stdout);}
async function rpc(method,params){return client.request(method,params,{timeoutMs:120000});}
try{
phase='fixture';await mkdir(join(workspace,'.agents/plugins'),{recursive:true});await mkdir(join(workspace,'github'),{recursive:true});
await writeFile(join(workspace,'.agents/plugins/marketplace.json'),JSON.stringify({name:'github-acceptance',plugins:[{name:'github',source:'./github',policy:{authentication:'ON_USE'}}]}));
await writeFile(join(workspace,'github/plugin.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'github',version:'1.0.0',description:'GitHub connector acceptance package'}));
await writeFile(join(workspace,'github/.app.json'),JSON.stringify({apps:[{id:'original-github-acceptance-id',name:'GitHub',description:'Explicit original connector ID'}]}));
const config=join(scratch,'config.toml');await writeFile(config,'schema_version=1\n[model]\nname="github-fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:'+model.address().port+'"\n');
phase='Core launch';service=await cli(['service','ensure','--json','--workspace',workspace,'--config',config]);
const auth=JSON.parse(await readFile(service.authFile,'utf8'));client=new CoreClient({createSocket:()=>new WebSocket(service.endpoint,{headers:{Authorization:'Bearer '+auth.principals[0].token}})});await client.connect();
const preview=await rpc('areal/plugin/read',{id:'github@github-acceptance'});
const installed=await rpc('areal/plugin/install',{id:preview.id,scope:'user',expectedRevision:preview.revision,source:preview.source,expectedDigest:preview.sourceDigest,requestId:randomUUID()});
assert.equal(modelRounds,0);checks.push('installation executes neither model nor MCP');
const state=await rpc('areal/plugin/mcp/list',{});assert.equal(state.data[0].connectors[0].id,'original-github-acceptance-id');assert.equal(state.data[0].connectors[0].state,'missingMapping');checks.push('original opaque connector ID remains intact and unmapped until explicit configuration');
phase='explicit GitHub mapping';await rpc('areal/plugin/connector/configure',{id:preview.id,connectorId:'original-github-acceptance-id',provider:'github',credentialRef:'GITHUB_MCP',expectedDigest:installed.installedDigest,requestId:randomUUID()});
phase='real GitHub MCP connection';await rpc('areal/plugin/connection',{id:preview.id,expectedDigest:installed.installedDigest,connect:true,requestId:randomUUID()});
const directory=await rpc('areal/mcp/apps/list',{});const server=directory.data.find(s=>s.pluginId===preview.id);assert(server);const tool=server.tools.find(t=>t.name==='get_me');assert(tool,'real GitHub must advertise get_me');toolName=tool.toolName;checks.push('real api.githubcopilot.com initializes and supplies get_me');
phase='read-only ordinary Core Turn';const start=await rpc('thread/start',{}),threadId=start.thread.id;const turn=await rpc('areal/turn/start',{threadId,input:[{type:'text',text:'Run only the read-only get_me tool once.'}],requestId:randomUUID()});
let result;for(let n=0;n<120;n++){result=await rpc('thread/read',{threadId,includeTurns:true});if(result.thread.turns.find(t=>t.id===turn.turn.id)?.status!=='inProgress')break;await new Promise(r=>setTimeout(r,250));}
assert.equal(result.thread.turns.find(t=>t.id===turn.turn.id)?.status,'completed');
const raw=await rpc('areal/mcp/tool/result',{threadId,callId:'github-readonly-1'});assert.equal(raw.mcpResult.isError??false,false);
const text=raw.mcpResult.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');const profile=JSON.parse(text);login=profile.login??profile.username??profile.user?.login;assert.equal(typeof login,'string');
assert.equal(modelRounds,2);checks.push('single real get_me call completes through ordinary Core journal and model projection');
phase='disconnect';await rpc('areal/plugin/connection',{id:preview.id,expectedDigest:installed.installedDigest,connect:false,requestId:randomUUID()});assert.equal((await rpc('areal/mcp/apps/list',{})).data.length,0);checks.push('explicit disconnect removes the GitHub generation');passed=true;
}catch(error){failure={phase,code:error.code??null,message:sanitized(error.message)};process.exitCode=1;}
finally{client?.close();if(service)await cli(['service','stop','--json','--instance',service.serviceId]).catch(()=>{});await new Promise(r=>model.close(r));
const manifest={passed,phase,failure,checks,githubLogin:login,model:'deterministic local fixture',service:'actual GitHub MCP',scope:'read-only get_me; no GitHub mutations, no package/platform/private-Codex-service claim',binarySha256:createHash('sha256').update(await readFile(bin)).digest('hex')};const serialized=JSON.stringify(manifest,null,2);assert(!serialized.includes(secret));await writeFile(join(scratch,'manifest.json'),serialized);console.log(serialized);console.log('Evidence: '+scratch);}
