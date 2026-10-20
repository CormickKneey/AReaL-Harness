import {writeFile,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';

// Native-only continuation of the existing conversation host scenario. The OS
// interaction receipt is written only after observing the actual native UI.
export async function conversationNative({getApp,page,scratch,previewUrl,input,latest,button,recording,capture,mark,check,received}) {
 const mainId=await getApp().evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].id);
 await getApp().evaluate(({BrowserWindow},id)=>{
  const w=BrowserWindow.fromId(id);globalThis.__e4HostEvents=[];
  for(const event of ['focus','blur','show','hide','minimize','restore'])w.on(event,()=>globalThis.__e4HostEvents.push({event,wall:Date.now(),windowId:w.id,focused:w.isFocused()}));
 },mainId);
 await page.evaluate(()=>{window.__e4Activation=[];for(const type of ['focus','blur','visibilitychange'])window.addEventListener(type,()=>window.__e4Activation.push({type,wall:Date.now(),focus:document.activeElement?.getAttribute('data-testid'),visible:document.visibilityState}));});
 const foreground=await getApp().evaluate(async({app,BrowserWindow},id)=>{
  app.focus({steal:true});const w=BrowserWindow.fromId(id);w.focus();const end=Date.now()+3000;
  while(!w.isFocused()&&Date.now()<end)await new Promise(r=>setTimeout(r,30));
  return{windowId:id,focused:w.isFocused(),wall:Date.now()};
 },mainId);
 check(foreground.focused,'owned validation window is foreground before native switch',foreground);
 const heading=latest().getByRole('heading',{name:'6. 借阅记录核查',exact:true});
 await heading.scrollIntoViewIfNeeded();await input().fill('E4 未发送草稿：候选与预览返回后继续核对。');await input().click();
 const anchor=async()=>heading.evaluate(el=>({text:el.textContent,y:el.getBoundingClientRect().y}));
 const before=await anchor(),draft=await input().innerText(),requests=received.length;
 check(before.y>=0&&before.y<await page.evaluate(()=>innerHeight),'reading anchor is visible before native switch',before);
 const auxiliary=await getApp().evaluate(async({BrowserWindow})=>{
  const w=new BrowserWindow({title:'E4 auxiliary validation',width:520,height:380,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>E4 auxiliary validation</title><h1>E4 auxiliary validation</h1><p>Task-owned window switch target.</p><input aria-label="E4 auxiliary input" placeholder="Auxiliary window">'));
  for(const event of ['focus','blur'])w.on(event,()=>globalThis.__e4HostEvents.push({event,wall:Date.now(),windowId:w.id,focused:w.isFocused()}));
  w.show();w.focus();return{id:w.id,title:w.getTitle()};
 });
 await page.waitForTimeout(200);await capture('e4-01-background','native BrowserWindow auxiliary became focused');
 const focusAway=await getApp().evaluate(async({BrowserWindow},{mainId,auxId})=>{
  const main=BrowserWindow.fromId(mainId),aux=BrowserWindow.fromId(auxId),end=Date.now()+3000;
  while((main.isFocused()||!aux.isFocused())&&Date.now()<end)await new Promise(r=>setTimeout(r,30));
  return{main:main.isFocused(),aux:aux.isFocused(),wall:Date.now()};
 },{mainId,auxId:auxiliary.id});check(!focusAway.main&&focusAway.aux,'native auxiliary owns actual OS focus',focusAway);
 await recording.segment('window-reactivate',()=>getApp().evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id).focus(),mainId));
 const after=await anchor();check(await input().evaluate(el=>el===document.activeElement),'window reactivation restores composer focus');check(await input().innerText()===draft,'window switch preserves draft');check(Math.abs(before.y-after.y)<1,'window switch preserves visible reading anchor',{before,after});
 await capture('e4-02-reactivated','original window focus and same reading anchor after real native focus transfer');
 // Existing narrow fixture consent; this does not validate OS permission UI.
 await getApp().evaluate(({dialog},origin)=>{const original=dialog.showMessageBox.bind(dialog);dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(options.title==='允许本地开发站点'&&options.message===`允许此浏览工作区访问 ${origin}？`&&JSON.stringify(options.buttons)===JSON.stringify(['取消','仅此工作区允许']))return{response:1};return original(...args);};},new URL(previewUrl).origin);
 await input().click();await page.keyboard.press('Meta+t');await page.getByLabel('预览地址',{exact:true}).waitFor();await page.getByLabel('预览地址',{exact:true}).fill(previewUrl);await page.getByLabel('预览地址',{exact:true}).press('Enter');
 let native;
 for(let i=0;i<100;i++){
  native=await getApp().evaluate(async({webContents},url)=>{const c=webContents.getAllWebContents().find(c=>c.getURL().startsWith(url));if(!c||c.isLoading())return null;return{id:c.id,url:c.getURL(),bridge:await c.executeJavaScript('typeof window.arealDesktop'),text:await c.executeJavaScript('document.body.innerText'),image:(await c.capturePage()).toPNG().toString('base64')};},previewUrl);
  if(native?.text.includes('Project preview'))break;await page.waitForTimeout(80);
 }
 if(!native?.text.includes('Project preview'))throw Error('Native preview did not load owned fixture');
 await writeFile(join(scratch,'e4-03-native-preview.png'),Buffer.from(native.image,'base64'));const{image,...facts}=native;mark('native-preview',facts);check(native.bridge==='undefined','native preview has no product bridge');await capture('e4-03-preview-host','host and independent native content captured separately');
 const nativePage=getApp().context().pages().find(p=>p.url().startsWith(previewUrl));
 if(!nativePage)throw Error('Native preview CDP page unavailable for actual UI interaction');
 await nativePage.getByRole('button',{name:'Try preview',exact:true}).click();
 await nativePage.getByRole('button',{name:'Preview clicked',exact:true}).waitFor();
 check(await nativePage.getByRole('button',{name:'Preview clicked',exact:true}).isVisible(),'native preview UI action reaches independent page');
 await nativePage.screenshot({path:join(scratch,'e4-03-native-clicked.png')});
 // Focus the actual native page, then return using visible host close control.
 await getApp().evaluate(({webContents},id)=>webContents.fromId(id).focus(),native.id);
 await button('关闭面板').click();await page.waitForTimeout(250);
 check(await input().evaluate(el=>el===document.activeElement),'native preview close restores invoking composer');check(await input().innerText()===draft,'native preview return preserves draft');
 const returned=await anchor();check(Math.abs(before.y-returned.y)<1,'native preview return preserves reading anchor',{before,returned});
 const visible=await getApp().evaluate(({BrowserWindow},{mainId,nativeId})=>BrowserWindow.fromId(mainId).contentView.children.find(v=>v.webContents?.id===nativeId)?.getVisible()??false,{mainId,nativeId:native.id});
 check(!visible,'native preview is actually hidden after host panel closes');await capture('e4-04-preview-return','observe actual focus before a recovery click');
 await getApp().evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id)?.close(),auxiliary.id);
 await input().fill('');await input().click();
 const ready={mainId,auxiliary,nativeId:native.id,previewUrl,requestsBefore:requests,wall:Date.now(),cdp:process.env.AREAL_E3_CDP_PORT};
 await writeFile(join(scratch,'native-ready.json'),JSON.stringify(ready,null,2));console.log('E4_NATIVE_READY:',scratch);
 if(process.env.AREAL_E4_OPERATOR==='0')mark('native-operator-skipped',{reason:'Automated window/preview regression only; no new physical IME or candidate evidence.'});
 else {
  const end=Date.now()+900000;let done=false;
  while(Date.now()<end){try{await access(join(scratch,'native-done.json'));done=true;break}catch{}await new Promise(r=>setTimeout(r,150));}
  check(done,'native operator observation completed');
  if(done)mark('native-result',{result:JSON.parse(await readFile(join(scratch,'native-done.json'),'utf8'))});
 }
 check(received.length===requests,'native host operations do not resubmit');
 await writeFile(join(scratch,'activation-events.json'),JSON.stringify({host:await getApp().evaluate(()=>globalThis.__e4HostEvents),renderer:await page.evaluate(()=>window.__e4Activation)},null,2));
 await capture('e4-05-native-final','native observation complete; original event logs retained');
}
