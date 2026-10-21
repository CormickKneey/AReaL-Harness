import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {captureConversationMotion} from './conversation-motion.mjs';

// New content exercises the same production owners; only the external model is
// deterministic. Native candidate confirmation is a separately attributable step.
export function conversationHost(scratch,workspace){
 const events=[],jobs=[];let stage=0;
 const projectState=s=>s.projects.find(p=>p.root===workspace);
 const mark=(kind,data={})=>events.push({kind,wall:Date.now(),...data});
 const report=(count=14)=>'E3_REPORT_BEGIN\n\n## 图书借阅与归还核对\n\n| 类别 | 借出 | 归还 | 净借出 |\n| --- | ---: | ---: | ---: |\n| 技术书 | 18 | 5 | 13 |\n| 文学书 | 7 | 2 | 5 |\n| 合计 | 25 | 7 | 18 |\n\n'+Array.from({length:count},(_,n)=>`### ${n+1}. 借阅记录核查\n\n《异步系统设计：从提交到恢复》属于技术书，《海边的旧书店》属于文学书。只按已记录的借出和归还计算：技术书净借出十三册，文学书净借出五册，共十八册。窗口缩放、子对话和阅读操作不改变这份业务记录。\n\n- 保留各类别和原始数量。\n- 出现未知结果时先核查，不重复执行。\n\n`).join('')+'```json\n{"技术书":13,"文学书":5,"净借出":18,"receipt":"library-regression-03"}\n```\n\nE3_REPORT_END';
 const finish=(send,res,text)=>{send({content:text});send({},'stop');res.end('data: [DONE]\n\n');};
 function model(text,msgs,send,res){
  if(!text.includes('E3_'))return false;
  mark('model',{text,stage});
  if(text.includes('E3_CHILD')){finish(send,res,'独立核对：18−5=13，7−2=5，净借出18册。E3_CHILD_DONE');return true;}
  if(text.includes('E3_HISTORY')){finish(send,res,report(18));return true;}
  if(stage++===0){
   send({content:'我会读取本次合成借阅数据并让独立子任务核对。'});
   send({tool_calls:[{index:0,id:'e3-command',type:'function',function:{name:'run_command',arguments:JSON.stringify({argv:['/bin/sh','-c',"printf 'Technical: 13\\nLiterature: 5\\nNet: 18\\n'; printf done > e3-command-proof"],yieldMs:1000,timeoutMs:10000})}},{index:1,id:'e3-child',type:'function',function:{name:'agent_spawn',arguments:JSON.stringify({prompt:'E3_CHILD：独立核对图书18/7借出与5/2归还后的净借出',intent:'inspect',delivery:'report'})}}]});send({},'tool_calls');res.end('data: [DONE]\n\n');
  }else{
   const text=report();const job=(async()=>{for(let i=0;i<text.length;i+=120){if(res.destroyed)return;send({content:text.slice(i,i+120)});await new Promise(r=>setTimeout(r,30));}send({},'stop');res.end('data: [DONE]\n\n');})();jobs.push(job);
  }
  return true;
 }
 async function run({app:getApp,page:getPage,state,call,until,button,received,checks,previewUrl}){
  const page=getPage(),failures=[];let recording,threadId;
  const input=()=>page.locator('[data-testid="chat-input"]');
  const chat=()=>page.locator('[data-testid="chat-view"]');
  const messages=()=>chat().locator('.messages');
  const latest=()=>messages().locator('[data-latest-turn="true"]');
  const check=(condition,label,data={})=>{mark('assertion',{label,passed:!!condition,...data});if(!condition)failures.push(label);};
  const capture=async(id,reason)=>{
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const current=await page.evaluate(()=>{const el=document.querySelector('[data-testid="chat-view"] .messages');const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scroll: e.scrollTop}};return{now:performance.now(),wall:Date.now(),viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,focus:{tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),testid:document.activeElement?.getAttribute('data-testid')},pane:rect(document.querySelector('[data-testid="chat-view"]')),composer:rect(document.querySelector('.composer-dock')),messages:{...rect(el),gap:el?el.scrollHeight-el.clientHeight-el.scrollTop:null},theme:document.documentElement.classList.contains('dark')?'dark':'light'};});
   await page.screenshot({path:join(scratch,id+'.png'),scale:'css',animations:'allow'});
   await writeFile(join(scratch,id+'.aria.txt'),await page.locator('body').ariaSnapshot());
   mark('checkpoint',{id,reason,metrics:current,state:await state()});await writeFile(join(scratch,'journey-events.json'),JSON.stringify(events,null,2));return current;
  };
  const send=async text=>{
   const before=received.length, prior=projectState(await state()).state.threads;
   const ids=new Set(Object.values(prior).flatMap(t=>(t.turns??[]).map(v=>v.id)));
   await input().fill(text);await button('发送').click();
   const admitted=await until(s=>Object.values(projectState(s).state.threads).some(t=>(t.turns??[]).some(v=>!ids.has(v.id))), 'new turn admission');
   const turn=Object.values(projectState(admitted).state.threads).flatMap(t=>t.turns??[]).find(v=>!ids.has(v.id));
   await until(s=>Object.values(projectState(s).state.threads).some(t=>(t.turns??[]).some(v=>v.id===turn.id&&v.status==='completed')), 'new content complete');
   mark('send',{text,turnId:turn.id,requests:received.length-before});
  };
  try{
   await getApp().evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1509,949));
   const host=await getApp().evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return{pid:process.pid,version:process.versions,userData:app.getPath('userData'),bounds:w.getBounds(),contentBounds:w.getContentBounds(),preferences:{sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration}}});
   await writeFile(join(scratch,'journey-host.json'),JSON.stringify(host,null,2));
   recording=await captureConversationMotion(page,join(scratch,'motion'),{main:'[data-testid="chat-view"] .messages',pane:'[data-testid="chat-view"]',composer:'.composer-dock',surface:'.work-surface',side:'.workspace-side-panel',dialog:'[role="dialog"]'});
   await page.evaluate(()=>{const values=[];const handler=e=>values.push({type:e.type,wall:Date.now(),t:performance.now(),key:e.key,code:e.code,keyCode:e.keyCode,isComposing:e.isComposing,trusted:e.isTrusted,data:e.data,inputType:e.inputType,target:e.target.getAttribute?.('data-testid'),text:e.target.textContent?.slice(0,160),defaultPrevented:e.defaultPrevented});for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','keyup','focusin','focusout'])document.addEventListener(type,handler,true);window.__e3Input={values,stop(){for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','keyup','focusin','focusout'])document.removeEventListener(type,handler,true)}};});
   await button('设置').click();await button('外观').click();await page.getByRole('combobox',{name:'界面主题',exact:true}).click();await page.getByRole('option',{name:'深色',exact:true}).click();await button('返回应用').click();
   await send('E3_HISTORY：保留一份图书借阅回执作为历史。');
   threadId=await page.locator('[data-testid="areal-workbench"]').getAttribute('data-thread-id');
   await send('E3_MAIN：借出技术书18册、文学书7册，归还技术书5册、文学书2册。运行合成命令，并由子代理独立核对，给出表格、核对步骤与JSON回执。');
   await until(s=>projectState(s).state.threads[threadId]?.turns.at(-1)?.status==='completed','new parent converged');
   await latest().getByText(/E3_REPORT_END/).last().waitFor();
   check(await readFile(join(workspace,'e3-command-proof'),'utf8')==='done','actual Runtime command proof');
   const pid=projectState(await state()).id;const children=(await call('manage',{projectId:pid,parentThreadId:threadId,operation:'agents',limit:20})).data;assert.equal(children.length,1);const childId=children[0].id;
   await capture('e3-00-new-content','new topic with table/list/code, real command and child');
   // Panel keyboard return must work without a second click on the transcript.
   const progress=latest().locator('.turn-progress-summary');if(await progress.getAttribute('aria-expanded')==='false')await progress.click();
   const trigger=latest().getByRole('button',{name:`打开 ${childId} 子对话`,exact:true});
   await trigger.click();await page.locator(`[data-agent-conversation="${childId}"]`).waitFor();await capture('e3-01-child','child opened through its actual task entry');
   await button('关闭面板').click();await page.waitForTimeout(350);
   check(await trigger.evaluate(e=>e===document.activeElement),'child panel close returns focus to invocation');
   await capture('e3-02-return','observe actual focus before another click');
   await input().fill('E3 草稿：先核对借阅记录，暂不发送。');const draft=await input().innerText();const requests=received.length;
   for(const [width,height]of [[1000,720],[1280,840],[1509,949]]){
    await recording.segment(`resize-${width}`,()=>getApp().evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]));
    const c=await capture('e3-size-'+width,'native BrowserWindow content resize');
    check(c.composer.y>=0&&c.composer.y+c.composer.height<=c.viewport[1]+1,'composer inside window '+width,c);check(c.pane.scroll===0,'outer chrome does not scroll '+width);check(await input().innerText()===draft,'draft retained '+width);
   }
   await trigger.click();await page.locator(`[data-agent-conversation="${childId}"]`).waitFor();
   await getApp().evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,720));await capture('e3-03-narrow-child','child remains usable in narrow host');
   await button('关闭面板').click();await getApp().evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1509,949));
   await input().click();await page.keyboard.press('Shift+Enter');await page.keyboard.insertText('第二行：18册。');
   check(received.length===requests,'Shift+Enter stays draft without submission');check((await input().innerText()).includes('第二行'),'newline insertion survives layout changes');
   const multilineDraft=await input().innerText();
   await page.keyboard.press('Meta+,');await button('返回应用').waitFor();await capture('e3-04-settings-key','Cmd+, opens settings without losing draft');await page.keyboard.press('Escape');await input().waitFor();
   check(await input().evaluate(e=>e===document.activeElement),'settings Escape restores composer focus');
   check(await input().innerText()===multilineDraft,'settings return preserves multiline draft');
   // Main-process zoom rather than a browser viewport emulator.
   await recording.segment('zoom-125',()=>getApp().evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25)));
   const zoom=await capture('e3-05-zoom','actual webContents zoom125%, CSS pixels recorded separately');
   check(zoom.composer.x>=0&&zoom.composer.x+zoom.composer.width<=zoom.viewport[0]+1&&zoom.composer.y>=0&&zoom.composer.y+zoom.composer.height<=zoom.viewport[1]+1,'composer remains reachable at zoom125%');
   // Playwright CSS-scale capture can crop a zoomed Electron viewport. Keep an
   // independent webContents capture rather than treating that crop as layout.
   const nativeZoom=await getApp().evaluate(async({BrowserWindow})=>{const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage();return{size:image.getSize(),png:image.toPNG().toString('base64')}});
   await writeFile(join(scratch,'e3-05-zoom-native.png'),Buffer.from(nativeZoom.png,'base64'));
   mark('native-zoom-capture',{size:nativeZoom.size});
   await getApp().evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
   // Native capture remains operator/OS-driven. Never turn CDP insertText or
   // imeSetComposition into a claim about a real candidate window.
   if(process.env.AREAL_E4_NATIVE==='1'){
    const {conversationNative}=await import('./conversation-native.mjs');
    await conversationNative({getApp,page,scratch,previewUrl,input,latest,button,recording,capture,mark,check,received});
   }else if(process.env.AREAL_E3_NATIVE==='1'){
    await input().fill('');await input().click();await capture('e3-native-ready','foreground native IME stage, no current execution');
    await writeFile(join(scratch,'native-ready.json'),JSON.stringify({host,threadId,requestsBefore:received.length,cdp:process.env.AREAL_E3_CDP_PORT||null}));
    console.log('E3_NATIVE_READY:',scratch);
    const end=Date.now()+240000;let done=false;
    while(Date.now()<end){try{await access(join(scratch,'native-done.json'));done=true;break}catch{}await new Promise(r=>setTimeout(r,150));}
    check(done,'native observation completed before bounded deadline');
    if(done){mark('native-result',{result:JSON.parse(await readFile(join(scratch,'native-done.json'),'utf8'))});await capture('e3-native-after','native phase final state; original events retained');}
   }
   await input().fill('');check(received.length===requests,'host operations do not resubmit or replay');
   await capture('e3-06-final','new content remains authoritative after host operations');
   checks.push('E3 new topic: actual command/child + native resize/zoom + draft/shortcut/focus checks');
   if(failures.length)throw Error('E3 behavior failures: '+failures.join('; '));
  }finally{
   await writeFile(join(scratch,'journey-final-state.json'),JSON.stringify(await state(),null,2));
   await recording?.stop();
   const inputEvents=await page.evaluate(()=>{const x=window.__e3Input;if(!x)return[];x.stop();delete window.__e3Input;return x.values;}).catch(()=>[]);
   await writeFile(join(scratch,'input-events.json'),JSON.stringify(inputEvents,null,2));
   await writeFile(join(scratch,'journey-events.json'),JSON.stringify(events,null,2));
   await writeFile(join(scratch,'journey-model-requests.json'),JSON.stringify(received,null,2));
   await Promise.allSettled(jobs);
  }
 }
 return{model,run,frames:()=>events.filter(e=>e.kind==='checkpoint').map(e=>e.id+'.png')};
}
