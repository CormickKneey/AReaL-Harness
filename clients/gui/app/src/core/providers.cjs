'use strict';
const { startupTrace } = require('./startup-timing.cjs');
const { readFile, appendFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { SubscriptionStore } = require('./subscription.cjs');
const { definitions, connectionMetadata, withDefaultModelCapabilities } = require('@areal/provider-config');
const { ModelConfiguration, protocolToCore, baseUrl: endpointBase, credentialValue } = require('./model-config.cjs');

function connection(baseUrl, protocol) {
  if (!['chatCompletions', 'responses'].includes(protocol)) throw new Error('请选择 Chat Completions 或 Responses');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的 Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是无认证信息、查询参数和片段的 HTTP(S) 地址');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses)$/, '');
  const base = url.toString().replace(/\/$/, '');
  return { baseUrl: base, endpoint: base + (protocol === 'responses' ? '/responses' : '/chat/completions') };
}

function validContextWindow(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2_000_000; }

function modelParameters(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型参数无效');
  const rules = { temperature: v => Number.isFinite(v) && v >= 0 && v <= 2, maxOutputTokens: v => Number.isSafeInteger(v) && v > 0,
    contextWindowTokens: validContextWindow,
    reasoningEffort: v => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v) };
  const result = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!Object.hasOwn(rules, name) || value !== null && !rules[name](value)) throw new Error('模型参数无效');
    if (value !== null) result[name] = value;
  }
  return result;
}

function modelCapabilities(raw) {
  if (raw === undefined) return undefined;
  const fields = ['tools', 'vision', 'reasoning', 'reasoningEffortOptions'];
  const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(field => !fields.includes(field))
    || ['tools', 'vision', 'reasoning'].some(field => typeof raw[field] !== 'boolean')
    || raw.reasoningEffortOptions !== undefined && (!Array.isArray(raw.reasoningEffortOptions)
      || raw.reasoningEffortOptions.some(value => !efforts.includes(value))
      || new Set(raw.reasoningEffortOptions).size !== raw.reasoningEffortOptions.length))
    throw new Error('模型能力配置无效');
  return { tools: raw.tools, vision: raw.vision, reasoning: raw.reasoning,
    ...(raw.reasoningEffortOptions !== undefined ? { reasoningEffortOptions: [...raw.reasoningEffortOptions] } : {}) };
}

