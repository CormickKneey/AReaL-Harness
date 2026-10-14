'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
function identity(value, release = false) {
  const keys = ['projectId', 'threadId', 'requestId', 'fieldName', ...(release ? ['uri'] : [])];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))
    || keys.some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 4096))
    throw new Error('Invalid form resource request');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function fileFilters(accept) {
  if (!Array.isArray(accept) || !accept.length) return undefined;
  const known = { 'text/plain': ['txt', 'text'], 'text/csv': ['csv'], 'application/json': ['json'],
    'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'],
    'image/gif': ['gif'], 'image/webp': ['webp'], 'image/*': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff'] };
  const extensions = [];
  for (const item of accept) {
    if (/^\.[a-z0-9]{1,16}$/i.test(item)) extensions.push(item.slice(1));
    else if (known[item]) extensions.push(...known[item]);
    else return undefined; // Unknown MIME stays selectable; authoritative Core still rejects mismatches.
  }
  return [{ name: '允许的文件', extensions: [...new Set(extensions)] }];
}
// Main only mediates consent. Core owns filesystem snapshots, grants and expiration.
class McpFormResources {
  constructor({ backend, choose, confirm }) {
    this.backend = backend; this.choose = choose; this.confirm = confirm; this.pending = new Map(); this.unsettled = new Map();
  }
  guard(request, current) {
    current();
    if (this.disposed) throw new Error('Form resources closed');
    if (!this.backend.ownsThread(request.projectId, request.threadId)) throw new Error('Form resource owner expired');
  }
  async release(request, current) {
    const owner = identity(request, true); this.guard(owner, current);
    return this.backend.command('manage', { operation: 'mcpFormResourceRelease', ...owner });
  }
  async pick(request, current) {
    const owner = identity(request); this.guard(owner, current);
    const key = JSON.stringify(owner);
    // The same pending user selection must never become two stage mutations.
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = this.select(owner, current).finally(() => this.pending.delete(key));
    this.pending.set(key, pending); return pending;
  }
  async select(owner, current) {
    let result;
    const key = JSON.stringify(owner);
    try {
      let selection = this.unsettled.get(key);
      if (!selection) {
        const prepared = await this.backend.command('manage', { operation: 'mcpFormResourcePrepare', ...owner });
        this.guard(owner, current);
        if (!prepared || typeof prepared.selectionToken !== 'string' || typeof prepared.multiple !== 'boolean'
          || typeof prepared.serverLabel !== 'string') throw new Error('Invalid upload capability');
        const directory = prepared.userOptions?.kind === 'directory';
        const chosen = await this.choose({ title: `为 ${prepared.serverLabel} 选择${directory ? '目录' : '文件'}`,
          properties: [directory ? 'openDirectory' : 'openFile', ...(prepared.multiple ? ['multiSelections'] : [])],
          ...(!directory && fileFilters(prepared.userOptions?.accept) ? { filters: fileFilters(prepared.userOptions.accept) } : {}) });
        this.guard(owner, current);
        if (chosen.canceled || !chosen.filePaths?.length) return { resources: [] };
        if (!prepared.multiple && chosen.filePaths.length !== 1) throw new Error('Invalid selection count');
        // One UUID and its immutable selection survive UNKNOWN. Recovery never reopens the picker.
        const stage = { operation: 'mcpFormResourceStage', projectId: owner.projectId,
          selectionToken: prepared.selectionToken, requestId: randomUUID(), paths: chosen.filePaths };
        selection = { stage, prepared, directory, chosen };
        this.unsettled.set(key, selection);
        try { result = await this.backend.command('manage', stage); }
        catch (error) {
          // A conflict may describe another UNKNOWN request: this stage was not sent.
          if (!error?.submissionUnknown || (error.requestId && error.requestId !== stage.requestId))
            this.unsettled.delete(key);
          throw error;
        }
        this.unsettled.delete(key);
      } else {
        const receipt = await this.backend.command('manage', { operation: 'mcpFormResourceSubmission',
          projectId: owner.projectId, requestId: selection.stage.requestId });
        if (!receipt.confirmed) throw new Error('Upload outcome unknown');
        this.unsettled.delete(key);
        if (!receipt.accepted) throw new Error('Upload failed');
        result = receipt.result;
      }
      const { prepared, directory, chosen } = selection;
      this.guard(owner, current);
      if (!Array.isArray(result?.resources) || result.resources.some(item => !item || typeof item.uri !== 'string' || !/^areal-mcp-resource:\/\/[0-9a-f-]{36}$/.test(item.uri)
        || typeof item.name !== 'string')) throw new Error('Invalid staged resources');
      if (directory) {
        if (!Number.isSafeInteger(result.summary?.fileCount) || result.summary.fileCount < 0
          || !Number.isSafeInteger(result.summary?.totalBytes) || result.summary.totalBytes < 0)
          throw new Error('Directory summary unavailable');
        const confirmation = await this.confirm({ type: 'question', buttons: ['取消', '添加目录'], defaultId: 0, cancelId: 0,
          title: '确认目录资源', message: `向 ${prepared.serverLabel} 添加目录`,
          detail: `${chosen.filePaths.map(item => path.basename(item)).join('\n')}\n${result.summary.fileCount} 个文件 · ${result.summary.totalBytes} 字节\n提交表单后，服务器才能读取这些文件的副本。` });
        this.guard(owner, current);
        if (confirmation.response !== 1) {
          await this.releaseAll(owner, result.resources); return { resources: [] };
        }
      }
      return { resources: result.resources.map(({ uri, name, mimeType, size }) => ({ uri, name,
        ...(typeof mimeType === 'string' ? { mimeType } : {}), ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}) })) };
    } catch (error) {
      if (result?.resources) await this.releaseAll(owner, result.resources).catch(() => {});
      if (/RESOURCE_UPLOAD_UNSUPPORTED/.test(String(error?.message))) throw new Error('RESOURCE_UPLOAD_UNSUPPORTED');
      throw new Error('资源选择未确认；请检查表单状态后再操作。');
    }
  }
  dispose() { this.disposed = true; this.pending.clear(); this.unsettled.clear(); }
  async releaseAll(owner, resources) {
    await Promise.all(resources.filter(item => typeof item?.uri === 'string').map(item =>
      this.backend.command('manage', { operation: 'mcpFormResourceRelease', ...owner, uri: item.uri })));
  }
}
module.exports = { McpFormResources };
