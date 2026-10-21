import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Runs inside the existing migration harness: actual isolated Electron/Core.
export function settingsStage1(scratch) {
  const frames = [], events = [];
  const baseline = process.env.AREAL_SETTINGS_BASELINE === '1';
  return { model: () => false, frames: () => frames, async run({app, page: getPage, button, state, until, received, checks, quit, launch}) {
    let page = getPage();
    const capture = async id => {
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const metrics = await page.evaluate(() => {
        const host = document.querySelector('.settings-workspace');
        return { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
          theme: document.documentElement.className,
          font: getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size'),
          active: document.activeElement?.getAttribute('aria-label'),
          pageOverflow: host ? host.scrollWidth > host.clientWidth + 1 : false,
          labels: [...document.querySelectorAll('.settings-field-label')].filter(e => e.checkVisibility()).map(e => e.textContent),
          rows: [...document.querySelectorAll('.settings-field-control')].filter(e => e.checkVisibility()).map(e => {
            const r=e.getBoundingClientRect(); return {x:r.x,right:r.right,bottom:r.bottom,width:r.width};
          }) };
      });
      await page.screenshot({path:join(scratch,id+'.png'),scale:'css',animations:'disabled'});
      await writeFile(join(scratch,id+'.aria.txt'),await page.locator('body').ariaSnapshot());
      frames.push(id+'.png'); events.push({id,wall:Date.now(),metrics});
      assert.equal(metrics.pageOverflow,false,id+': settings has no horizontal overflow');
      return metrics;
    };
    const choose = async (label, name) => {
      const trigger=page.getByRole('combobox',{name:label,exact:true});
      await trigger.click(); await page.getByRole('option',{name,exact:true}).click();
      await page.getByRole('listbox').waitFor({state:'hidden'});
      assert.equal(await trigger.evaluate(e=>e===document.activeElement),true,'menu returns focus');
    };
    const size = (w,h) => app().evaluate(({BrowserWindow},v)=>BrowserWindow.getAllWindows()[0].setContentSize(...v),[w,h]);
    try {
      await size(1440,960);
      await writeFile(join(scratch,'settings-host.json'),JSON.stringify(await app().evaluate(({app,BrowserWindow})=>{
        const w=BrowserWindow.getAllWindows()[0];return {pid:process.pid,versions:process.versions,userData:app.getPath('userData'),contentBounds:w.getContentBounds(),preferences:w.webContents.getLastWebPreferences()};
      }),null,2));
      await page.locator('[data-testid="chat-input"]').click();
      await page.keyboard.insertText('设置验证草稿：暂不发送。');
      await page.waitForFunction(() => Object.values(localStorage).some(value => value === '设置验证草稿：暂不发送。'));
      await button('设置').click(); await button('外观').click();
      await choose('界面主题','深色');
      await page.locator('.settings-workspace').evaluate(e=>e.scrollTop=0);
      await capture('01-appearance-overview');
      if(!baseline){
        await page.getByRole('spinbutton',{name:'界面字号',exact:true}).waitFor({state:'visible'});
        assert.equal(await page.locator('details[open]').count(),0,'specialized controls start collapsed');
        const reading=page.locator('summary').filter({hasText:'阅读与代码'});
        await reading.focus(); await page.keyboard.press('Enter');
        await page.getByRole('spinbutton',{name:'代码字号',exact:true}).waitFor({state:'visible'});
      }
      await page.locator('.settings-workspace').evaluate(e=>e.scrollTop=0);
      await capture('02-reading-details');
      if(!baseline)await page.locator('summary').filter({hasText:'配色微调'}).click();
      const color=page.getByRole('textbox',{name:'深色强调色',exact:true});
      const prior=await color.inputValue();
      await color.fill('#bad'); assert.equal(await color.getAttribute('aria-invalid'),'true');
      await color.fill(prior); assert.equal(await color.getAttribute('aria-invalid'),'false');
      await page.getByRole('tablist',{name:'编辑配色',exact:true}).getByRole('tab',{name:'浅色配色',exact:true}).click();
      await page.getByRole('textbox',{name:'浅色强调色',exact:true}).waitFor({state:'visible'});
      assert.equal(await page.getByRole('combobox',{name:'界面主题',exact:true}).innerText(),'深色','editing inactive palette does not switch app theme');
      await page.getByRole('tablist',{name:'编辑配色',exact:true}).getByRole('tab',{name:'深色配色',exact:true}).click();
      assert.equal(await color.inputValue(),prior,'palette value survives mode switches');
      await capture('03-palette-details');
      await choose('减少动态效果','开启');
      const uiSize=page.getByRole('spinbutton',{name:'界面字号',exact:true});
      await uiSize.fill('18'); await uiSize.press('Tab');
      await size(1000,720); await capture('04-narrow-large');
      await uiSize.fill('14'); await uiSize.press('Tab'); await size(1440,960);
      await button('常规').click();
      const permission=page.getByRole('switch',{name:'启用权限通知',exact:true});
      const checked=await permission.getAttribute('aria-checked')==='true';
      await permission.click();
      await until(s=>s.library?.settings?.permissionNotifications===!checked,'Core persisted notification choice');
      await capture('05-general');
      await page.getByRole('searchbox',{name:'搜索设置',exact:true}).fill('不存在的设置');
      await page.getByRole('status').filter({hasText:'没有匹配的设置'}).waitFor();
      await capture('06-search-empty');
      await button('清除设置搜索').click();
      await button('外观').click(); await choose('界面主题','浅色');
      await page.locator('.settings-workspace').evaluate(e=>e.scrollTop=0);
      await capture('07-light-overview');
      await button('返回应用').click();
      // The editor restores its saved draft on the next frame after mounting.
      await page.waitForFunction(() => document.querySelector('[data-testid="chat-input"]')?.textContent?.includes('设置验证草稿：暂不发送。'));
      assert.equal((await page.locator('[data-testid="chat-input"]').innerText()).trim(),'设置验证草稿：暂不发送。','settings return retains composer draft');
      assert.equal(received.length,0,'settings journey sends no model request');
      await quit(); await launch(); page=getPage(); await size(1440,960);
      await button('设置').click(); await button('常规').click();
      assert.equal(await page.getByRole('switch',{name:'启用权限通知',exact:true}).getAttribute('aria-checked'),String(!checked),'notification survives Electron restart');
      await button('外观').click();
      assert.equal(await page.getByRole('combobox',{name:'界面主题',exact:true}).innerText(),'浅色','theme survives Electron restart');
      if(baseline){const toggle=page.getByRole('button',{name:/高级/});if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();}
      assert.equal(await page.getByRole('combobox',{name:'减少动态效果',exact:true}).innerText(),'开启','motion preference survives restart');
      await capture('08-reopened');
      checks.push('settings stage1: real Electron navigation/search, keyboard disclosure, shared controls, palette isolation, invalid draft, narrow large font, Core save/reopen, theme/motion persistence, unsent draft return');
    } finally { await writeFile(join(scratch,'settings-events.json'),JSON.stringify({baseline,events,limits:['project picker injected','local-only model never invoked','source macOS Electron; no package or other OS claim']},null,2)); }
  }};
}