const connectionFailures = [
  { causes: ['ENOTFOUND', 'EAI_AGAIN'], category: 'DNS', message: '域名解析失败：请检查 Base URL、DNS 和网络代理设置' },
  { causes: ['ECONNREFUSED'], category: 'REFUSED', message: '连接被拒绝：请检查 Base URL、服务端口及网络代理是否可用' },
  { causes: ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'], category: 'TLS', message: 'TLS 证书验证失败：请检查服务地址、系统信任证书和网络代理证书' },
  { causes: ['ETIMEDOUT', 'ABORT_ERR', 'AbortError', 'TimeoutError'], category: 'TIMEOUT', message: '连接超时或已取消：请检查网络和服务状态后重试' },
  { causes: ['proxy-unavailable'], category: 'PROXY', message: '网络代理不可用：请检查系统代理设置后重试' },
  { causes: ['no-redirect'], category: 'REDIRECT', message: '模型服务返回重定向：请将 Base URL 改为最终服务地址' },
];

function connectionError(error) {
  const reasons = [error?.code, error?.cause?.code, error?.type, error?.name];
  if (error?.message === 'ChatGPT proxy unavailable') reasons.push('proxy-unavailable');
  const failure = connectionFailures.find(({ causes }) => causes.some(code => reasons.includes(code)))
    ?? { category: 'UNAVAILABLE', message: '连接失败：请检查 Base URL、网络及服务是否可用' };
  return Object.assign(new Error(failure.message), { code: `PROVIDER_NETWORK_${failure.category}` });
}

/** Core-owned metadata, with desktop-only encrypted credentials and OAuth. */
class AppProviders {
  constructor(backend, encryption) { this.backend = backend; this.encryption = encryption; this.config = new ModelConfiguration(backend, encryption); this.openaiToken = null; this.pendingApplications = new Map(); this.projectApplications = new Map(); }
  async init() {
    await this.config.init();
    try { this.lastAcceptedModel = JSON.parse(await readFile(join(this.backend.home, 'model-selection.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // 与 Core 的本机连接令牌一样，权限为 0600 的能力文件仅由后台读取。
    // 保留端口与令牌，避免后台重启后失效仍在运行的 Core 中冻结的传输配置。
    try { this.transport = JSON.parse(await readFile(join(this.backend.home, 'subscription-transport.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.transport && (!/^[a-f0-9]{64}$/.test(this.transport.token) || !Number.isInteger(this.transport.port) || this.transport.port < 0 || this.transport.port > 65535)) throw new Error('本地订阅传输配置无效');
    if (!this.transport) {
      this.transport = { token: randomBytes(32).toString('hex'), port: 0 };
      await this.backend.save('subscription-transport.json', this.transport);
    }
    this.openaiToken = this.transport.token;
  }
  get value() { return this.config.value ?? { data: [] }; }
  async network() {
    if (!this.networkPromise) this.networkPromise = import('@areal/chatgpt-provider/network').then(({ subscriptionNetwork }) => subscriptionNetwork(this.backend.hooks.environment()));
    return this.networkPromise;
  }
  async openai() {
    if (!this.openaiPromise) this.openaiPromise = import('@areal/chatgpt-provider/core').then(({ CoreSubscription }) => {
      this.openaiStore = new SubscriptionStore(this.backend, this.encryption);
      const onRequest = process.env.AREAL_CORE_PROVIDER_AUDIT === '1' ? async ({ providerId, protocol, model, startedAt, completedAt, upstreamHttpStatus, upstreamContentType, localHttpStatus, outcome, failureKind, streamFailureReason, code, state, phase, httpStatus, requestId, adjustments }) => {
        await appendFile(join(this.backend.home, 'provider-requests.jsonl'), JSON.stringify({ providerId, protocol, model, startedAt, completedAt,
          upstreamHttpStatus, upstreamContentType, localHttpStatus, outcome, failureKind, streamFailureReason, code, state, phase, httpStatus, requestId, adjustments }) + '\n', { mode: 0o600 });
      } : undefined;
      const service = new CoreSubscription({ store: this.openaiStore, fetch: async (...args) => (await this.network()).fetch(...args), token: this.openaiToken, port: this.transport.port, onListen: async port => { this.transport.port = port; await this.backend.save('subscription-transport.json', this.transport); }, kind: 'openai', onRequest });
      service.account.activateAuthorized = async (id, activate) => {
        if (this.backend.hasWork() || this.backend.activeCommands || this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.starting.size) return false;
        this.backend.providerUpdating = true;
        try {
          for (const project of this.backend.projects.values()) {
            if (project.service && !project.client?.ready) return false;
            if (project.client?.ready && !(await project.client.request('areal/server/status')).restartSafe) return false;
          }
          await activate();
          return true;
        } finally { this.backend.providerUpdating = false; }
      };
      return service;
    }).catch(error => { this.openaiPromise = null; throw error; });
    return this.openaiPromise;
  }
  async prepare() {
    const trace = startupTrace('providers.prepare');
    trace.advance('subscription_config');
    try {
      try { const saved = JSON.parse(await readFile(join(this.backend.home, 'openai-subscription.json'), 'utf8')); if (!saved.secret) { trace.finish('skipped'); return; } }
      catch (error) { if (error.code === 'ENOENT') { trace.finish('skipped'); return; } throw error; }
      trace.advance('local_ready');
      const service = await this.openai();
      await service.ready();
      this.prepareSubscriptionStatus(service);
      trace.finish('ok');
    } catch (error) { trace.finish('error', error); throw error; }
  }
  prepareSubscriptionStatus(service) {
    const account = service.account, revision = account.revision, lifetime = account.lifetime;
    if (lifetime.signal.aborted) return;
    const prepared = this.preparedSubscriptionStatus;
    if (prepared?.service === service && prepared.revision === revision && prepared.lifetime === lifetime) return prepared;
    const trace = startupTrace('providers.subscription_prefetch');
    trace.advance('account_status');
    const outcome = Promise.resolve().then(() => account.status()).then(status => {
      trace.finish(status.modelError || !['ready', 'signed_out'].includes(status.state) ? 'degraded' : 'ok');
      return { ok: true, status, completedAt: Date.now(), failure: account.failure, refreshing: account.refreshing };
    }, error => {
      trace.finish('error', error);
      return { ok: false, error, completedAt: Date.now(), failure: account.failure, refreshing: account.refreshing };
    });
    return this.preparedSubscriptionStatus = { service, revision, lifetime, outcome: account.track(outcome) };
  }
  async subscriptionStatus(service, trace) {
    const account = service.account, revision = account.revision, lifetime = account.lifetime;
    const current = () => account.revision === revision && account.lifetime === lifetime && !lifetime.signal.aborted;
    const prepared = this.preparedSubscriptionStatus;
    if (prepared?.service === service && prepared.revision === revision && prepared.lifetime === lifetime) {
      const outcome = await prepared.outcome;
      if (!current()) return null;
      const metadata = service.catalog?.metadata();
      const fresh = outcome.status?.state === 'ready'
        ? metadata?.fresh && metadata.sessionRevision === revision && outcome.status.models === service.models
        : Date.now() - outcome.completedAt < 30_000;
      const coherent = !outcome.ok || !account.refreshing && outcome.status.state !== 'refreshing'
        && isDeepStrictEqual(outcome.status.diagnostic, account.failure?.diagnostic() ?? null);
      if (fresh && coherent && outcome.failure === account.failure && outcome.refreshing === account.refreshing) {
        trace.advance('status_reuse');
        if (!outcome.ok) throw outcome.error;
        return outcome.status;
      }
    }
    if (!current()) return null;
    trace.advance('account_status');
    if (this.preparedSubscriptionStatus === prepared) this.preparedSubscriptionStatus = null;
    const replacement = this.prepareSubscriptionStatus(service);
    const outcome = await replacement.outcome;
    if (!current()) return null;
    if (!outcome.ok) throw outcome.error;
    return outcome.status;
  }
  async chatgpt(request) {
    if ((request.provider ?? 'openai') !== 'openai') throw new Error('不支持的账号类型');
    const service = await this.openai();
    const op = request.operation;
    // Initial authorization neither restarts Core nor replaces an existing grant.
    // Unrelated tasks, terminals and unresolved resources must not block it.
    if (op === 'login') {
      this.openaiStore.check();
      if (!request.newAccount && !request.accountId && await service.account.read()) throw new Error('请先退出当前 ChatGPT 账号');
      if ((request.newAccount || request.accountId) && (this.backend.hasWork() || this.backend.activeCommands || this.backend.starting.size)) throw new Error('请等待任务和操作完成后再切换 ChatGPT 账号');
      const login = await service.account.begin({ newAccount: request.newAccount === true, accountId: request.accountId });
      const completion = service.account.attempt?.done;
      if (completion && this.loginAttempt !== completion) {
        this.loginAttempt = completion;
        // Authorization outlives the settings page. Publish its catalog even
        // when the renderer has stopped polling; account.close waits for this work.
        service.account.track(completion.then(async () => {
          if (service.account.lifetime.signal.aborted || !(await service.account.read())) return;
          await this.chatgpt({ operation: 'status' });
        }).catch(() => {
          // The status action remains the explicit retry and error-reporting path.
          console.warn('ChatGPT 模型同步失败，请在模型设置中刷新。');
        }));
      }
      return login;
    }
    if (op === 'forget') await service.account.forget();
    else if (op === 'logout' || op === 'selectAccount') {
      if (this.backend.hasWork() || this.backend.activeCommands || this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.starting.size) throw new Error('请等待任务与操作完成后再切换 ChatGPT 账号');
      this.backend.providerUpdating = true;
      try {
        for (const project of this.backend.projects.values()) {
          if (project.service && !project.client?.ready) throw new Error('请先重新连接项目，再切换 ChatGPT 账号');
          if (project.client?.ready && !(await project.client.request('areal/server/status')).restartSafe) throw new Error('请先停止正在运行的任务或终端，再切换 ChatGPT 账号');
        }
        if (op === 'selectAccount') await service.account.selectAccount(request.accountId);
        else await service.account.logout();
      } finally { this.backend.providerUpdating = false; }
    } else if (op === 'cancel') await service.account.cancel();
    else if (op === 'probe') return service.probe(request.model);
    else if (op !== 'status') throw new Error('不支持的 ChatGPT 操作');
    const status = await service.account.status();
    await service.ready();
    // OAuth completion does not restart Core or alter existing task selections.
    for (const project of this.backend.projects.values()) {
      if (!project.client?.ready) continue;
      await this.syncSubscription(project, service);
      project.models = (await project.client.request('areal/model/list')).data ?? [];
    }
    this.backend.onChange();
    return { ...status, billing: 'subscription', catalog: service.catalog?.metadata() ?? null };
  }
  syncSubscription(project, service, correlation = { projectId: project.id, connectionGeneration: project.connectionGeneration, coreGeneration: project.service?.generation }) {
    const queueTrace = startupTrace('providers.subscription_queue', correlation);
    queueTrace.advance('queue_wait');
    const task = (this.subscriptionSync ?? Promise.resolve()).catch(() => {}).then(() => {
      queueTrace.finish('ok');
      return this.applySubscription(project, service, correlation);
    });
    this.subscriptionSync = task; return task;
  }
  async applySubscription(project, service, correlation) {
    const trace = startupTrace('providers.subscription', correlation);
    const account = service?.account, revision = account?.revision, lifetime = account?.lifetime;
    const current = () => !account || account.revision === revision && account.lifetime === lifetime && !lifetime?.signal.aborted;
    const prepared = this.preparedSubscriptionStatus;
    trace.advance(prepared?.service === service ? 'consume_wait' : 'account_status');
    try {
      if (!current()) { trace.finish('degraded'); return; }
      const status = service ? await this.subscriptionStatus(service, trace) : { authenticated: false };
      if (!current()) { trace.finish('degraded'); return; }
      trace.advance('provider_read', status.modelError ? 'degraded' : service ? 'ok' : 'skipped');
      const existing = (await project.client.request('areal/provider/list')).data.find(p => p.id === (service?.id ?? 'areal_openai'));
      if (!current()) { trace.finish('degraded'); return; }
      if (status.modelError || status.state && !['ready', 'signed_out'].includes(status.state)) { trace.finish('degraded'); return; }
      if (!status.authenticated || status.models?.length === 0) {
        trace.advance('provider_remove');
        if (existing) await this.backend.submit(project, 'areal/provider/remove', { id: existing.id, expectedRevision: existing.revision });
        trace.finish(existing ? 'ok' : 'skipped');
        return;
      }
      trace.advance('local_ready');
      await service.ready();
      if (!current()) { trace.finish('degraded'); return; }
      const models = status.models ?? service.models;
      const contexts = Object.fromEntries(models.filter(m => validContextWindow(m.parameters?.contextWindowTokens)).map(m => [m.id, { contextWindowTokens: m.parameters.contextWindowTokens }]));
      const desired = { id: service.id ?? 'areal_openai', contextSource: 'account', protocol: 'responses', endpoint: service.endpoint, credentialRef: service.id ?? 'areal_openai', models: models.map(m => m.id),
        ...(Object.keys(contexts).length ? { modelParameters: contexts } : {}), parameters: {} };
      trace.advance('provider_upsert');
      if (!existing || !isDeepStrictEqual(existing.modelParameters ?? {}, contexts) || Object.entries(desired).some(([k,v]) => k !== 'modelParameters' && JSON.stringify(existing[k]) !== JSON.stringify(v)))
        await this.backend.submit(project, 'areal/provider/upsert', { provider: { ...desired, revision: existing?.revision ?? 0 }, expectedRevision: existing?.revision ?? 0 });
      trace.finish('ok');
    } catch (error) { trace.finish('error', error); throw error; }
  }
  async refreshGoalTransport(project, threadId) {
    const { configuration } = await this.backend.refreshConfiguration(project, threadId);
    if (configuration.model?.providerId !== 'areal_openai') return;
    const unavailable = () => new Error('当前 ChatGPT 模型不可用，请在模型设置中刷新登录状态或选择其他模型');
    if (!this.openaiPromise) throw unavailable();
    const service = await this.openaiPromise;
    await this.syncSubscription(project, service);
    const current = (await project.client.request('areal/provider/list')).data.find(p => p.id === 'areal_openai');
    if (!current || current.endpoint !== service.endpoint || !current.models.includes(configuration.model.modelId)) throw unavailable();
    if (configuration.provider?.endpoint === current.endpoint) return;
    // 订阅转发端口随后台重启变化；显式启动目标前通过 Core 重绑定，历史 Turn 与队列快照不改写。
    // 保留用户参数，并用读取到的版本防止覆盖并发模型编辑；失败不得继续创建/恢复目标。
    await this.backend.configureThread(project, threadId, {
      expectedRevision: configuration.revision, model: configuration.model, parameters: configuration.parameters,
    });
  }
  async close() {
    this.closed = true;
    clearTimeout(this.reconciliationTimer);
    await this.reconciliation;
    this.preparedSubscriptionStatus = null;
    try { if (this.openaiPromise) await (await this.openaiPromise).close(); }
    finally { if (this.networkPromise) (await this.networkPromise).close(); }
  }
  public() {
    const value = this.config.public();
    const projects = value.projects.map(item => ({ ...item, application: this.applicationState(this.backend.projects.get(item.projectId), value.revision) }));
    const states = projects.map(item => item.application);
    const application = ['unknown', 'failed', 'deferred'].map(kind => states.find(state => state.kind === kind)).find(Boolean)
      ?? { kind: states.some(state => state.kind === 'applied') ? 'applied' : 'saved', revision: value.revision };
    return { ...value, projects, application, definitions, data: value.data.map(item => ({ ...item, connection: connectionMetadata(item, value.credentialSources) })) };
  }
  applicationState(project, revision = this.value.revision) {
    if (!project?.service) return { kind: 'saved', revision };
    if (this.pendingApplications.has(project.id)) return { kind: 'unknown', revision };
    if (!project.client?.ready) return { kind: 'deferred', revision, reason: 'disconnected' };
    const failure = project.providerFailure;
    if (failure?.revision === revision && failure.serviceId === project.service.serviceId && failure.generation === project.service.generation)
      return { kind: 'failed', revision, message: failure.message };
    return project.providerRevision === revision && !project.providerError
      ? { kind: 'applied', revision } : { kind: 'deferred', revision, reason: 'busy' };
  }
  applicationFailed(target, revision, error) {
    if (!this.currentTarget(target)) return;
    if (error?.data?.reason === 'MODEL_CONFIGURATION_BUSY') {
      delete target.project.providerFailure;
      target.project.providerError = null;
      return;
    }
    const message = this.redact(error?.message ?? '模型配置暂未生效，请重试。');
    target.project.providerFailure = { revision, serviceId: target.serviceId, generation: target.generation, message };
    target.project.providerError = message;
  }
  requestReconciliation(delay = 0) {
    if (this.closed || this.backend.closing || this.reconciliationTimer || this.reconciliation) return;
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = null;
      this.reconciliation = (async () => {
        for (const project of this.backend.projects.values()) {
          if (this.closed || this.backend.closing) break;
          const state = this.applicationState(project);
          if (project.client?.ready && ['deferred', 'unknown'].includes(state.kind)) await this.reconcileProject(project);
        }
      })().catch(() => {}).finally(() => {
        this.reconciliation = null;
        this.backend.onChange();
        if ([...this.backend.projects.values()].some(project => project.client?.ready && ['deferred', 'unknown'].includes(this.applicationState(project).kind))) this.requestReconciliation(2000);
      });
    }, delay);
    this.reconciliationTimer.unref?.();
  }
  model(ref, project) { return (project?.providerSnapshot ?? this.value).data.find(p => p.id === ref?.providerId)?.models.find(m => m.id === ref.modelId); }
  acceptModelSelection(selection) {
    if (!selection || !Number.isSafeInteger(selection.acceptedAt)) return Promise.resolve();
    // Core receipts/catalogs are authoritative. Serialize cross-project updates
    // and compare after the preceding save; late responses cannot regress it.
    const update = (this.modelSelectionUpdate ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (selection.acceptedAt <= (this.lastAcceptedModel?.acceptedAt ?? 0)) return;
      await this.backend.save('model-selection.json', selection);
      this.lastAcceptedModel = selection;
      this.backend.onChange();
    });
    this.modelSelectionUpdate = update;
    return update;
  }
  catalog(models, project) { return models.map(m => ({ ...m, displayName: this.model(m, project)?.displayName || m.displayName || m.modelId })); }
  key(item) { return this.config.key(item); }
  environment() { return { ...this.config.environment(), AREAL_CREDENTIAL_areal_openai: this.openaiToken }; }
  redact(message) {
    let value = this.openaiToken ? String(message).split(this.openaiToken).join('[redacted]') : String(message);
    for (const reference of Object.keys(this.config.vault.keys)) { const key = this.key({ apiKeyEnv: reference }); if (key) value = value.split(key).join('[redacted]'); }
    for (const item of this.value.data) { const key = this.key(item); if (key) value = value.split(key).join('[redacted]'); }
    return value;
  }
  async sync(project, correlation = { projectId: project.id, connectionGeneration: project.connectionGeneration, coreGeneration: project.service?.generation }) {
    // Retire the previous desktop catalog without importing its OAuth grant or changing task history.
    const retired = (await project.client.request('areal/provider/list')).data.find(p => p.id === 'areal_chatgpt');
    if (retired) await this.backend.submit(project, 'areal/provider/remove', { id: retired.id, expectedRevision: retired.revision });
    await this.syncSubscription(project, this.openaiPromise ? await this.openaiPromise : null, correlation);
    for (const id of this.config.legacy?.retired ?? []) {
      if (this.value.data.some(item => item.id === id)) continue;
      const existing = (await project.client.request('areal/provider/list')).data.find(item => item.id === id);
      if (existing) await this.backend.submit(project, 'areal/provider/remove', { id, expectedRevision: existing.revision });
    }
  }
  async command(request) {
    if (request.operation === 'list') {
      if (!this.saving && !this.backend.providerUpdating) {
        await this.config.current();
        for (const project of this.backend.projects.values()) if (project.client?.ready && this.pendingApplications.has(project.id)) await this.reconcilePending(this.target(project));
      }
      return this.public();
    }
    if (this.saving || this.backend.providerUpdating) throw new Error('模型配置正在保存，请稍后重试');
    if (request.operation === 'revealKey') {
      if (Object.keys(request).some(key => !['operation', 'id', 'expectedRevision'].includes(key))
        || ![request.id, request.expectedRevision].every(value => typeof value === 'string' && value.trim() && value.length <= 256)) throw new Error('无效的凭据查看请求');
      await this.config.current();
      if (request.expectedRevision !== this.value.revision) throw new Error('供应商配置已变化，请刷新后重新查看 API Key');
      const provider = this.value.data.find(item => item.id === request.id);
      if (!provider?.apiKeyEnv) throw new Error('尚未配置可用的 API Key');
      try {
        const apiKey = credentialValue(this.key(provider));
        if (!apiKey) throw new Error();
        return { apiKey };
      } catch { throw new Error('无法显示 API Key，请解锁系统安全存储后重试。'); }
    }
    if (request.operation === 'probe' || request.operation === 'discover') return this.test(request);
    if (['saveAndApply', 'removeAndApply', 'defaultAndApply'].includes(request.operation)) return this.saveAndApply(request);
    if (request.operation === 'apply') return this.apply(request);
    if (request.operation === 'save') return this.save(request);
    if (!['save', 'remove', 'default'].includes(request.operation)) throw new Error('不支持的供应商操作');
    return this.write(request);
  }
  async save(request) {
    let candidate;
    try {
      await this.write(request, next => { candidate = structuredClone(next); });
    } catch (error) {
      if (!candidate) throw error;
      const observed = await this.config.current().catch(() => null);
      if (!observed || observed.revision === request.expectedRevision || !isDeepStrictEqual(observed.data, candidate.data) || !isDeepStrictEqual(observed.defaultModel, candidate.defaultModel)) throw error;
    }
    this.requestReconciliation();
    return this.public();
  }
  async write(request, prepared) {
    this.saving = true;
    try {
      const current = await this.config.current();
      if (request.expectedRevision !== current.revision) throw new Error('供应商配置已变化，请刷新后重新保存');
      const next = structuredClone(current);
      if (request.operation === 'default') next.defaultModel = request.model ?? null;
      else if (request.operation === 'remove') {
        if (!next.data.some(p => p.id === request.id)) throw new Error('供应商已不存在');
        next.data = next.data.filter(p => p.id !== request.id);
        if (next.defaultModel?.providerId === request.id) next.defaultModel = null;
      } else {
        const raw = request.provider;
        if (!raw || typeof raw.name !== 'string') throw new Error('请输入供应商名称');
        const previous = raw.id ? next.data.find(p => p.id === raw.id) : null;
        if (raw.id && !previous) throw new Error('供应商已不存在，请刷新');
        if (request.authentication !== undefined && !['none', 'apiKey'].includes(request.authentication)) throw new Error('不支持的认证方式');
        const protocol = protocolToCore(raw.protocol);
        // Name/model-only edits preserve an exact endpoint supplied by the CLI.
        const endpoint = previous && raw.baseUrl === endpointBase(previous.endpoint) && protocol === previous.protocol
          ? previous.endpoint : connection(raw.baseUrl, raw.protocol).endpoint;
        if (!Array.isArray(raw.models)) throw new Error('请填写模型列表');
        const models = raw.models.map(m => ({ id: m.id?.trim(), enabled: m.enabled !== false, ...(m.displayName?.trim() ? { displayName: m.displayName.trim() } : {}), parameters: modelParameters(m.parameters), ...(m.capabilities !== undefined ? { capabilities: modelCapabilities(m.capabilities) } : {}) }));
        const item = { id: previous?.id ?? `app_${randomUUID().replaceAll('-', '')}`, name: raw.name.trim(), endpoint, protocol, models, parameters: modelParameters(raw.parameters), enabled: raw.enabled !== false,
          ...(previous?.apiKeyEnv ? { apiKeyEnv: previous.apiKeyEnv } : {}) };
        if (request.authentication === 'none') delete item.apiKeyEnv;
        else if (request.apiKey !== undefined) {
          const reference = await this.config.credential(request.apiKey);
          if (reference) item.apiKeyEnv = reference;
          else if (request.authentication !== 'apiKey') delete item.apiKeyEnv;
        }
        if (request.authentication === 'apiKey' && !item.apiKeyEnv) throw new Error('请填写 API Key，或保留已配置的凭据环境变量。');
        if (request.discoverModels && !previous && item.enabled && item.models.length === 0) {
          const catalog = await this.testConnection(item, { operation: 'discover' });
          if (!catalog.models.length) throw new Error('服务未提供模型，请手动添加后保存。');
          item.models = [...new Set(catalog.models)].map(id => withDefaultModelCapabilities({ id, enabled: true, parameters: !item.parameters.contextWindowTokens && Object.hasOwn(catalog.modelParameters ?? {}, id) ? catalog.modelParameters[id] : {} }, item.parameters));
        }
        next.data = previous ? next.data.map(p => p.id === item.id ? item : p) : [...next.data, item];
      }
      prepared?.(next);
      this.config.value = await this.config.execute('write', { expectedRevision: current.revision, data: next.data, defaultModel: next.defaultModel });
      this.backend.onChange();
      return this.public();
    } finally { this.saving = false; }
  }
  target(project) {
    return { project, client: project.client, serviceId: project.service?.serviceId, generation: project.service?.generation };
  }
  async inProject(project, action) {
    const task = (this.projectApplications.get(project.id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.projectApplications.set(project.id, task);
    try { return await task; }
    finally { if (this.projectApplications.get(project.id) === task) this.projectApplications.delete(project.id); }
  }
  currentTarget({ project, client, serviceId, generation }) {
    return client?.ready && project.client === client && project.service?.serviceId === serviceId && project.service?.generation === generation;
  }
  requireTarget(target) {
    if (!this.currentTarget(target)) throw new Error('Core 连接已变化，模型配置应用尚未确认，请等待重新连接。');
  }
  validateProof(target, proof) {
    this.requireTarget(target);
    if (proof?.serviceId !== target.serviceId || proof?.generation !== target.generation || typeof proof.applied?.revision !== 'string' || !Number.isSafeInteger(proof.applied.sequence) || proof.applied.sequence < 0 || typeof proof.modelRevision !== 'string' || !proof.credentialStates || typeof proof.credentialStates !== 'object') throw new Error('Core 模型配置应用证明无效，请刷新核对。');
    return proof;
  }
  async readProof(target, requestId) {
    const proof = await target.client.request('areal/server/modelConfiguration/read', { expectedGeneration: target.generation, ...(requestId ? { requestId } : {}) });
    return this.validateProof(target, proof);
  }
  rememberProof(target, proof, snapshot) {
    this.validateProof(target, proof);
    const project = target.project;
    project.providerRevision = proof.applied.revision;
    project.providerProof = proof;
    if (snapshot?.revision === proof.applied.revision) project.providerSnapshot = snapshot;
    else if (project.providerSnapshot?.revision !== proof.applied.revision) delete project.providerSnapshot;
  }
  async confirmProof(target, proof, snapshot, { refreshModels = true } = {}) {
    this.validateProof(target, proof);
    if (proof.applied.revision !== snapshot.revision) throw new Error('Core 尚未确认目标模型配置，请刷新核对。');
    this.rememberProof(target, proof, snapshot);
    if (snapshot.data.some(item => item.enabled !== false && Object.hasOwn(this.config.vault.keys, item.apiKeyEnv) && proof.credentialStates[item.id] !== 'available')) throw Object.assign(new Error('Core 尚未确认模型凭据可用，请检查凭据后重试。'), { configurationSettled: true });
    if (refreshModels) {
      const models = await target.client.request('areal/model/list');
      this.requireTarget(target);
      this.rememberProof(target, proof, snapshot);
      target.project.models = models.data ?? models.models ?? [];
    }
    target.project.providerError = null;
    delete target.project.providerFailure;
  }
  reconcilePending(target) { return this.inProject(target.project, () => this.inspectPending(target)); }
  async inspectPending(target, notAccepted, { refreshModels = true } = {}) {
    const pending = this.pendingApplications.get(target.project.id);
    if (!pending) return;
    try {
      const sameService = pending.serviceId === target.serviceId && pending.generation === target.generation;
      const observed = await this.readProof(target, sameService ? pending.requestId : undefined);
      if (!sameService) {
        this.rememberProof(target, observed, this.value);
        if (observed.applied.revision === pending.snapshot.revision) await this.confirmProof(target, observed, pending.snapshot, { refreshModels });
        else target.project.providerError = 'Core 已换代，当前模型配置与原应用目标不同，请刷新后重新应用。';
        this.pendingApplications.delete(target.project.id);
        return { generationChanged: true };
      }
      const operation = observed.operation;
      if (operation?.requestId !== pending.requestId) throw new Error('原模型配置操作尚未确认，请等待后刷新。');
      if (operation.state === 'applied') {
        const result = this.validateProof(target, operation.result);
        if (result.applied.revision !== pending.targetRevision || result.applied.sequence <= pending.expectedApplied.sequence) throw new Error('Core 返回了不匹配的模型配置回执，请刷新核对。');
        if (observed.applied.revision !== result.applied.revision || observed.applied.sequence !== result.applied.sequence) throw new Error('Core 模型配置已再次变化，请刷新核对。');
        await this.confirmProof(target, result, pending.snapshot, { refreshModels });
        this.pendingApplications.delete(target.project.id);
      } else if (operation.state === 'rejected' || operation.state === 'unknown' && !operation.error && notAccepted) {
        this.rememberProof(target, observed, this.value);
        this.pendingApplications.delete(target.project.id);
        const error = operation.error ?? notAccepted;
        target.project.providerError = this.redact(error?.message ?? 'Core 已拒绝模型配置应用。');
        this.applicationFailed(target, pending.targetRevision, error);
        return { rejected: true, error };
      } else throw new Error('模型配置应用仍待确认，请等待后刷新；不会重复提交或回滚。');
    } catch (error) {
      if (this.currentTarget(target)) target.project.providerError = this.redact(error.message);
      if (error.configurationSettled) {
        this.pendingApplications.delete(target.project.id);
        this.applicationFailed(target, pending.targetRevision, error);
        return { rejected: true, error };
      }
      return { pending: true, error };
    }
  }
  async prepareProjects(projects = this.backend.projects.values()) {
    const targets = [];
    for (const project of projects) {
      if (project.service && !project.client?.ready) throw new Error('项目尚未连接，重新连接后再保存。');
      if (!project.client?.ready) continue;
      const target = this.target(project);
      await this.inProject(project, async () => {
        this.requireTarget(target);
        if (!['areal/server/modelConfiguration/read', 'areal/server/modelConfiguration/apply'].every(method => target.client.capabilities?.methods?.includes(method))) {
          project.providerError = '请更新 Core 后再应用模型配置。';
          throw new Error(project.providerError);
        }
        const reconciled = await this.inspectPending(target);
        if (reconciled?.pending) throw reconciled.error;
        target.proof = await this.readProof(target);
        this.rememberProof(target, target.proof, this.value);
        const status = await target.client.request('areal/server/status');
        this.requireTarget(target);
        if (!status.restartSafe) throw new Error('任务或终端正在运行，完成后再保存；修改仍保留。');
      });
      targets.push(target);
    }
    return targets;
  }
  async applyProjects(snapshot, targets) {
    const outcomes = [];
    for (const target of targets ?? await this.prepareProjects()) outcomes.push(await this.inProject(target.project, () => this.applyProject(snapshot, target)));
    return outcomes;
  }
  async applyProject(snapshot, target, { refreshModels = true } = {}) {
    try {
      this.requireTarget(target);
      if (target.proof.applied.revision === snapshot.revision) {
        await this.confirmProof(target, target.proof, snapshot, { refreshModels });
        return { target, applied: true };
      }
      const credentials = this.config.credentialsFor(snapshot);
      const pending = { requestId: randomUUID(), serviceId: target.serviceId, generation: target.generation, expectedApplied: target.proof.applied, targetRevision: snapshot.revision, snapshot };
      this.pendingApplications.set(target.project.id, pending);
      try {
        const receipt = this.validateProof(target, await target.client.request('areal/server/modelConfiguration/apply', {
          requestId: pending.requestId, expectedGeneration: pending.generation, expectedApplied: pending.expectedApplied,
          targetRevision: snapshot.revision, credentials,
        }));
        if (receipt.operation?.requestId !== pending.requestId || receipt.operation.state !== 'applied') throw new Error('模型配置应用尚未确认，请刷新核对。');
        const result = this.validateProof(target, receipt.operation.result);
        if (result.applied.revision !== snapshot.revision || result.applied.sequence <= pending.expectedApplied.sequence || !isDeepStrictEqual(result.applied, receipt.applied)) throw new Error('Core 返回了不匹配的模型配置回执，请刷新核对。');
        await this.confirmProof(target, result, snapshot, { refreshModels });
        this.pendingApplications.delete(target.project.id);
        return { target, applied: true };
      } catch (error) {
        const notAccepted = error.name === 'CoreRpcError' && error.submissionUnknown !== true && ([-32602, -32601, -32003].includes(error.code)
          || error.code === -32010 && error.data?.reason === 'MODEL_CONFIGURATION_CAPACITY');
        const reconciled = await this.inspectPending(target, notAccepted ? error : undefined, { refreshModels });
        return { target, applied: !this.pendingApplications.has(target.project.id) && !reconciled?.rejected && this.currentTarget(target), pending: reconciled?.pending === true, error: reconciled?.error ?? error };
      }
    } catch (error) {
      if (this.currentTarget(target)) target.project.providerError = this.redact(error.message);
      return { target, pending: this.pendingApplications.has(target.project.id) || !this.currentTarget(target), error };
    }
  }
  reconcileProject(project, { refreshModels = true } = {}) {
    const target = this.target(project);
    return this.inProject(project, async () => {
      try {
        if (this.closed || this.backend.closing) return;
        this.requireTarget(target);
        if (!['areal/server/modelConfiguration/read', 'areal/server/modelConfiguration/apply'].every(method => target.client.capabilities?.methods?.includes(method))) throw new Error('请更新 Core 后再应用模型配置。');
        const reconciled = await this.inspectPending(target, undefined, { refreshModels });
        if (reconciled?.pending) return;
        const snapshot = await this.config.current();
        this.requireTarget(target);
        if (this.applicationState(project, snapshot.revision).kind === 'failed') return;
        target.proof = await this.readProof(target);
        this.rememberProof(target, target.proof, snapshot);
        if (target.proof.applied.revision === snapshot.revision) {
          await this.confirmProof(target, target.proof, snapshot, { refreshModels });
          return;
        }
        if (this.saving || this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.activeCommands || this.backend.starting.size || this.backend.hasWork()) {
          project.providerError = null;
          return;
        }
        const status = await target.client.request('areal/server/status');
        this.requireTarget(target);
        if (!status.restartSafe || this.saving || this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.activeCommands || this.backend.starting.size || this.backend.hasWork()) {
          project.providerError = null;
          return;
        }
        this.backend.providerUpdating = true;
        try {
          if (this.closed || this.backend.closing) return;
          const outcome = await this.applyProject(snapshot, target, { refreshModels });
          if (!outcome.applied && !outcome.pending) this.applicationFailed(target, snapshot.revision, outcome.error);
        } finally { this.backend.providerUpdating = false; }
      } catch (error) {
        this.applicationFailed(target, this.value.revision, error);
      } finally {
        this.backend.onChange();
        if (project.client?.ready && ['deferred', 'unknown'].includes(this.applicationState(project).kind)) this.requestReconciliation(2000);
      }
    });
  }
  async saveAndApply(request) {
    if (this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.activeCommands || this.backend.starting.size || this.backend.hasWork()) throw new Error('任务或操作正在进行，完成后再保存；修改仍保留。');
    this.backend.providerUpdating = true;
    let previous, written, candidate, targets = [], outcomes = [];
    try {
      previous = await this.config.current();
      if (request.expectedRevision !== previous.revision) throw new Error('配置已变化，请刷新后重试。');
      targets = await this.prepareProjects();
      written = await this.write({ ...request, operation: request.operation === 'removeAndApply' ? 'remove' : request.operation === 'defaultAndApply' ? 'default' : 'save', discoverModels: true }, next => { candidate = structuredClone(next); });
      outcomes = await this.applyProjects(this.value, targets);
      if (outcomes.some(outcome => !outcome.applied)) throw new Error('项目模型配置应用未全部确认。');
      if ((await this.config.current()).revision !== written.revision) throw new Error('模型配置已被外部修改，请刷新核对。');
      const result = this.public();
      if (result.pendingApply) throw new Error('Core 尚未确认配置。');
      return result;
    } catch (error) {
      let rollbackError = null, restored = false;
      if (!written && candidate) {
        try {
          const observed = await this.config.current();
          if (observed.revision !== previous.revision && isDeepStrictEqual(observed.data, candidate.data) && isDeepStrictEqual(observed.defaultModel, candidate.defaultModel)) written = observed;
        } catch (failure) { rollbackError = failure; }
      }
      if (written && !outcomes.some(outcome => outcome.pending) && !targets.some(target => this.pendingApplications.has(target.project.id))) {
        try {
          const rollback = await this.config.execute('write', { expectedRevision: written.revision, data: previous.data, defaultModel: previous.defaultModel });
          this.config.value = rollback;
          const compensation = await this.applyProjects(rollback);
          if (compensation.some(outcome => !outcome.applied) || (await this.config.current()).revision !== rollback.revision) throw new Error('原模型配置应用未全部确认');
          restored = true;
        } catch (failure) { rollbackError = failure; }
      }
      throw new Error(`${this.redact(error.message)}${rollbackError ? ' 回滚未确认，请刷新核对配置。' : restored ? ' 已恢复原配置，修改仍保留。' : written ? ' 配置应用仍待确认，请刷新核对；修改仍保留。' : ''}`);
    } finally { this.backend.providerUpdating = false; this.backend.onChange(); }
  }
  async apply(request) {
    if (this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.activeCommands || this.backend.starting.size || this.backend.hasWork()) throw new Error('请等待任务和操作完成，并处理排队消息后再应用模型配置');
    this.backend.providerUpdating = true;
    try {
      const current = await this.config.current();
      if (request.expectedRevision !== current.revision) throw new Error('供应商配置已变化，请刷新后重新应用');
      const outcomes = await this.applyProjects(current);
      if (outcomes.some(outcome => !outcome.applied)) throw new Error('模型配置应用未全部确认，请等待后刷新核对。');
      if ((await this.config.current()).revision !== current.revision) throw new Error('模型配置已被外部修改，请刷新核对。');
      this.backend.onChange();
      return this.public();
    } finally { this.backend.providerUpdating = false; }
  }
  async test({ id, model, operation, connection: draft }) {
    if (operation === 'discover' && draft !== undefined) {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('连接配置无效');
      const endpoint = connection(draft.baseUrl, draft.protocol).endpoint;
      const credential = draft.credential;
      let apiKey;
      if (credential?.kind === 'none') apiKey = '';
      else if (credential?.kind === 'draft') apiKey = credentialValue(credential.value);
      else if (credential?.kind === 'saved') {
        await this.config.current();
        if (credential.expectedRevision !== this.value.revision) throw new Error('供应商配置已变化，请刷新后重新获取模型');
        const provider = this.value.data.find(item => item.id === credential.providerId);
        if (!provider) throw new Error('供应商已不存在，请刷新');
        apiKey = this.key(provider);
      } else throw new Error('认证方式无效');
      if (credential.kind !== 'none' && !apiKey) throw new Error('请填写 API Key，或使用已保存的凭据');
      return this.testConnection({ endpoint, protocol: protocolToCore(draft.protocol) }, { operation, apiKey });
    }
    await this.config.current();
    const provider = this.value.data.find(p => p.id === id);
    if (!provider) throw new Error('请先保存供应商');
    return this.testConnection(provider, { model, operation });
  }
  async testConnection(provider, { model, operation, apiKey }) {
    const key = apiKey ?? this.key(provider);
    const url = operation === 'discover' ? `${endpointBase(provider.endpoint)}/models` : provider.endpoint;
    if (operation === 'probe' && !provider.models.some(m => m.id === model && m.enabled)) throw new Error('请选择已启用的模型');
    const body = provider.protocol === 'responses' ? { model, input: [{ role: 'user', content: 'Reply with OK.' }], store: false, stream: true } : { model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true };
    let response;
    try {
      response = await (await this.network()).fetch(url, { method: operation === 'discover' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, ...(operation === 'probe' ? { body: JSON.stringify(body) } : {}) });
    } catch (error) { throw connectionError(error); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(response.status === 401 || response.status === 403 ? '认证失败：请检查 API Key 及模型访问权限' : `模型服务返回 HTTP ${response.status}`); }
    if (operation === 'probe') {
      const { probeResponse } = await import('@areal/chatgpt-provider/core');
      try { return await probeResponse(response, provider.protocol === 'chat-completions' ? 'chatCompletions' : provider.protocol); }
      catch { throw new Error('模型服务未完成有效的流式文本回复，请检查模型和协议'); }
    }
    // Do not reflect upstream response text (which may contain the credential) into IPC.
    let bytes = 0, chunks = [];
    try {
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('模型服务响应过大'); chunks.push(chunk); }
    } catch { throw new Error('模型列表读取失败，请重试或手动添加模型'); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('模型服务未返回有效的 JSON 响应'); }
    if (operation === 'discover') {
      if (!Array.isArray(data.data)) throw new Error('服务未返回模型列表，请手动添加模型');
      const models = [...new Map(data.data.filter(p => typeof p?.id === 'string' && p.id.trim() && p.id.length <= 256 && (!key || !p.id.includes(key))).map(p => [p.id.trim(), { ...p, id: p.id.trim() }])).values()].slice(0, 64);
      const parameters = Object.fromEntries(models.filter(p => validContextWindow(p.context_window)).map(p => [p.id, { contextWindowTokens: p.context_window }]));
      return { models: models.map(p => p.id), ...(Object.keys(parameters).length ? { modelParameters: parameters } : {}) };
    }
    throw new Error('不支持的供应商测试操作');
  }
}
module.exports = { AppProviders, connection };
