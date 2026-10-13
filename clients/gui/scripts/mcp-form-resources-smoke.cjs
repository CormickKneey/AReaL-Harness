// Written before mediator implementation. Exercises native dialog cancellation and
// transport owner envelope; actual Runtime/stdio reads belong to native E2E.
const assert=require('node:assert/strict');
const {McpFormResources}=require('../app/src/core/mcp-form-resources.cjs');
const {validateCommand}=require('../packages/workbench/client/desktop-contract.cjs');
const stageEnvelope={operation:'mcpFormResourceStage',projectId:'p',selectionToken:'native',requestId:'c71b2b27-fc6d-49c9-94e8-b53a6843279c',paths:['/selected']};
assert.throws(()=>validateCommand('manage',stageEnvelope),/无效/);
validateCommand('manage',stageEnvelope,{serviceOnly:true});
assert.throws(()=>validateCommand('manage',{...stageEnvelope,paths:['https://remote/file']},{serviceOnly:true}),/无效/);
assert.throws(()=>validateCommand('manage',{...stageEnvelope,arbitrary:true},{serviceOnly:true}),/无效/);
(async()=>{
const calls=[];let choice={canceled:true,filePaths:[]},confirm=0,authorised=true;
const backend={ownsThread:()=>authorised,command:async(_name,r)=>{calls.push(r);if(r.operation==='mcpFormResourcePrepare')return {selectionToken:'selected',userOptions:{kind:'directory'},multiple:false,serverLabel:'Fixture server'};if(r.operation==='mcpFormResourceStage')return {resources:[{uri:'areal-mcp-resource://f1f6747d-bc58-447d-8893-693ab54d5dba',name:'picked',size:5}],summary:{fileCount:1,totalBytes:5}};return {};}};
const picker=new McpFormResources({backend,choose:async()=>choice,confirm:async()=>({response:confirm})});const request={projectId:'p',threadId:'t',requestId:'r',fieldName:'files'};
await assert.rejects(picker.pick({...request,paths:['/secret']},()=>{}),/Invalid/);assert.equal(calls.length,0);
assert.deepEqual(await picker.pick(request,()=>{}),{resources:[]});assert(!calls.some(c=>c.operation==='mcpFormResourceStage'));
choice={canceled:false,filePaths:['/chosen/picked']};assert.deepEqual(await picker.pick(request,()=>{}),{resources:[]});assert(calls.some(c=>c.operation==='mcpFormResourceRelease'&&c.uri==='areal-mcp-resource://f1f6747d-bc58-447d-8893-693ab54d5dba'));
confirm=1;assert.equal((await picker.pick(request,()=>{})).resources[0].uri,'areal-mcp-resource://f1f6747d-bc58-447d-8893-693ab54d5dba');const stage=calls.find(c=>c.operation==='mcpFormResourceStage');assert.deepEqual(stage.paths,['/chosen/picked']);assert.match(stage.requestId,/^[a-f0-9-]{36}$/);assert.equal(stage.selectionToken,'selected');
authorised=false;await assert.rejects(picker.pick(request,()=>{}),/owner/);
// An uncertain stage must recover only its original durable receipt, with no new dialog or mutation.
let stages=0,picks=0,reads=0,stageId;
const uncertain=new McpFormResources({backend:{ownsThread:()=>true,command:async(_name,r)=>{
  if(r.operation==='mcpFormResourcePrepare')return {selectionToken:'token',userOptions:{kind:'file'},multiple:false,serverLabel:'Fixture'};
  if(r.operation==='mcpFormResourceStage'){stages++;stageId=r.requestId;throw Object.assign(Error('transport closed'),{submissionUnknown:true,requestId:r.requestId});}
  if(r.operation==='mcpFormResourceSubmission'){reads++;assert.equal(r.requestId,stageId);return reads===1?{confirmed:false}:{confirmed:true,accepted:true,result:{resources:[{uri:'areal-mcp-resource://afad1a57-ab5d-4994-a9f6-416146373f6b',name:'selected'}]}};}
  throw Error('unexpected operation');
}},choose:async()=>{picks++;return {canceled:false,filePaths:['/selected']};},confirm:async()=>{throw Error('file should not show directory consent');}});
await assert.rejects(uncertain.pick(request,()=>{}));
await assert.rejects(uncertain.pick(request,()=>{}));
assert.equal((await uncertain.pick(request,()=>{})).resources[0].uri,'areal-mcp-resource://afad1a57-ab5d-4994-a9f6-416146373f6b');
assert.equal(stages,1);assert.equal(picks,1);assert.equal(reads,2);
// A definite pre-dispatch rejection has no Core receipt: it must permit a fresh native selection.
for (const unrelatedUnknown of [false,true]) {
 let attempts=0,choices=0;
 const rejected=new McpFormResources({backend:{ownsThread:()=>true,command:async(_name,r)=>{
   if(r.operation==='mcpFormResourcePrepare')return {selectionToken:'token',userOptions:{kind:'file'},multiple:false,serverLabel:'Fixture'};
   if(r.operation==='mcpFormResourceStage') { attempts++; if(attempts===1)throw Object.assign(Error('conflicting pending submission'),unrelatedUnknown?{submissionUnknown:true,requestId:'different-original-request'}:{});
     return {resources:[{uri:'areal-mcp-resource://afad1a57-ab5d-4994-a9f6-416146373f6b',name:'selected'}]}; }
   throw Error('No receipt exists for a stage rejected before dispatch');
 }},choose:async()=>{choices++;return {canceled:false,filePaths:['/selected']};},confirm:async()=>{throw Error('unexpected confirmation');}});
 await assert.rejects(rejected.pick(request,()=>{}));
 assert.equal((await rejected.pick(request,()=>{})).resources[0].name,'selected');
 assert.equal(attempts,2);assert.equal(choices,2);
}
console.log('Main form picker boundary checks passed; native dialogs and Core transport are fake.');
})().catch(e=>{console.error(e);process.exitCode=1;});
