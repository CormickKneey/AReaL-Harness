'use strict';
// A narrow GUI-intent boundary. Never accept native method names, endpoints or credentials.
const fields={
  configure:['model','parameters','options'],
  goalCreate:['objective','inferLimits'],goalPause:['goalId'],goalResume:['goalId'],goalClear:['goalId'],
  queueUpdate:['queueItemId','text'],queueRemove:['queueItemId'],queueReorder:['queueItemIds'],queuePause:[],queueResume:[],queueSteer:['queueItemId','expectedTurnId'],
  steer:['text','expectedTurnId'],
};
const methods={configure:'areal/thread/configure',goalCreate:'areal/goal/create',goalPause:'areal/goal/pause',goalResume:'areal/goal/resume',goalClear:'areal/goal/clear',queueUpdate:'areal/queue/update',queueRemove:'areal/queue/remove',queueReorder:'areal/queue/reorder',queuePause:'areal/queue/pause',queueResume:'areal/queue/resume',queueSteer:'areal/queue/steer',steer:'turn/steer'};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const id=v=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=128;
const revision=v=>Number.isSafeInteger(v)&&v>=0;
const text=v=>typeof v==='string'&&v.trim()&&Buffer.byteLength(v)<=64*1024;
const invalid=()=>{throw Object.assign(new Error('无效的 Remote 会话控制参数'),{code:'INVALID_PARAMS'});};
function validateControl(p){
  if(!exact(p,['threadId','operation','expectedRevision','values'])||!id(p.threadId)||!Object.hasOwn(fields,p.operation)||!revision(p.expectedRevision)||!exact(p.values,fields[p.operation]))invalid();
  const v=p.values;
  if(p.operation==='configure'){
    if(!Object.keys(v).length)invalid();
    if(v.model!==undefined&&v.model!==null&&(!exact(v.model,['providerId','modelId'])||!id(v.model.providerId)||!id(v.model.modelId)))invalid();
    if(v.parameters!==undefined&&(!exact(v.parameters,['reasoningEffort'])||!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(v.parameters.reasoningEffort)))invalid();
    if(v.options!==undefined){
      if(!exact(v.options,['permissionPreset','readOnly','appendInstructions','approvalTools','preapprovedTools']))invalid();
      if(v.options.permissionPreset!==undefined&&!['ask','autoReview','fullAccess'].includes(v.options.permissionPreset))invalid();
      if(v.options.readOnly!==undefined&&typeof v.options.readOnly!=='boolean')invalid();
      if(v.options.appendInstructions!==undefined&&(typeof v.options.appendInstructions!=='string'||Buffer.byteLength(v.options.appendInstructions)>8192))invalid();
      for(const key of ['approvalTools','preapprovedTools'])if(v.options[key]!==undefined&&(!Array.isArray(v.options[key])||v.options[key].length>128||v.options[key].some(x=>!id(x))))invalid();
    }
  }
  if(p.operation==='goalCreate'&&(!text(v.objective)||[...v.objective].length>4000||v.inferLimits!==undefined&&typeof v.inferLimits!=='boolean'))invalid();
  if(['goalPause','goalResume','goalClear'].includes(p.operation)&&!id(v.goalId))invalid();
  if(['queueUpdate','queueRemove','queueSteer'].includes(p.operation)&&!id(v.queueItemId))invalid();
  if(['queueUpdate','steer'].includes(p.operation)&&!text(v.text))invalid();
  if(['queueSteer','steer'].includes(p.operation)&&!id(v.expectedTurnId))invalid();
  if(p.operation==='queueReorder'&&(!Array.isArray(v.queueItemIds)||v.queueItemIds.length>128||v.queueItemIds.some(x=>!id(x))||new Set(v.queueItemIds).size!==v.queueItemIds.length))invalid();
}
function nativeControl(p){
  const values={...p.values};
  if(values.text!==undefined){values.input=[{type:'text',text:values.text}];delete values.text;}
  return {method:methods[p.operation],params:{threadId:p.threadId,...(p.operation==='steer'?{}:{expectedRevision:p.expectedRevision}),...values}};
}
module.exports={validateControl,nativeControl};
