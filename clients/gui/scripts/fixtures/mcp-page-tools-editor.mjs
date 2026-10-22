import {EditorState, StateField} from '@codemirror/state';
import {EditorView, keymap} from '@codemirror/view';
import {history, historyKeymap, isolateHistory, redo, redoDepth, undo, undoDepth} from '@codemirror/commands';

const baseline = 'alpha beta\nsecond line\n';
const revision = StateField.define({create: () => 0, update: (value, transaction) => value + Number(transaction.docChanged)});
const documentId = crypto.randomUUID();
const bootId = crypto.randomUUID();
const calls = [];
const events = [];
const targetInfo = target => target ? {id:target.id,tag:target.tagName,text:target.textContent?.slice(0,40)} : null;
for (const type of ['pointerdown','mousedown','click','keydown','keyup']) document.addEventListener(type, event => {events.push({type,trusted:event.isTrusted,target:targetInfo(event.target),key:event.key,x:event.clientX,y:event.clientY,hit:Number.isFinite(event.clientX)?targetInfo(document.elementFromPoint(event.clientX,event.clientY)):null});}, true);
const active = new Map();
const pending = new Map();
let sequence = 0;
const view = new EditorView({
  parent: document.querySelector('#editor'),
  state: EditorState.create({doc: baseline, extensions: [revision, history(), keymap.of(historyKeymap), EditorView.contentAttributes.of({'aria-label': 'Unsaved CodeMirror document'})]}),
});
const snapshot = () => ({bootId, documentId, text: view.state.doc.toString(), documentRevision: view.state.field(revision), anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, dirty: view.state.doc.toString() !== baseline, undoDepth: undoDepth(view.state), redoDepth: redoDepth(view.state), calls: structuredClone(calls.map(({release, ...call}) => call))});
window.fixture = Object.freeze({snapshot,diagnostics:() => ({events,hasFocus:document.hasFocus(),active:document.activeElement?.outerHTML,selection:{anchor:view.state.selection.main.anchor,head:view.state.selection.main.head},endHandler:String(document.querySelector('#end').onclick)})});
document.querySelector('#select').onclick = () => view.dispatch({selection: {anchor: 0, head: 5}});
document.querySelector('#end').onclick = () => {view.dispatch({selection: {anchor: view.state.doc.length}}); view.focus();};
document.querySelector('#undo').onclick = () => undo(view);
document.querySelector('#redo').onclick = () => redo(view);
document.querySelector('#release').onclick = () => {for (const call of active.values()) call.release?.();};
const send = value => parent.postMessage({jsonrpc: '2.0', ...value}, '*');
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, {resolve, reject});
  send({id, method, params});
});
const splitSurrogate = (text, offset) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
async function execute(params, signal, record) {
  if (params.documentId !== documentId) throw Error('wrong document');
  const fault = document.querySelector('#fault').value;
  if (fault === 'beforeEdit') {
    record.waiting = 'beforeEdit';
    await new Promise(resolve => {record.release = resolve; signal.addEventListener('abort', resolve, {once: true});});
  }
  if (signal.aborted) return {status: 'noEffect', reason: 'cancelled'};
  const state = view.state;
  const documentRevision = state.field(revision);
  const dirty = state.doc.toString() !== baseline;
  if (params.kind === 'getSelection') {
    if (fault === 'oversizedReply') return {status:'completed',result:{kind:'selection',documentId,documentRevision,anchor:0,head:32769,selectedText:'x'.repeat(32769),truncated:false,dirty}};
    const {anchor, head, from, to} = state.selection.main;
    const text = state.sliceDoc(from, to);
    return {status: 'completed', result: {kind: 'selection', documentId, documentRevision, anchor, head, selectedText: text.slice(0, 4096), truncated: text.length > 4096, dirty}};
  }
  if (params.kind !== 'applyPatch') throw Error('unsupported page tool');
  const {expectedDocumentRevision, patch} = params.arguments;
  if (expectedDocumentRevision !== documentRevision) return {status: 'completed', result: {kind: 'conflict', documentId, expectedDocumentRevision, documentRevision}};
  const {from, to, insert} = patch;
  const text = state.doc.toString();
  const rejected = reason => ({status: 'completed', result: {kind: 'rejected', documentId, documentRevision, reason}});
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > text.length || typeof insert !== 'string' || insert.length > 4096 || insert.includes('\r') || splitSurrogate(text, from) || splitSurrogate(text, to)) return rejected('invalidRange');
  if (text.length - (to - from) + insert.length > 65536) return rejected('documentTooLarge');
  if (text.slice(from, to) === insert) return rejected('noChange');
  view.dispatch(state.update({changes: {from, to, insert}, annotations: isolateHistory.of('full')}));
  record.applied = true;
  if (fault === 'afterEdit') {
    record.waiting = 'afterEdit';
    await new Promise(resolve => {record.release = resolve; signal.addEventListener('abort', resolve, {once: true});});
    if (signal.aborted) return {status: 'unknown'};
  }
  return {status: 'completed', result: {kind: 'applied', documentId, previousDocumentRevision: documentRevision, documentRevision: view.state.field(revision), from, to, insertedLength: insert.length, dirty: view.state.doc.toString() !== baseline}};
}
addEventListener('message', async event => {
  if (event.source !== parent || event.data?.jsonrpc !== '2.0') return;
  const value = event.data;
  if (pending.has(value.id)) {
    const {resolve, reject} = pending.get(value.id);
    pending.delete(value.id);
    value.error ? reject(Error(value.error.message)) : resolve(value.result);
    return;
  }
  if (value.method === 'notifications/cancelled') {
    active.get(value.params?.requestId)?.controller.abort();
    return;
  }
  if (value.method !== 'areal/page-tools/call' || value.id === undefined) return;
  const record = {callId: value.params.callId, kind: value.params.kind, arguments: structuredClone(value.params.arguments), applied: false};
  calls.push(record);
  const controller = new AbortController();
  active.set(value.id, {controller, set release(fn) {record.release = fn;}, get release() {return record.release;}});
  try {
    const reply = await execute(value.params, controller.signal, record);
    delete record.release;
    record.reply = reply;
    send({id: value.id, result: reply});
  } catch (error) {
    delete record.release;
    record.error = error.message;
    send({id: value.id, error: {code: -32602, message: error.message}});
  } finally {active.delete(value.id);}
});
request('ui/initialize', {appInfo: {name: 'page-tools-editor-fixture', version: '1'}, protocolVersion: '2026-01-26', appCapabilities: {experimental: {'areal/page-tools': {version: 1, documentId, tools: ['getSelection', 'applyPatch']}}}}).then(() => {
  send({method: 'ui/notifications/initialized'});
  document.querySelector('#ready').textContent = 'initialized';
}).catch(error => {document.querySelector('#ready').textContent = error.message;});
