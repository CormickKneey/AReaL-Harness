import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';

export async function pageToolsEditorHtml() {
  const renderer = resolve(dirname(fileURLToPath(import.meta.url)), '../../renderer');
  const require = createRequire(join(renderer, 'package.json'));
  const {build} = await import(require.resolve('vite'));
  const packages = ['@codemirror/state', '@codemirror/view', '@codemirror/commands'];
  const bundle = await build({
    configFile: false,
    root: renderer,
    logLevel: 'error',
    resolve: {alias: Object.fromEntries(packages.map(name => [name, require.resolve(name)]))},
    build: {write: false, minify: true, lib: {entry: fileURLToPath(new URL('./mcp-page-tools-editor.mjs', import.meta.url)), formats: ['iife'], name: 'PageToolsEditor'}, rollupOptions: {output: {inlineDynamicImports: true}}},
  });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  assert.equal(outputs.length, 1, 'one inline fixture bundle');
  const chunks = outputs[0].output.filter(output => output.type === 'chunk');
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].imports, []);
  const script = chunks[0].code.replaceAll('</script', '<\\/script');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px}.cm-editor{height:220px;border:1px solid #888}.cm-scroller{overflow:auto}button,select{margin:8px 4px 8px 0}</style></head><body><h1>Page tools editor</h1><output id="ready">waiting</output><div id="editor"></div><button id="select">Select first word</button><button id="end">Move caret to end</button><button id="undo">Undo</button><button id="redo">Redo</button><label>Fault boundary <select id="fault"><option value="normal">None</option><option value="beforeEdit">Before editor transaction</option><option value="afterEdit">After editor transaction</option><option value="oversizedReply">Oversized output at guest reply boundary</option></select></label><button id="release">Release held reply</button><script>${script}</script></body></html>`;
  assert(Buffer.byteLength(html) <= 2 * 1024 * 1024, 'inline MCP resource respects existing 2 MiB budget');
  const versions = {};
  for (const name of packages) {
    let directory = dirname(require.resolve(name));
    for (;;) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name === name) {versions[name] = manifest.version; break;}
      } catch (error) {if (error.code !== 'ENOENT') throw error;}
      const parent = dirname(directory);
      assert.notEqual(parent, directory, 'installed CodeMirror package manifest');
      directory = parent;
    }
  }
  return {html, bytes: Buffer.byteLength(html), versions};
}
