import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { cpus, loadavg } from "node:os";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const rendererRequire = createRequire(join(gui, "renderer/package.json"));
const { _electron: electron } = require("playwright-core");
const { build, loadConfigFromFile } = await import(
  pathToFileURL(rendererRequire.resolve("vite")).href
);
const evidence = resolve(
  process.env.AREAL_DIFF_CACHE_EVIDENCE ??
    join(root, ".scratch/diff-cache-fix-20261020/test-" + Date.now()),
);
const isolated = await makeTempDir("areal-diff-cache-");
await mkdir(evidence, { recursive: true });
const fixture = join(evidence, "test-fixture.tsx");
const html = join(evidence, "test-fixture.html");
const outDir = join(evidence, "test-build");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  "renderer/src/GitPane.tsx",
  "renderer/src/GitPaneChangeCard.tsx",
  "renderer/src/components/ui/diff-viewer.tsx",
  "scripts/diff-cache-smoke.mjs",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (file) => [file, sha(await readFile(join(gui, file)))])),
);
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const diffSha256 = sha(execFileSync("git", ["diff", "HEAD"], { cwd: root }));
await writeFile(
  fixture,
  `import React,{useLayoutEffect,useState} from ${JSON.stringify(join(gui, "renderer/node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(join(gui, "renderer/node_modules/react-dom/client.js"))};
import {FileDiff,getHighlighterIfLoaded} from ${JSON.stringify(join(gui, "renderer/node_modules/@pierre/diffs/dist/index.js"))};
import {GitPane} from ${JSON.stringify(join(gui, "renderer/src/GitPane.tsx"))};
import ${JSON.stringify(join(gui, "renderer/src/styles.css"))};
import ${JSON.stringify(join(gui, "renderer/src/workbench.css"))};
const path='src/cache-regression.ts';
const before=Array.from({length:1600},(_,i)=>'export const fold_kept_'+String(i+1).padStart(5,'0')+' = { value: '+i+', label: "original" };').join('\\n')+'\\n';
let changed=false,commits=0,nextCommit,updateTimer,restore;
const calls=[],measurements={renderCalls:0,codeToHastCalls:0,identicalTextCalls:0,textLengths:[],frameIntervals:[]};
const after=()=>before.replace('fold_kept_00010 = { value: 9, label: "original" }','fold_kept_00010 = { value: 9, label: "'+(changed?'DIFF_CACHE_CHANGED_TEXT':'DIFF_CACHE_INITIAL_TEXT')+'" }').replace('fold_kept_01200 = { value: 1199, label: "original" }','fold_kept_01200 = { value: 1199, label: "second change" }');
const action=async(name,p)=>{calls.push({name,...p});if(p.operation==='review')return {token:changed?'changed-token':'initial-token',head:'fixture-head',base:'fixture-base',root:'/fixture',files:[{path,additions:2,deletions:2,binary:false,beforeText:before,afterText:after()}],diff:'diff --git a/'+path+' b/'+path+'\\n--- a/'+path+'\\n+++ b/'+path+'\\n@@ -9,3 +9,3 @@\\n '+before.split('\\n')[8]+'\\n-'+before.split('\\n')[9]+'\\n+'+after().split('\\n')[9]+'\\n '+before.split('\\n')[10]+'\\n'};if(p.operation==='gitState')return {root:'/fixture',head:'fixture-head',branch:'fixture',token:'fixture-index',staged:[],unstaged:[],remotes:[]};throw Error('Unexpected action '+p.operation);};
function App(){const [epoch,setEpoch]=useState(0);useLayoutEffect(()=>{commits++;nextCommit?.();nextCommit=undefined;},[epoch]);
window.diffCacheTest={calls,measurements,get commits(){return commits;},pulse:()=>new Promise(r=>{nextCommit=r;setEpoch(x=>x+1);}),changeText(){changed=true;},startUpdates(){clearInterval(updateTimer);updateTimer=setInterval(()=>setEpoch(x=>x+1),60);},stopUpdates(){clearInterval(updateTimer);},instrument(){const highlighter=getHighlighterIfLoaded();if(!highlighter)throw Error('Actual Pierre highlighter is not ready');const original=highlighter.codeToHast,render=FileDiff.prototype.render,seen=new Set([before,after()]);highlighter.codeToHast=function(text,...args){measurements.codeToHastCalls++;if(seen.has(text))measurements.identicalTextCalls++;seen.add(text);measurements.textLengths.push(text.length);return original.call(this,text,...args);};FileDiff.prototype.render=function(...args){measurements.renderCalls++;return render.apply(this,args);};let previous,active=true;const frame=now=>{if(!active)return;if(previous!==undefined)measurements.frameIntervals.push(now-previous);previous=now;requestAnimationFrame(frame);};requestAnimationFrame(frame);restore=()=>{active=false;highlighter.codeToHast=original;FileDiff.prototype.render=render;};},dispose(){clearInterval(updateTimer);restore?.();}};
return <div style={{height:'100vh',width:'100vw'}}><output style={{position:'fixed',right:8,bottom:0,zIndex:100,pointerEvents:'none'}} data-testid="fixture-epoch">{epoch}</output><GitPane projectId="diff-cache-fixture" root="/fixture" threadId="diff-cache-thread" action={action} onReveal={()=>{}} onFile={()=>{}} /></div>;}
createRoot(document.getElementById('root')).render(<App/>);`,
);
await writeFile(
  html,
  `<html><head><meta charset="UTF-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="./test-fixture.tsx"></script></body></html>`,
);
const loaded = await loadConfigFromFile(
  { command: "build", mode: "design-system" },
  join(gui, "renderer/vite.config.ts"),
);
await build({
  ...loaded.config,
  configFile: false,
  root: evidence,
  publicDir: join(gui, "renderer/public"),
  resolve: {
    ...loaded.config.resolve,
    alias: {
      ...loaded.config.resolve.alias,
      "react/jsx-runtime": rendererRequire.resolve("react/jsx-runtime"),
    },
  },
  mode: "production",
  logLevel: "warn",
  build: {
    ...loaded.config.build,
    outDir,
    emptyOutDir: true,
    rollupOptions: { ...loaded.config.build.rollupOptions, input: html },
  },
});
const server = createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, "http://fixture").pathname).replace(
      /^\//,
      "",
    );
    const target = resolve(outDir, relative || "test-fixture.html");
    if (!target.startsWith(outDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    const file = (await stat(target)).isDirectory() ? join(target, "test-fixture.html") : target;
    const mime =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".wasm": "application/wasm",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      }[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const main = join(isolated, "main.cjs");
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(isolated, "userData"))});app.whenReady().then(()=>{const window=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});window.loadURL(${JSON.stringify(`http://127.0.0.1:${address.port}/test-fixture.html`)});});app.on('window-all-closed',()=>app.quit());`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [],
  checks = [],
  clickLatencies = [];
let app,
  page,
  childProcess,
  passed = false,
  failure,
  measurements,
  isolation,
  baseline,
  scrollEvidence,
  cleanup;
const button = (name) => page.getByRole("button", { name, exact: true });
const line = (marker) => page.locator("[data-line]").filter({ hasText: marker });
const snapshot = async (name) => {
  await page.screenshot({ path: join(evidence, name + ".png") });
  await writeFile(join(evidence, name + ".aria.txt"), await page.locator("body").ariaSnapshot());
};
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [main],
    env,
    timeout: 60000,
  });
  childProcess = app.process();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  isolation = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  assert.deepEqual(isolation, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await button("src/cache-regression.ts").waitFor();
  await button("src/cache-regression.ts").click();
  await line("DIFF_CACHE_INITIAL_TEXT").first().waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector("[data-diff-viewer]")
      ?.querySelector("diffs-container")
      ?.shadowRoot?.querySelector("[data-line] span[style]"),
  );
  await page.evaluate(() => window.diffCacheTest.instrument());
  baseline = await page.evaluate(() => ({
    commits: window.diffCacheTest.commits,
    ...window.diffCacheTest.measurements,
  }));
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.diffCacheTest.pulse());
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  measurements = await page.evaluate(() => ({
    commits: window.diffCacheTest.commits,
    ...window.diffCacheTest.measurements,
  }));
  await snapshot("test-unchanged-parent");
  assert.equal(
    measurements.commits - baseline.commits,
    8,
    "Eight unrelated parent commits actually run",
  );
  checks.push(
    "production GitPane and actual highlighted Pierre content rendered in sandboxed Electron",
  );
  assert.equal(
    measurements.codeToHastCalls,
    baseline.codeToHastCalls,
    "Unchanged full texts must reuse warmed highlighter output during parent commits",
  );
  checks.push(
    "unchanged full texts reused warmed highlighter output across eight actual parent commits",
  );
  const expand = page
    .locator('[data-expand-index="1"]')
    .getByRole("button", { name: "展开下方未改动行", exact: true });
  await expand.click();
  await line("fold_kept_01100").first().waitFor();
  await page.evaluate(() => window.diffCacheTest.pulse());
  await line("fold_kept_01100").first().waitFor();
  checks.push(
    "manually expanded unchanged context remains visible after an unrelated parent commit",
  );
  const beforeComment = await page.evaluate(
    () => window.diffCacheTest.measurements.codeToHastCalls,
  );
  await page
    .locator('[data-line][data-line-type="change-addition"]')
    .filter({ hasText: "DIFF_CACHE_INITIAL_TEXT" })
    .first()
    .click();
  await button("变更选项").click();
  await page.getByRole("menuitem", { name: "评论所选行", exact: true }).click();
  await page.getByRole("textbox", { name: "审查评论", exact: true }).fill("CACHE_COMMENT_REMAINS");
  await button("保存评论").click();
  await page.evaluate(() => window.diffCacheTest.pulse());
  assert.equal(
    await page.getByRole("textbox", { name: "编辑已保存审查评论", exact: true }).inputValue(),
    "CACHE_COMMENT_REMAINS",
  );
  assert.equal(
    await page.evaluate(() => window.diffCacheTest.measurements.codeToHastCalls),
    beforeComment,
    "Selection and annotation changes must reuse unchanged highlighted full texts",
  );
  checks.push(
    "real line selection and saved comment survive parent updates without repeating full-file highlighting",
  );
  await page.evaluate(() => window.diffCacheTest.startUpdates());
  const scroll = page.locator(".review-change-scroll");
  const beforeScroll = await page
    .locator(".review-change-scroll, .review-change-scroll [data-diff-viewer]")
    .evaluateAll((elements) => elements.map((el) => el.scrollTop));
  await scroll.hover();
  await page.mouse.wheel(0, 480);
  await page.waitForFunction(
    (tops) =>
      [
        ...document.querySelectorAll(
          ".review-change-scroll, .review-change-scroll [data-diff-viewer]",
        ),
      ].some((el, i) => el.scrollTop > tops[i]),
    beforeScroll,
  );
  scrollEvidence = {
    before: beforeScroll,
    after: await page
      .locator(".review-change-scroll, .review-change-scroll [data-diff-viewer]")
      .evaluateAll((elements) => elements.map((el) => el.scrollTop)),
  };
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await button("变更选项").click();
    await page.getByRole("menuitem", { name: "刷新改动", exact: true }).waitFor();
    clickLatencies.push(performance.now() - start);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
  }
  await page.evaluate(() => window.diffCacheTest.stopUpdates());
  checks.push(
    "actual wheel input advances the review scroll and five option-menu clicks respond during repeated parent updates",
  );
  await page.evaluate(() => window.diffCacheTest.changeText());
  await button("变更选项").click();
  await page.getByRole("menuitem", { name: "刷新改动", exact: true }).click();
  await line("DIFF_CACHE_CHANGED_TEXT").first().waitFor();
  assert.equal(await line("DIFF_CACHE_INITIAL_TEXT").count(), 0);
  checks.push("GitPane refresh displays changed full text and removes the prior marker");
  await snapshot("test-final");
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) await snapshot("test-failure").catch(() => {});
} finally {
  if (page)
    measurements = await page
      .evaluate(() => {
        window.diffCacheTest?.dispose();
        return {
          commits: window.diffCacheTest?.commits,
          ...window.diffCacheTest?.measurements,
          actionCalls: window.diffCacheTest?.calls,
        };
      })
      .catch(() => measurements);
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(isolated, { recursive: true, force: true });
  cleanup = {
    electronPid: childProcess?.pid,
    electronExitCode: childProcess?.exitCode,
    electronSignal: childProcess?.signalCode,
    electronExited:
      !childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null,
    serverClosed: !server.listening,
    userDataRemoved: true,
  };
  if (!cleanup.electronExited) {
    passed = false;
    process.exitCode = 1;
    failure ??= { message: "Owned Electron process did not exit" };
  }
  const changedDuringRun = [];
  for (const [file, hash] of Object.entries(sourceHashes))
    if (sha(await readFile(join(gui, file))) !== hash) changedDuringRun.push(file);
  if (changedDuringRun.length) {
    passed = false;
    process.exitCode = 1;
    failure ??= { message: "Tested source changed during run", files: changedDuringRun };
  }
  const summary = (values) => {
    if (!values?.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: sorted.length,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      minMs: sorted[0],
      maxMs: sorted.at(-1),
    };
  };
  const report = {
    passed,
    failure,
    checks,
    errors,
    source,
    diffSha256,
    sourceHashes,
    changedDuringRun,
    isolation,
    baseline,
    measurements,
    scrollEvidence,
    cleanup,
    automationActionToVisible: summary(clickLatencies),
    frameIntervals: summary(measurements?.frameIntervals),
    environment: {
      electron: require("electron/package.json").version,
      playwright: require("playwright-core/package.json").version,
      logicalCpus: cpus().length,
      loadavg: loadavg(),
      isolated,
    },
    method: {
      highlighter:
        "Pass-through original shared codeToHast wrapper installed after actual highlighted content is ready; unchanged-input assertion remains eight awaited parent commits.",
      automationActionToVisible:
        "Node wall time before Playwright click through actual menu-item visibility; includes actionability waits and IPC, not browser event latency.",
      frameIntervals:
        "Renderer rAF deltas across all observed phases, including context expansion and changed-text refresh; maximum cannot be attributed to unchanged scrolling, and no smooth-60fps claim is made.",
    },
    scope:
      "Production-bundled GitPane renderer with actual Pierre in sandboxed Electron; deterministic review action; no Core/provider/installed-app/physical-input acceptance. Timing samples are shared-host diagnostics, not a comparative speedup claim.",
  };
  await writeFile(join(evidence, "test-manifest.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        passed,
        evidence,
        failure,
        checks,
        errors,
        cleanup,
        measurements: measurements && {
          commits: measurements.commits,
          renderCalls: measurements.renderCalls,
          codeToHastCalls: measurements.codeToHastCalls,
          identicalTextCalls: measurements.identicalTextCalls,
        },
        automationActionToVisible: report.automationActionToVisible,
        frameIntervals: report.frameIntervals,
      },
      null,
      2,
    ),
  );
}
