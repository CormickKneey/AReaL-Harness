// Pinned Codex management contract checks against actual authenticated Core.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {CoreClient} from '../clients/gui/packages/runtime-client/core.js';
const require=createRequire(new URL('../clients/gui/app/package.json',import.meta.url)),WebSocket=require('ws'),exec=promisify(execFile);
const scratch=await mkdtemp('/private/tmp/areal-plugin-wire-'),workspace=join(scratch,'workspace'),bin=resolve(process.env.AREAL_TEST_BIN_DIR??'target/debug','areal');
const env={...process.env,AREAL_HARNESS_HOME:join(scratch,'home'),AREAL_HARNESS_SERVICE_HOME:join(scratch,'registry'),OTEL_SDK_DISABLED:'true'};
let service,passed=false,failure;const clients=[],checks=[];
async function cli(args){return JSON.parse((await exec(bin,args,{env,timeout:60000})).stdout);}
async function connect(experimental){const auth=JSON.parse(await readFile(service.authFile,'utf8'));const c=new CoreClient({createSocket:()=>new WebSocket(service.endpoint,{headers:{Authorization:'Bearer '+auth.principals[0].token}})});
// Keep production initialization and add only the pinned experimental capability.
const request=c.request.bind(c);c.request=(method,params,options)=>request(method,method==='initialize'?{...params,capabilities:{...params.capabilities,experimentalApi:experimental}}:params,options);
await c.connect();clients.push(c);return c;}
try{await mkdir(join(workspace,'.agents/plugins'),{recursive:true});await mkdir(join(workspace,'pkg/skills/example'),{recursive:true});
await writeFile(join(workspace,'.agents/plugins/marketplace.json'),JSON.stringify({name:'wire',plugins:[{name:'sample',source:'./pkg',policy:{authentication:'ON_USE'}}]}));
await writeFile(join(workspace,'pkg/.placeholder'),'');await writeFile(join(workspace,'pkg/plugin.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'sample',version:'1.0.0',description:'wire fixture'}));
await writeFile(join(workspace,'pkg/skills/example/SKILL.md'),'---\nname: example\ndescription: Example skill\n---\nbody');
service=await cli(['service','ensure','--json','--workspace',workspace]);const c=await connect(false);
const list=await c.request('plugin/list',{cwds:[workspace]});assert.equal(list.marketplaces[0].name,'wire');assert.equal(list.marketplaces[0].plugins[0].source.type,'local');
const detail=await c.request('plugin/read',{marketplacePath:list.marketplaces[0].path,pluginName:'sample'});assert.equal(detail.plugin.summary.id,'sample@wire');assert.equal(detail.plugin.skills[0].name,'example');checks.push('pinned list/read response shapes');
await assert.rejects(c.request('plugin/search',{searchTerm:'sample'}),e=>e.code===-32600);const experimental=await connect(true);
const search=await experimental.request('plugin/search',{searchTerm:'sample',cwds:[workspace],limit:1});assert.equal(search.data[0].plugin.id,'sample@wire');checks.push('only search requires experimental opt-in');
const installed=await c.request('plugin/install',{marketplacePath:list.marketplaces[0].path,pluginName:'sample',installAttemptId:randomUUID()});assert.equal(installed.authPolicy,'ON_USE');assert.deepEqual(installed.appsNeedingAuth,[]);
assert((await c.request('plugin/installed',{cwds:[workspace]})).marketplaces[0].plugins[0].installed);checks.push('wire install shares Core state');
const first=await c.request('plugin/reconcile',{});assert(first.changedPlugins.some(x=>x.id==='sample@wire'&&x.hasSkills));assert.deepEqual((await c.request('plugin/reconcile',{})).changedPlugins,[]);checks.push('reconcile is per-pass package diff');
await c.request('plugin/uninstall',{pluginId:'sample@wire'});assert((await c.request('plugin/reconcile',{})).changedPlugins.some(x=>x.id==='sample@wire'&&x.hasSkills));checks.push('wire uninstall and removal flags');
await assert.rejects(c.request('plugin/share/list',{}),e=>e.data?.capability==='codexRemotePluginService');checks.push('unavailable hosted service remains explicit error');passed=true;
}catch(e){failure={message:e.message,stack:e.stack};process.exitCode=1;}
finally{for(const c of clients)c.close();if(service)await cli(['service','stop','--json','--instance',service.serviceId]).catch(()=>{});
const manifest={passed,scratch,checks,failure,scope:'actual Core pinned plugin management wire; no private catalog/sharing substitute'};await writeFile(join(scratch,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));}
