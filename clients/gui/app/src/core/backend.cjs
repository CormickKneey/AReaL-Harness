'use strict';
const diagnostics = require('./diagnostics.cjs');
const { commandSemantics, desktopError } = require('@areal/workbench/desktop-contract');
const { startupTrace } = require('./startup-timing.cjs');

const { connectService } = require('./local-service.cjs');
const { LifecycleOperations } = require('./lifecycle-operations.cjs');
const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { mkdir, readFile, writeFile, rename, realpath, rm } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const WebSocket = require('ws');
const { ScopedResources } = require('./scoped-resources.cjs');
const { AppHooks } = require('./hooks.cjs');
const { TrajectoryExport } = require('./trajectory.cjs');
const { UserFeedback } = require('./feedback.cjs');
const { AppProviders } = require('./providers.cjs');
const { UsageAnalytics } = require('./analytics.cjs');
const { CoreLibrary } = require('./library.cjs');
const { CoreNotifications, TaskNotificationMonitor } = require('./notifications.cjs');
const { manage, managementMethods, threadMutationMethods } = require('./management.cjs');
const { taskMutationMethods } = require('./tasks.cjs');
const { taskCatalog } = require('./task-catalog.cjs');
const { isTaskDraftConfiguration, manageTaskDraft, displayTaskDraftThread } = require('./task-draft.cjs');
const { mediaCommand, messageInput } = require('./media.cjs');
const { workspaceCommand } = require('./workspace.cjs');
const { CoreWorktrees } = require('./worktrees.cjs');
const { ProjectlessWorkspaces } = require('./projectless.cjs');
const { inspectCoreCapabilities, projectCoreCapabilities } = require('./core-capabilities.cjs');
const { definition: browserTool, failure: browserFailure } = require('./browser-tool.cjs');

const workgroupMutationMethods = new Set(['areal/workgroup/start', 'areal/workgroup/revise', 'areal/workflow/start']);
const isObservationSizeFailure = error => error?.code === 'RESPONSE_TOO_LARGE'
  && ['thread/read', 'areal/thread/observe'].includes(error.method) && error.submissionUnknown === false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const historyPageBytes = 256 * 1024, historyMaxBytes = 1024 * 1024;
const historyViewLimit = 8, historyPageLimit = 4, historyItemBytes = 128 * 1024 * 1024;
const historyReason = error => error?.reason ?? error?.data?.reason;
const historyFailure = message => Object.assign(new Error(message), { code: 'HISTORY_VIEW_UNAVAILABLE', outcome: { kind: 'noMutation' }, recovery: { kind: 'none' } });
function mergeHistory(thread, entries) {
  const turns = new Map();
  for (const entry of entries) {
    const turn = turns.get(entry.sourceTurnId) ?? { ...entry.turn, id: entry.sourceTurnId, status: entry.sourceTurnStatus, items: [] };
    if (!turn.items.some(item => item.id === entry.sourceItemId)) turn.items.push(entry.item);
    turns.set(turn.id, turn);
  }
  for (const current of thread.turns ?? []) {
    const older = turns.get(current.id);
    const currentIds = new Set((current.items ?? []).map(item => item.id));
    turns.set(current.id, older ? { ...older, ...current, items: [...older.items.filter(item => !currentIds.has(item.id)), ...current.items] } : current);
  }
  return { ...thread, turns: [...turns.values()] };
}
const reconciliationDelays = [500, 1000, 2000, 4000, 8000];
const creationTargets = new Map([['areal/thread/start', 'thread'], ['areal/thread/fork', 'thread'], ['areal/side/start', 'thread'], ['areal/task/create', 'task']]);
const processControls = new Set(['areal/process/write', 'areal/process/closeStdin', 'areal/process/resize', 'areal/process/terminate']);
const operationOf = (method, params) => ({ method, requestId: params.requestId,
  target: creationTargets.has(method) ? { kind: 'project' } : params.taskId ? { kind: 'task', taskId: params.taskId }
    : params.threadId ? { kind: 'thread', threadId: params.threadId } : { kind: 'project' } });
const explicitRejection = error => ['rejected', 'noMutation'].includes(error?.outcome?.kind);
const retryableRead = error => error?.recovery?.kind === 'retryRead'
  || !error?.recovery && ['TIMEOUT', 'DISCONNECTED', 'CONNECTION_LOST', 'RESPONSE_UNKNOWN'].includes(error?.code);
function matchingReceipt(entry, records, scopedThreadId) {
  const operation = entry.operation ?? operationOf(entry.method, entry.params);
  const receiptMethod = processControls.has(entry.method) ? 'areal/process/control' : entry.method;
  return records?.find(receipt => {
    const actual = receipt.operation;
    if ((actual?.requestId ?? receipt.requestId) !== operation.requestId || (actual?.method ?? receipt.method) !== receiptMethod
      || entry.digest && receipt.digest !== entry.digest) return false;
    const createdKind = creationTargets.get(entry.method);
    if (createdKind) {
      const id = createdKind === 'task' ? receipt.taskId ?? receipt.result?.id : receipt.threadId ?? receipt.result?.threadId ?? receipt.result?.thread?.id;
      return typeof id === 'string' && (!actual || actual.target?.kind === createdKind && actual.target[`${createdKind}Id`] === id);
    }
    if (actual) return isDeepStrictEqual(actual.target, operation.target);
    if (operation.target.kind === 'thread') return (receipt.threadId ?? scopedThreadId) === operation.target.threadId;
    if (operation.target.kind === 'task') return receipt.taskId === operation.target.taskId;
    return !receipt.threadId && !receipt.taskId;
  });
}
const receiptStatus = receipt => receipt.status ?? (receipt.response?.error ? 'failed'
  : receipt.result !== undefined || receipt.response?.result !== undefined ? 'completed' : 'admitted');
const receiptResult = receipt => receipt.result ?? receipt.response?.result;
// 精确 Remote 停止/交互不会重放；保留日志用于核对，不阻塞后续桌面操作。
const isRemoteControl = entry => entry.method === 'turn/interrupt' && entry.remote?.method === 'turn.stop'
  && entry.remote.capability === 'interrupt' && typeof entry.operationId === 'string'
  && typeof entry.params?.turnId === 'string' && entry.remote.target?.expectedTurnId === entry.params.turnId
  && typeof entry.params.threadId === 'string' && entry.remote.target.threadId === entry.params.threadId
  || entry.method === 'areal/interaction/respond' && entry.remote?.method === 'interaction.respond'
  && entry.remote.capability === 'answer' && typeof entry.operationId === 'string'
  && typeof entry.params?.requestId === 'string' && entry.remote.target?.interactionId === entry.params.requestId
  && typeof entry.params.turnId === 'string' && entry.remote.target.turnId === entry.params.turnId
  && typeof entry.params.threadId === 'string' && entry.remote.target.threadId === entry.params.threadId
  || entry.method === 'areal/channel/reply' && entry.remote?.method === 'task.question.reply'
  && entry.remote.capability === 'answer' && typeof entry.operationId === 'string' && entry.params?.requestId === entry.operationId
  && ['taskId', 'runId', 'questionId'].every(key => typeof entry.params[key] === 'string' && entry.remote.target?.[key] === entry.params[key])
  || entry.method === 'areal/task/pause' && entry.remote?.method === 'task.pause'
  && entry.remote.capability === 'pauseTask' && typeof entry.operationId === 'string' && entry.params?.requestId === entry.operationId
  && ['taskId', 'expectedRunId'].every(key => typeof entry.params[key] === 'string' && entry.remote.target?.[key] === entry.params[key])
  && Number.isSafeInteger(entry.params.expectedRevision) && entry.remote.target.expectedRevision === entry.params.expectedRevision;

/** 每个项目连接公开的共享 Core 服务；这里只保留可重建投影与客户端受理回执。 */
class CoreBackend {
  constructor({ binary, home, applicationOwner, harnessHome = join(home, 'harness'), config, desktopConfig, userHome, toolExtensions, workgroupPolicy, workgroupToolchain, sandboxProfile, desktopProcesses = false, defaultProfile, encryption, proxyEnvironment = {}, onChange = () => {} }) {
    if (!binary || !isAbsolute(binary)) throw new Error('请设置 AREAL_CORE_BIN 为 areal 可执行文件的绝对路径');
    this.binary = binary;
    this.applicationOwner = applicationOwner;
    this.ownedEngines = new Map();
    this.home = home;
    this.harnessHome = harnessHome;
    this.config = config;
    this.proxyEnvironment = proxyEnvironment;
    this.toolExtensions = toolExtensions;
    this.workgroupPolicy = workgroupPolicy;
    this.workgroupToolchain = workgroupToolchain;
    this.desktopProcesses = desktopProcesses;
    this.sandboxProfile = sandboxProfile;
    this.defaultProfile = defaultProfile;
    this.userHome = userHome;
    this.desktopConfig = desktopConfig;
    this.onChange = onChange;
    this.projects = new Map();
    this.starting = new Map();
    this.readWaiters = new WeakMap();
    this.saves = new Map();
    this.closing = false;
    this.library = new CoreLibrary(this);
    this.worktrees = new CoreWorktrees(this);
    this.projectless = new ProjectlessWorkspaces(this);
    this.notifications = new CoreNotifications(notice => this.onNotification?.(notice));
    this.analytics = new UsageAnalytics(this);
    this.resources = new ScopedResources(this);
    this.hooks = new AppHooks(this);
    this.trajectory = new TrajectoryExport(this);
    this.feedback = new UserFeedback(this);
    this.providers = new AppProviders(this, encryption);
    this.activeCommands = 0;
    this.awaitingResponses = new WeakSet();
    this.lifecycleOperations = new LifecycleOperations(this);
  }

  async init() {
    const trace = startupTrace('core.init');
    trace.advance('project_index');
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await this.lifecycleOperations.init();
      try {
        this.saved = JSON.parse(await readFile(join(this.home, 'projects.json'), 'utf8'));
        if (!Array.isArray(this.saved)) throw new Error('Invalid project index');
      } catch (error) { if (error.code !== 'ENOENT') throw error; this.saved = []; }
      trace.advance('library');
      await this.library.init();
      trace.advance('projectless');
      await this.projectless.init();
      trace.advance('analytics');
      await this.analytics.init();
      trace.advance('capabilities');
      await inspectCoreCapabilities(this.binary);
      trace.advance('providers');
      await this.providers.init();
      trace.advance('feedback');
      await this.feedback.init();
      trace.advance('resources');
      await this.resources.init();
      await this.lifecycleOperations.reconcileLoaded();
      trace.finish('ok');
    } catch (error) { trace.finish('error', error); throw error; }
  }

  save(name, value) {
    const contents = JSON.stringify(value);
    const task = (this.saves.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const path = join(this.home, name);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.saves.set(name, task);
    return task;
  }

  async addProject(path) {
    this.lifecycleOperations.assertRegistration();
    if (this.providerUpdating || this.resourcesUpdating) throw new Error('配置正在更新，请稍后打开项目');
    this.activeCommands++;
    try { return await this.addProjectPath(path); }
    finally { this.activeCommands--; }
  }

  async addProjectPath(path, worktreeResources, projectlessRequestId) {
    this.lifecycleOperations.assertRegistration();
    if (this.providerUpdating || this.resourcesUpdating) throw new Error('配置正在更新，请稍后打开项目');
    const root = await realpath(path);
    const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
    const registration = (this.projectWrites ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.saved.some(project => project.id === id)) return;
      const saved = [...this.saved, { id, root, ...(worktreeResources ? {worktreeResources} : {}), ...(projectlessRequestId ? { projectless: true, projectlessRequestId } : {}) }];
      await this.save('projects.json', saved);
      this.saved = saved;
    });
    this.projectWrites = registration.catch(() => {});
    await registration;
    if (this.library.value.projects[id]?.hidden) await this.library.command({ projectId: id, operation: 'hideProject', hidden: false });
    await this.start(id);
    return id;
  }

  snapshot() {
    return { library: this.library.value, projectless: this.projectless.snapshot(), power: this.power ?? null, projects: this.saved.map(project => {
      const live = this.projects.get(project.id);
      const snapshot = live?.model.getSnapshot() ?? null;
      // Management conversations remain hidden from chat navigation, but use the
      // same snapshot/message components through a decoded display projection.
      const state = snapshot?.threads ? {...snapshot, threads: Object.fromEntries(Object.entries(snapshot.threads).map(([id, thread]) =>
        [id, isTaskDraftConfiguration(live.configurations?.[id] ?? thread.desktop?.configuration)
          ? displayTaskDraftThread(thread, live) : thread]))} : snapshot;
      return { ...project, backend: 'areal', core: { ...projectCoreCapabilities(this.binary, live?.client?.capabilities),
        instanceId: live?.service?.serviceId ?? null, connectionGeneration: live?.connectionGeneration ?? 0 },
        state: state && live.resourceInitializing ? {...state, connected:false} : state,
        pending: (live?.pending ?? []).filter(entry => !isRemoteControl(entry)).map(entry => ({ ...entry, awaitingResponse: this.awaitingResponses.has(entry) })), outcomes: live?.outcomes ?? {}, models: this.providers.catalog(live?.models ?? [], live), profiles: live?.profiles ?? [],
        lastAcceptedModel: this.providers.lastAcceptedModel ?? null,
        defaultProfile: live?.resourceProfile ?? this.defaultProfile ?? null, configurations: live?.configurations ?? {},
        summaries: live?.summaries ?? [], summariesLoaded: live?.summariesLoaded === true,
        observationErrors: live?.observationErrors ?? {}, refreshErrors: live?.refreshErrors ?? {}, error: live?.error ?? null };
    }) };
  }

  start(id) {
    try { this.lifecycleOperations.assertProject(id); }
    catch (error) { return Promise.reject(error); }
    if (this.closing) return Promise.reject(new Error('应用正在退出'));
    if (this.starting.has(id)) return this.starting.get(id);
    const project = this.projects.get(id);
    if (project) { clearTimeout(project.reconnectTimer); project.reconnectTimer = null; project.reconnectBlocked = false; }
    const task = this.startProject(id).finally(() => this.starting.delete(id));
    this.starting.set(id, task);
    return task;
  }

  readConnection(id, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const startup = this.start(id);
    let waiters = this.readWaiters.get(startup);
    if (!waiters) {
      waiters = new Set();
      this.readWaiters.set(startup, waiters);
      startup.then(project => this.settleReadWaiters(startup, null, {
        project, client: project.client, generation: project.connectionGeneration ?? 0,
      }), error => this.settleReadWaiters(startup, error));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error, connection) => {
        if (settled) return;
        settled = true;
        waiters.delete(settle);
        signal?.removeEventListener('abort', abort);
        try {
          if (error) throw error;
          this.lifecycleOperations.assertProject(id);
          const { project, client, generation } = connection;
          if (!this.saved.some(saved => saved.id === id) || this.projects.get(id) !== project)
            throw new Error('任务所有者已移除');
          this.requireConnection(project, client);
          if (!client.ready || (project.connectionGeneration ?? 0) !== generation)
            throw Object.assign(new Error('连接已换代，请重试'), { code: 'STALE_CONNECTION' });
          resolve(connection);
        } catch (failure) { reject(failure); }
      };
      const abort = () => settle(signal.reason);
      waiters.add(settle);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const project = this.projects.get(id);
      if (project?.client?.ready) settle(null, {
        project, client: project.client, generation: project.connectionGeneration ?? 0,
      });
    });
  }

  settleReadWaiters(startup, error, connection) {
    for (const settle of this.readWaiters.get(startup) ?? []) settle(error, connection);
  }

  // 本地日志加载与连接启动共用同一项目对象；只读收据不启动 Core。
  loadProjectJournal(id) {
    this.journalLoads ??= new Map();
    if (this.journalLoads.has(id)) return this.journalLoads.get(id);
    const task = (async () => {
      const saved = this.saved.find(project => project.id === id);
      if (!saved) throw new Error('未知项目');
      const { CoreTaskModel } = await import('@areal/workbench/core-model');
      let project = this.projects.get(id);
      if (!project) {
        project = { ...saved, model: new CoreTaskModel(), pending: [], outcomes: {}, configurations: {},
          configurationChanges: new Map(), error: null, summaries: [] };
        this.projects.set(id, project);
        project.model.subscribe(() => this.onChange());
      }
      if (!project.journalLoaded) {
        try { project.pending = JSON.parse(await readFile(join(this.home, `${id}-pending.json`), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { project.outcomes = JSON.parse(await readFile(join(this.home, `${id}-outcomes.json`), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        project.journalLoaded = true;
      }
      if (this.projects.get(id) !== project || !this.saved.some(value => value.id === id)) throw new Error('项目登记已变化');
      return project;
    })();
    this.journalLoads.set(id, task);
    const clear = () => { if (this.journalLoads.get(id) === task) this.journalLoads.delete(id); };
    task.then(clear, clear);
    return task;
  }

  async startProject(id) {
    const current = this.projects.get(id);
    const trace = current?.client?.ready && !current.resourceInitializing ? null : startupTrace('core.start_project', { projectId: id });
    trace?.advance('journal');
    try {
      const project = await this.loadProjectJournal(id);
      if (project.client?.ready && !project.resourceInitializing) { trace?.finish('skipped'); return project; }
      try {
        project.resourceInitializing = !!project.worktreeResources;
        trace?.advance('worktree_prepare');
        await this.resources.worktrees.prepare(project);
        trace?.advance('launch');
        if (!project.client?.ready) await this.launch(project);
        trace?.advance('connect');
        if (!project.client?.ready) await this.connect(project);
        trace?.advance('history');
        await this.listThreads(project);
        trace?.advance('reconcile');
        await this.reconcile(project);
        trace?.advance('worktree_apply');
        await this.resources.worktrees.apply(project);
        project.resourceInitializing = false;
        project.error = null;
        project.model.connection(true);
        this.onChange();
        trace?.finish('ok');
        return project;
      } catch (error) {
        // A failed resource import must still allow authenticated status/drain on
        // its running Core. Keep the management connection, while start() retries
        // initialization before admitting any task or project command.
        if (error.code === 'RESPONSE_TOO_LARGE' || error.reason === 'RESPONSE_TOO_LARGE') project.reconnectBlocked = true;
        if (!project.resourceInitializing || !project.client?.ready) project.client?.close();
        project.error = error.message;
        project.model.connection(false, error.message);
        throw error;
      }
    } catch (error) { trace?.finish('error', error); throw error; }
  }

  async prepareServiceLaunch(project, trace) {
    const directory = join(this.home, project.id);
    const dataDir = join(directory, 'state');
    const scratch = join(directory, 'scratch');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const args = ['--workspace', project.root, '--data-dir', dataDir, '--scratch', scratch, '--allow-write'];
    if (this.desktopProcesses) args.push('--allow-concurrent-writes', '--desktop-process-timeout-ms', '86400000');
    if (this.config) args.push('--config', this.config);
    if (this.sandboxProfile) args.push('--sandbox-profile', this.sandboxProfile);
    if (this.workgroupPolicy) args.push('--workgroup-policy', this.workgroupPolicy);
    if (this.workgroupToolchain) args.push('--workgroup-toolchain', this.workgroupToolchain);
    trace.advance('resources');
    const resourceDeployment = await this.resources.deployment(project);
    if (resourceDeployment.path) args.push('--desktop-config', resourceDeployment.path);
    project.resourceProfile = resourceDeployment.profile;
    project.resourceFingerprint = resourceDeployment.fingerprint;
    trace.advance('provider_prepare');
    await this.providers.prepare();
    trace.advance('provider_config');
    await this.providers.config.current();
    project.providerRevision = null;
    delete project.providerSnapshot;
    trace.advance('hooks');
    const hookDeployment = await this.hooks.launch();
    project.hookRevision = null;
    const environment = { ...this.hooks.environment(), AREAL_HARNESS_TOOL_EXTENSIONS: hookDeployment.path, ...this.providers.environment() };
    return { args, environment, dataDir, hookDeployment };
  }

  async launch(project) {
    const trace = startupTrace('core.launch', { projectId: project.id });
    trace.advance('directories');
    try {
      const { args, environment, dataDir, hookDeployment } = await this.prepareServiceLaunch(project, trace);
      trace.advance('service_ensure');
      const owned = this.ownedEngines.get(project.id) ?? { project, dataDir, pending: true };
      owned.project = project; owned.pending = true;
      this.ownedEngines.set(project.id, owned);
      const { descriptor, token } = await connectService(this, 'ensure', args, environment, project, dataDir);
      project.service = descriptor;
      owned.service = descriptor; owned.pending = false;
      project.endpoint = descriptor.endpoint;
      project.token = token;
      trace.advance('configuration_recheck');
      if ((await this.hooks.current()).revision === hookDeployment.revision) project.hookRevision = hookDeployment.revision;
      trace.finish('ok');
      const attached = startupTrace('core.service_ready', { projectId: project.id, coreGeneration: descriptor.generation });
      attached.finish('ok');
    } catch (error) { trace.finish('error', error); throw error; }
  }

  async refreshOwnedEngines() {
    if (!this.applicationOwner) return;
    const { serviceRequest } = require('./local-service.cjs');
    const { sameOwner } = require('./application-owner.cjs');
    const descriptors = await serviceRequest(this, ['list']);
    if (!Array.isArray(descriptors)) throw new Error('Core 返回了无效的服务登记列表');
    for (const descriptor of descriptors) {
      if (!sameOwner(descriptor.owner, this.applicationOwner)) continue;
      // 历史索引沿用原项目 ID；路径散列只用于尚未登记的启动恢复，不能替换已登记身份。
      const registered = this.saved.find(project => /^[a-f0-9]{24}$/.test(project.id)
        && project.root === descriptor.workspace && descriptor.dataDir === join(this.home, project.id, 'state'));
      const projectId = registered?.id ?? createHash('sha256').update(descriptor.workspace).digest('hex').slice(0, 24);
      if (descriptor.dataDir !== join(this.home, projectId, 'state')) throw new Error('所属 Core 的数据目录与登记不匹配');
      if (descriptor.state === 'stopped') {
        const target = { projectId, serviceId: descriptor.serviceId, generation: descriptor.generation, root: descriptor.workspace };
        const original = await require('./local-service.cjs').inspectOriginalService(this, target);
        if (!original.cleanupConfirmed) throw new Error('所属 Core 已失联，但原代际清理尚未确认');
        const owned = this.ownedEngines.get(projectId);
        if (owned && (!owned.service || owned.service.generation === descriptor.generation)) {
          owned.service ??= descriptor;
          require('./local-service.cjs').detachStoppedProject(this, target);
        }
        continue;
      }
      let owned = this.ownedEngines.get(projectId);
      if (owned?.service && (owned.service.serviceId !== descriptor.serviceId || owned.service.generation !== descriptor.generation))
        throw Object.assign(new Error('所属 Core 代际发生变化，请检查原请求'), { code: 'CONFIRMATION_STALE' });
      if (!owned) {
        const { CoreTaskModel } = await import('@areal/workbench/core-model');
        const project = this.projects.get(projectId) ?? { id: projectId, root: descriptor.workspace,
          model: new CoreTaskModel(), pending: [], outcomes: {}, configurations: {}, summaries: [] };
        owned = { project, dataDir: descriptor.dataDir };
        this.ownedEngines.set(projectId, owned);
      }
      owned.service ??= descriptor; owned.pending = false;
      owned.project.service ??= owned.service;
    }
    for (const [projectId, owned] of this.ownedEngines) {
      if (!owned.pending || this.starting.has(projectId)) continue;
      if (!descriptors.some(descriptor => sameOwner(descriptor.owner, this.applicationOwner)
        && descriptor.dataDir === owned.dataDir && descriptor.state !== 'stopped')) {
        throw Object.assign(new Error(`项目 ${owned.project.root} 的启动结果尚未确认。请检查原服务启动日志并重新连接核对，不能将缺少登记视为已清理。`),
          { code: 'LIFECYCLE_INCOMPLETE' });
      }
    }
  }

  async restartProject(project) {
    this.lifecycleOperations.assertProject(project.id);
    if (project.service) {
      const receipt = await this.lifecycleOperations.request({ requestId: randomUUID(), kind: 'updateProject', mode: 'ifIdle',
        expectedDesktopGeneration: this.lifecycleOperations.generation,
        expectedTargets: [{ projectId: project.id, serviceId: project.service.serviceId, generation: project.service.generation }] });
      if (receipt.phase !== 'completed') throw Object.assign(new Error('原 Core 尚未停止，不能更新配置'),
        { code: 'LIFECYCLE_INCOMPLETE', requestId: receipt.requestId, lifecycle: receipt });
    }
    await this.launch(project);
    await this.connect(project);
    await this.reconcile(project);
    await this.resources.worktrees.apply(project);
  }

  currentConnection(project, client) {
    return !this.closing && !!client && project.client === client && !client.closed;
  }

  requireConnection(project, client) {
    if (!this.currentConnection(project, client)) throw Object.assign(new Error('连接已换代，请等待状态恢复后重试'), { code: 'STALE_CONNECTION' });
  }

  scheduleReconnect(project) {
    if (this.closing || project.resourceInitializing || !project.service || project.reconnectBlocked || project.reconnectTimer || project.client?.ready) return;
    const delay = Math.min(500 * 2 ** Math.min(project.reconnectAttempt ?? 0, 6), 30000);
    project.reconnectTimer = setTimeout(() => {
      project.reconnectTimer = null;
      if (this.closing || !project.service || project.reconnectBlocked || project.client?.ready) return;
      if (this.providerUpdating || this.resourcesUpdating || this.starting.has(project.id)) { this.scheduleReconnect(project); return; }
      const task = this.reconnectProject(project).catch(error => {
        if (!this.closing) {
          project.reconnectBlocked = ['CORE_STOPPED', 'CORE_INCOMPATIBLE', 'CORE_RECOVERY_EXHAUSTED', 'LIFECYCLE_INCOMPLETE', 'LIFECYCLE_EXIT_REQUESTED', 'RESPONSE_TOO_LARGE'].includes(error.code)
            || error.reason === 'RESPONSE_TOO_LARGE' || project.client?.closeFailure?.code === 'RESPONSE_TOO_LARGE';
          project.reconnectAttempt = (project.reconnectAttempt ?? 0) + 1;
          this.stopReconciliation(project);
          project.client?.close();
          project.error = this.providers.redact(error.message);
          project.model.connection(false, project.error);
        }
        throw error;
      }).finally(() => {
        if (this.starting.get(project.id) === task) this.starting.delete(project.id);
        this.scheduleReconnect(project);
      });
      this.starting.set(project.id, task);
      // 用户操作可以加入同一恢复任务；无订阅者的被动失败也必须被接收。
      void task.catch(() => {});
    }, delay);
    project.reconnectTimer.unref();
  }

  async reconnectProject(project) {
    const previous = project.service, previousClient = project.client;
    const current = () => {
      this.lifecycleOperations.assertProject(project.id);
      if (this.closing || this.projects.get(project.id) !== project || project.service !== previous || project.client !== previousClient)
        throw Object.assign(new Error('服务归属已变化'), { code: 'STALE_CONNECTION' });
    };
    current();
    let connection;
    try {
      connection = await connectService(this, 'status', ['--instance', previous.serviceId],
        this.hooks.environment(), project, previous.dataDir);
      current();
      if (connection.descriptor.generation !== previous.generation) {
        if (project.crashRecovery?.original !== previous) throw Object.assign(new Error('Core 代际已变化，请检查原服务'), { code: 'CORE_INCOMPATIBLE' });
        connection = await this.recoverCrashedProject(project, previous, current);
      }
    } catch (error) {
      if (error.code !== 'CORE_STOPPED' || !this.applicationOwner) throw error;
      current();
      connection = await this.recoverCrashedProject(project, previous, current);
    }
    current();
    const { descriptor, token } = connection;
    if (descriptor.serviceId !== previous.serviceId || descriptor.configFingerprint !== previous.configFingerprint)
      throw Object.assign(new Error('Core 部署配置已变化，请显式重新连接'), { code: 'CORE_INCOMPATIBLE' });
    project.service = descriptor; project.endpoint = descriptor.endpoint; project.token = token;
    const owned = this.ownedEngines.get(project.id);
    if (owned) { owned.service = descriptor; owned.pending = false; }
    await this.connect(project, { observeOnly: true });
    await this.reconcile(project, { observeOnly: true });
    project.reconnectAttempt = 0;
    return project;
  }

  async recoverCrashedProject(project, original, current) {
    const local = require('./local-service.cjs');
    current();
    let attempt = project.crashRecovery;
    if (attempt?.original !== original) {
      project.crashCheck ??= { generation: original.generation, started: Date.now() };
      if (project.crashCheck.generation !== original.generation) project.crashCheck = { generation: original.generation, started: Date.now() };
      const { service, recovery } = await local.recoveryStatus(this, project, original);
      current();
      if (!recovery.eligible) {
        const waiting = service.state !== 'stopping' && recovery.reason === 'cleanupUnconfirmed'
          && Date.now() - project.crashCheck.started < 30000;
        throw Object.assign(new Error(waiting ? '正在确认原执行资源已清理' : '当前服务无法自动恢复，请检查原服务状态后重新连接'),
          { code: waiting ? 'CORE_RECOVERY_PENDING' : 'CORE_STOPPED' });
      }
      const now = Date.now();
      project.crashAttempts = (project.crashAttempts ?? []).filter(time => now - time < 300000);
      if (project.crashAttempts.length >= 2) throw Object.assign(new Error('服务连续中断，自动恢复已暂停，请检查服务详情后重新连接'), { code: 'CORE_RECOVERY_EXHAUSTED' });
      project.crashAttempts.push(now);
      attempt = project.crashRecovery = { original, calls: 0 };
    }
    if (attempt.calls >= 2) throw Object.assign(new Error('原服务的自动恢复结果仍未确认，请检查服务详情后重新连接'), { code: 'CORE_RECOVERY_EXHAUSTED' });
    const trace = startupTrace('core.crash_recovery', { projectId: project.id, coreGeneration: original.generation });
    try {
      const launch = await this.prepareServiceLaunch(project, trace);
      current();
      attempt.calls++;
      const connection = await local.recoverService(this, project, original, launch);
      current();
      if (connection.descriptor.generation === original.generation) throw Object.assign(new Error('恢复未返回原服务的后继代际'), { code: 'CORE_INCOMPATIBLE' });
      if ((await this.hooks.current()).revision === launch.hookDeployment.revision) project.hookRevision = launch.hookDeployment.revision;
      current();
      trace.finish('ok');
      return connection;
    } catch (error) { trace.finish('error', error); throw error; }
  }

  async connect(project, { observeOnly = false } = {}) {
    const startup = this.starting.get(project.id);
    const { CoreClient, MAX_RESPONSE_BYTES } = await import('@areal/runtime-client/core');
    if (this.closing) throw new Error('应用正在退出');
    project.taskNotificationMonitor?.stop();
    const previous = project.client;
    this.stopReconciliation(project);
    project.client = null;
    previous?.close();
    project.summariesLoaded = false;
    const client = new CoreClient({ createSocket: () => {
      const target = Object.freeze({ boundary: 'desktop-core', projectId: project.id, coreGeneration: project.service?.generation,
        connectionGeneration: project.connectionGeneration, hostPid: project.service?.hostPid, corePid: project.service?.corePid, serviceId: project.service?.serviceId });
      const socket = new WebSocket(project.endpoint, { headers: { Authorization: `Bearer ${project.token}` }, followRedirects: false, maxPayload: MAX_RESPONSE_BYTES });
      socket.on('open', () => diagnostics.record({ type: 'socket-open', ...target }));
      socket.on('error', error => diagnostics.record({ type: 'socket-error', ...target, code: error.code }));
      socket.on('close', closeCode => diagnostics.record({ type: 'socket-close', ...target, closeCode }));
      return socket;
    }, onServerRequest: async (method, params, context) => {
      if (method === 'areal/task/prepare') {
        this.requireConnection(project, client);
        if (params.intent === 'resume') return {};
        await this.resources.beforeCreate(project);
        this.requireConnection(project, client);
        const model = this.providers.value.defaultModel;
        const profile = project.resourceProfile ?? this.defaultProfile;
        return { ...(model ? { model } : {}), ...(profile ? { agentProfile: profile } : {}),
          ...(this.supportsBrowser(project) ? { dynamicTools: [browserTool] } : {}) };
      }
      if (!['item/tool/call', 'areal/browser/prepare'].includes(method) || params?.tool !== 'browser_v1') throw new Error('Unsupported client tool');
      const connected = this.currentConnection(project, client);
      // Core invokes only tools bound to this connection. The local Thread
      // projection can lag the committed attachment until its event arrives.
      const result = connected ? (await this.browserRead?.({ projectId: project.id, threadId: params.threadId,
        turnId: params.turnId, callId: params.callId, toolHostGeneration: params.hostGeneration, arguments: params.arguments,
        phase: method === 'areal/browser/prepare' ? 'prepare' : 'execute', browserApproval: params.browserApproval,
        coreInstanceId: project.service?.serviceId, coreGeneration: project.service?.generation,
        signal: context.signal })) ?? browserFailure('host_unavailable', 'Desktop browser is unavailable')
        : browserFailure('host_unavailable', 'Desktop connection changed');
      if (method === 'areal/browser/prepare' && result?.success === false
        && typeof result.structuredContent?.code === 'string' && result.structuredContent.dispatch === 'not_sent')
        return { error: result.structuredContent.code, dispatch: 'not_sent' };
      return result;
    } });
    project.client = client;
    project.connectionGeneration = (project.connectionGeneration ?? 0) + 1;
    const correlation = { projectId: project.id, connectionGeneration: project.connectionGeneration, coreGeneration: project.service?.generation };
    const trace = startupTrace('core.connect', correlation);
    trace.advance('socket');
    try {
      client.onNotification((method, params) => {
        if (!this.currentConnection(project, client)) return;
        if (['thread/started', 'turn/started', 'turn/completed', 'areal/thread/configured', 'areal/task/changed', 'areal/queue/changed'].includes(method)) this.scheduleReconciliation(project);
        const threadId = params?.threadId ?? params?.thread?.id ?? params?.interaction?.threadId;
        if (threadId && project.observationErrors?.[threadId]?.code === 'RESPONSE_TOO_LARGE') return;
        if (method === 'areal/thread/configured' && params?.threadId && params.configuration) {
          project.configurations ??= {};
          const previous = project.configurations[params.threadId];
          project.configurations[params.threadId] = { ...params.configuration,
            modelName: params.configuration.defaultModelRevision && params.configuration.defaultModelRevision === previous?.defaultModelRevision ? previous.modelName : undefined };
          this.onChange();
        }
        if (['areal/mcp/app/tools/pending', 'areal/mcp/app/tools/cancelled'].includes(method)) {
          this.onMcpPageToolNotice?.({ projectId: project.id, client, method, params });
          return;
        }
        if (method === 'areal/mcp/app/notification') this.onMcpAppNotification?.({ projectId: project.id, ...params });
        this.analytics.observe(project.id, method, params);
        if (method === 'areal/thread/edited' && this.supportsBoundedHistory(client)) {
          void this.openThread(project, threadId).catch(() => {});
          return;
        }
        project.model.event(method, params);
        if (method === 'areal/context/compacted' && params?.threadId) {
          void this.openThread(project, params.threadId).catch(() => {});
        }
        if (!isTaskDraftConfiguration(project.configurations?.[params.threadId])) this.notifications.observe(project, method, params, this.library.value);
        if (method === 'thread/started' || method === 'turn/started' || method === 'turn/completed') {
          void this.library.recordThreadActivity(project.id, params.threadId ?? params.thread?.id,
            method === 'turn/completed' ? params.turn?.id ?? params.turnId : undefined).catch(() => {});
        }
        // Lifecycle notifications omit thread timestamps; refresh the authoritative
        // summaries so continued and automatically dequeued tasks sort correctly.
        if (method === 'turn/started' || method === 'turn/completed') {
          void this.listThreads(project).catch(() => {});
        }
        if (method === 'turn/completed') this.providers.requestReconciliation();
        if (method === 'turn/completed' && this.supportsBoundedHistory(client)
          && Buffer.byteLength(JSON.stringify(project.model.state.threads[threadId] ?? {})) > historyMaxBytes)
          void this.openThread(project, threadId).catch(() => {});
      });
      client.onClose(failure => {
        this.onMcpPageToolsDisconnected?.(client);
        if (project.client === client) {
        project.taskNotificationMonitor?.stop();
        this.stopReconciliation(project);
        if (failure.code === 'RESPONSE_TOO_LARGE') {
          project.reconnectBlocked = true;
          clearTimeout(project.reconnectTimer);
          project.reconnectTimer = null;
          project.error = 'Core 返回内容超过当前支持的 64 MiB，无法完整加载。';
        }
        project.model.connection(false, project.reconnectBlocked ? project.error : '连接中断，正在恢复任务状态');
        this.scheduleReconnect(project);
      } });
      await client.connect();
      this.requireConnection(project, client);
      if (startup && this.starting.get(project.id) === startup) this.settleReadWaiters(startup, null, {
        project, client, generation: correlation.connectionGeneration,
      });
      project.error = null;
      project.configurations ??= {};
      project.configurationChanges ??= new Map();
      trace.advance('provider_configuration');
      await this.providers.reconcileProject(project, { refreshModels: false });
      this.requireConnection(project, client);
      if (!observeOnly) {
        trace.advance('providers');
        await this.providers.sync(project, correlation);
        this.requireConnection(project, client);
        trace.advance('mcp');
        await this.resources.syncMcp(project);
        this.requireConnection(project, client);
      }
      trace.advance('catalogs');
      const modelsTrace = startupTrace('core.model_list', correlation);
      modelsTrace.advance('request');
      const profilesTrace = startupTrace('core.profile_list', correlation);
      profilesTrace.advance('request');
      const [models, profiles] = await Promise.all([
        client.request('areal/model/list').then(value => { modelsTrace.finish('ok'); return value; }, error => { modelsTrace.finish('error', error); throw error; }),
        client.request('areal/profile/list').then(value => { profilesTrace.finish('ok'); return value; }, error => { profilesTrace.finish('error', error); throw error; }),
      ]);
      this.requireConnection(project, client);
      await this.providers.acceptModelSelection(models.lastAcceptedModel);
      project.models = models.data ?? models.models ?? [];
      project.profiles = profiles.data ?? profiles.profiles ?? [];
      trace.advance('history');
      await this.listThreads(project);
      if (!observeOnly) void this.analytics.syncProject(project);
      // 重连恢复所有已打开的任务，快照在 socket 消息分派栈内替换。
      trace.advance('restore_views');
      for (const threadId of Object.keys(project.model.state.threads)) {
        try { await this.openThread(project, threadId); }
        catch (error) {
          if (!isObservationSizeFailure(error) || !this.currentConnection(project, client) || !client.ready) throw error;
        }
      }
      trace.advance('task_subscriptions');
      for (const taskId of new Set(project.taskViews?.values() ?? [])) {
        await client.request('areal/task/subscribe', { taskId }, { onResult: task => {
          if (this.currentConnection(project, client)) project.model.setTask(task);
        } });
        this.requireConnection(project, client);
      }
      trace.advance('task_monitor');
      project.taskNotificationMonitor = new TaskNotificationMonitor(client, project.id,
        notice => { if (this.currentConnection(project, client)) this.notifications.publish(notice); }, error => console.warn(this.providers.redact(`任务通知读取失败：${error.message}`)),
        async tasks => {
          if (!this.currentConnection(project, client)) return;
          for (const task of tasks) project.model.setTask(task);
          const scheduled=tasks.filter(task=>task.mode==='scheduled');
          if(scheduled.some(task=>task.runs.some(run=>run.threadId&&!project.summaries.some(thread=>thread.id===run.threadId)))) {
            await this.listThreads(project);
            this.requireConnection(project, client);
          }
          for(const task of scheduled)for(const run of task.runs) {
            if(run.status!=='completed' || !run.threadId || this.library.value.threads[`${project.id}:${run.threadId}`]?.scheduledCompletionId===run.id)continue;
            const {thread}=this.supportsBoundedHistory(client)
              ? await this.readObservation(project,run.threadId,{client,install:false})
              : await client.request('thread/read',{threadId:run.threadId,includeTurns:true});
            this.requireConnection(project,client);
            const completionId=thread.turns?.findLast(turn=>turn.status==='completed')?.id;
            await this.library.recordScheduledCompletion(project.id,run,completionId);
          }
        });
      await project.taskNotificationMonitor.start();
      this.requireConnection(project, client);
      trace.advance('host_ready');
      if (client.capabilities?.methods?.includes('areal/task/host/ready')) {
        await client.request('areal/task/host/ready', {});
        this.requireConnection(project, client);
      }
      trace.advance('connected');
      project.model.connection(true);
      this.scheduleReconciliation(project);
      this.onChange();
      trace.finish('ok');
    } catch (error) { trace.finish('error', error); throw error; }
  }

  listThreads(project) {
    const client = project.client;
    // Lifecycle refreshes and explicit reads can overlap. Serialize complete
    // reads so an earlier snapshot cannot overwrite a later navigation cache.
    const task = (project.summaryReads ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.currentConnection(project, client)) return project.summaries;
      const data = [];
      let cursor;
      do {
        const classified = client.capabilities?.methods?.includes('areal/conversation/list');
        const page = await client.request(classified ? 'areal/conversation/list' : 'thread/list', {
          limit: 100, ...(classified ? { view: 'main', includeArchived: true } : {}), ...(cursor ? { cursor } : {}),
        });
        data.push(...page.data.filter(thread => !isTaskDraftConfiguration(thread.desktop?.configuration)));
        cursor = page.nextCursor;
      } while (cursor);
      if (!this.currentConnection(project, client)) return project.summaries;
      await this.library.recordThreadSummaries(project.id, data);
      if (!this.currentConnection(project, client)) return project.summaries;
      project.summaries = data;
      project.summariesLoaded = true;
      this.onChange();
      return data;
    });
    project.summaryReads = task.catch(() => {});
    return task;
  }

  observationFailure(project, threadId, error, { refreshPending = false, id = randomUUID() } = {}) {
    project.observationErrors ??= {};
    project.observationErrors[threadId] = { id, projectId: project.id, threadId,
      connectionGeneration: project.connectionGeneration, code: error.code ?? 'OBSERVATION_FAILED',
      reason: error.reason, message: this.providers.redact(error.message), retryable: retryableRead(error), refreshPending,
      recovery: { kind: retryableRead(error) ? 'retryRead' : 'none' } };
    this.onChange();
  }

  async refreshAfterAdmission(project, threadId, operation, { backgroundList = false } = {}) {
    const client = project.client, generation = project.connectionGeneration;
    const current = () => this.currentConnection(project, client) && project.connectionGeneration === generation;
    const key = operation?.requestId ?? 'project';
    if (operation?.method === 'areal/task/runNow' && operation.target?.kind === 'task') {
      try {
        const task = await client.request('areal/task/read', { taskId: operation.target.taskId });
        if (!current()) return;
        project.model.setTask(task);
        if (project.refreshErrors?.[key]?.scope === 'task') delete project.refreshErrors[key];
        this.onChange();
      } catch (error) {
        if (!current()) return;
        project.refreshErrors ??= {};
        project.refreshErrors[key] = { id: randomUUID(), projectId: project.id, scope: 'task',
          connectionGeneration: generation, operation, message: this.providers.redact(error.message), refreshPending: true };
        this.onChange();
      }
    }
    if (threadId) {
      try { await this.openThread(project, threadId); }
      catch (error) { if (current()) this.observationFailure(project, threadId, error); }
    }
    if (!current()) return;
    const refreshList = async () => {
      try {
        await this.listThreads(project);
        if (current() && project.refreshErrors?.[key]?.scope === 'threadList') delete project.refreshErrors[key];
      } catch (error) {
        if (!current()) return;
        project.refreshErrors ??= {};
        project.refreshErrors[key] ??= { id: randomUUID(), projectId: project.id, scope: 'threadList',
          connectionGeneration: generation, operation, message: this.providers.redact(error.message), refreshPending: true };
        this.onChange();
      }
    };
    if (backgroundList) void refreshList();
    else await refreshList();
  }

  async openThread(project, threadId) {
    const client = project.client, generation = project.connectionGeneration;
    project.observationReads ??= new Map();
    const existing = project.observationReads.get(threadId);
    if (existing?.client === client && existing.generation === generation) return existing.promise;
    const attempt = { client, generation, id: randomUUID() };
    const current = () => this.currentConnection(project, client) && generation === project.connectionGeneration
      && project.observationReads.get(threadId) === attempt;
    const deadline = Date.now() + 30000;
    const promise = Promise.resolve().then(async () => {
      for (let retries = 0; ; retries++) {
        if (!current()) throw Object.assign(new Error('连接已换代，请等待状态恢复'), { code: 'STALE_CONNECTION' });
        try {
          await this.observeThread(project, threadId, { client, current, deadline });
          if (current()) { delete project.observationErrors?.[threadId]; this.onChange(); }
          return;
        } catch (error) {
          if (!current()) throw error;
          const delay = reconciliationDelays[retries];
          const retry = retryableRead(error) && client.ready && delay !== undefined && Date.now() + delay < deadline
            && !this.lifecycleOperations.blocking(project.id, threadId) && !this.lifecycleOperations.activeTargets.has(project.id);
          this.observationFailure(project, threadId, error, { refreshPending: retry, id: attempt.id });
          if (!retry) throw error;
          await sleep(delay);
        }
      }
    }).finally(() => { if (project.observationReads.get(threadId) === attempt) project.observationReads.delete(threadId); });
    attempt.promise = promise;
    project.observationReads.set(threadId, attempt);
    return promise;
  }

  supportsBoundedHistory(client) {
    return client?.capabilities?.features?.boundedObservation === true && client.capabilities.features.boundedHistory === true;
  }

  historyWindow(project, threadId) { return this.historyWindows?.get(`${project.id}:${threadId}`); }

  publishHistory(project, window) {
    if (this.historyWindow(project, window.threadId) !== window) return;
    const thread = project.model.state.threads[window.threadId];
    if (!thread) return;
    project.model.replace({ ...thread, displayHistory: { supported: true, complete: window.complete,
      omitted: window.omitted, loadingOlder: !!window.olderRead, loadingItems: Object.fromEntries(window.loading),
      baselineFirstItemId: window.baselineFirstItemId, viewGeneration: window.viewGeneration } });
  }

  installObservation(project, result) {
    const thread = result.thread;
    const previousThread = project.model.state.threads[thread.id];
    if (!result.history) {
      project.model.replace({ ...thread, displayHistory: { supported: false } });
    } else {
      this.historyWindows ??= new Map();
      for (const [key, window] of this.historyWindows) {
        if (this.projects.get(window.project.id) !== window.project) this.historyWindows.delete(key);
      }
      const key = `${project.id}:${thread.id}`, previous = this.historyWindows.get(key);
      if (!previous && this.historyWindows.size >= historyViewLimit) {
        const victim = [...this.historyWindows.entries()].find(([, window]) => window.views.size === 0);
        if (!victim) throw historyFailure('同时打开的历史视图已达上限，请先关闭一个视图。');
        this.historyWindows.delete(victim[0]);
        const { project: owner, threadId } = victim[1];
        const { [threadId]: removed, ...threads } = owner.model.state.threads;
        const { [threadId]: interactions, ...otherInteractions } = owner.model.state.interactions;
        const { [threadId]: queue, ...queues } = owner.model.state.queues;
        owner.model.publish({ threads, interactions: otherInteractions, queues });
      }
      const window = { project, threadId: thread.id, ...result.history, views: previous?.views ?? new Set(), viewGeneration: randomUUID(),
        pages: [], loaded: new Map(), loading: new Map(), omitted: false, epoch: 0, baselineCursor: result.history.nextCursor,
        baselineComplete: result.history.complete, baselineFirstItemId: thread.turns?.flatMap(turn => turn.items ?? [])[0]?.id };
      this.historyWindows.delete(key); this.historyWindows.set(key, window);
      project.model.replace({ ...thread, displayHistory: { supported: true, complete: window.complete, omitted: false,
        baselineFirstItemId: window.baselineFirstItemId, viewGeneration: window.viewGeneration, loadingItems: {} } });
    }
    for (const turn of thread.turns ?? []) {
      if (turn.id && ['completed', 'failed', 'interrupted'].includes(turn.status)
        && previousThread?.turns?.some(previous => previous.id === turn.id && previous.status === 'inProgress')) {
        void this.library.recordThreadActivity(project.id, thread.id, turn.id).catch(() => {});
      }
    }
  }

  async readObservation(project, threadId, { client = project.client, current = () => this.currentConnection(project, client), timeoutMs, install = true, resume = false } = {}) {
    const bounded = this.supportsBoundedHistory(client);
    if (resume && bounded && client.capabilities.features.boundedResume !== true)
      throw historyFailure('当前 Core 无法按页恢复浏览器连接，请更新 Core 后重试。');
    const method = resume ? 'thread/resume' : 'areal/thread/observe';
    for (const maxBytes of bounded ? [historyPageBytes, historyMaxBytes] : [undefined]) {
      try {
        return await client.request(method, { threadId, ...(bounded ? { mode: 'bounded', maxBytes } : {}) }, {
          timeoutMs, ...(bounded ? { maxResponseBytes: maxBytes } : {}),
          onResult: result => { if (current() && result.thread?.id === threadId && install) this.installObservation(project, result); },
        });
      } catch (error) {
        if (!bounded || maxBytes === historyMaxBytes || historyReason(error) !== 'HISTORY_BUDGET_TOO_SMALL') throw error;
      }
    }
  }

  async historyCommand(project, request) {
    const { threadId, viewId, operation } = request;
    let window = this.historyWindow(project, threadId);
    if (operation === 'release') {
      if (!window) return { released: true };
      window.views.delete(viewId);
      if (!window.views.size) {
        window.epoch++;
        const drop = new Set(window.pages.flatMap(page => page.data.map(entry => entry.sourceItemId)));
        const thread = project.model.state.threads[threadId];
        if (thread) project.model.replace({ ...thread, turns: thread.turns.map(turn => ({ ...turn,
          items: turn.items.filter(item => !drop.has(item.id)).map(item => window.loaded.get(item.id)?.placeholder ?? item),
        })).filter(turn => turn.items.length || turn.status === 'inProgress') });
        window.pages = []; window.loaded.clear(); window.loading.clear(); window.olderRead = null;
        window.nextCursor = window.baselineCursor; window.complete = window.baselineComplete; window.omitted = false;
        this.publishHistory(project, window);
      }
      return { released: true };
    }
    if (!this.supportsBoundedHistory(project.client)) return { supported: false, message: '当前 Core 使用完整历史读取，不支持分页；请更新 Core。' };
    if (!window) { await this.openThread(project, threadId); window = this.historyWindow(project, threadId); }
    if (!window) throw historyFailure('历史视图尚未就绪，请重新打开聊天。');
    if (operation === 'acquire') { window.views.add(viewId); return { supported: true, complete: window.complete }; }
    if (!window.views.has(viewId)) throw historyFailure('历史视图已关闭，请重新打开聊天。');
    const client = project.client, epoch = window.epoch;
    const current = () => this.currentConnection(project, client) && this.historyWindow(project, threadId) === window && window.epoch === epoch && window.views.has(viewId);
    const read = (cursor, maxBytes = historyPageBytes) => client.request('areal/conversation/history', { threadId, view: 'own', cursor, maxBytes }, { maxResponseBytes: maxBytes });
    if (operation === 'loadOlder') {
      if (window.olderRead) return window.olderRead;
      if (!window.nextCursor) return { data: [], complete: true, nextCursor: null };
      const cursor = window.nextCursor;
      const loading = Promise.resolve().then(async () => {
        try {
          const page = await read(cursor);
          if (!current()) throw historyFailure('历史视图已变化，请重新加载。');
          if (page.snapshotId !== window.snapshotId || !Array.isArray(page.data) || page.nextCursor === cursor)
            throw historyFailure('历史页的版本或游标无效，请重新打开聊天。');
          if (page.data.some(entry => entry.sourceThreadId !== threadId || entry.fragment || entry.item?.id !== entry.sourceItemId))
            throw historyFailure('历史页与当前聊天不匹配。');
          window.pages.push(page); window.nextCursor = page.nextCursor; window.complete = page.complete;
          let thread = mergeHistory(project.model.state.threads[threadId], page.data);
          if (window.pages.length > historyPageLimit) {
            const removed = new Set(window.pages.shift().data.map(entry => entry.sourceItemId));
            thread = { ...thread, turns: thread.turns.map(turn => ({ ...turn, items: turn.items.filter(item => !removed.has(item.id)) })).filter(turn => turn.items.length || turn.status === 'inProgress') };
            for (const id of removed) window.loaded.delete(id);
            window.omitted = true;
          }
          project.model.replace(thread); return page;
        } catch (error) {
          if (current() && historyReason(error) === 'HISTORY_CURSOR_STALE') await this.openThread(project, threadId);
          throw error;
        } finally { if (this.historyWindow(project, threadId) === window) { window.olderRead = null; this.publishHistory(project, window); } }
      });
      window.olderRead = loading; this.publishHistory(project, window); return loading;
    }
    if (operation !== 'loadItem') throw historyFailure('不支持的历史读取操作。');
    const placeholder = project.model.state.threads[threadId]?.turns.flatMap(turn => turn.items).find(item => item.id === request.itemId);
    if (!placeholder || placeholder.type !== 'historyDeferred') return { loaded: true, itemId: request.itemId };
    if (window.loading.has(placeholder.id)) throw historyFailure('此内容正在加载。');
    let cursor = placeholder.cursor, version = placeholder.version, totalBytes = placeholder.totalBytes, offset = 0, chunks = [], restarted = false;
    const reserved = () => [...this.historyWindows.values()].reduce((sum, view) => sum
      + [...view.loaded.values()].reduce((n, item) => n + item.bytes, 0)
      + [...view.loading.entries()].reduce((n, [id, item]) => n + (view === window && id === placeholder.id ? 0 : item.totalBytes), 0), 0);
    const reserve = () => {
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes + reserved() > historyItemBytes)
        throw historyFailure('完整内容超过当前 128 MiB 阅读缓存，请关闭其他已加载内容后重试。');
      window.loading.set(placeholder.id, { bytes: offset, totalBytes }); this.publishHistory(project, window);
    };
    reserve();
    try {
      while (true) {
        if (!current()) throw historyFailure('历史视图已关闭或变化。');
        let page;
        try { page = await read(cursor, historyMaxBytes); }
        catch (error) {
          if (historyReason(error) === 'HISTORY_ITEM_CHANGED' && error.data?.restartCursor && !restarted) {
            cursor = error.data.restartCursor; offset = 0; chunks = []; version = undefined; restarted = true; continue;
          }
          if (current() && historyReason(error) === 'HISTORY_CURSOR_STALE') await this.openThread(project, threadId);
          throw error;
        }
        if (!current()) throw historyFailure('历史视图已关闭或变化。');
        const entry = page.data?.[0], fragment = entry?.fragment;
        if (page.data?.length !== 1 || entry.sourceThreadId !== threadId || entry.sourceItemId !== placeholder.id || !fragment
          || fragment.offsetUtf8 !== offset || typeof fragment.text !== 'string' || typeof fragment.version !== 'string'
          || version !== undefined && fragment.version !== version || offset > 0 && fragment.totalBytes !== totalBytes)
          throw historyFailure('历史内容分片不连续或版本已变化。');
        if (version === undefined) { version = fragment.version; totalBytes = fragment.totalBytes; }
        if (fragment.totalBytes !== totalBytes) throw historyFailure('历史内容长度已变化。');
        const bytes = Buffer.from(fragment.text, 'utf8'); offset += bytes.length; chunks.push(bytes);
        if (offset > totalBytes) throw historyFailure('历史内容超过声明长度。');
        reserve();
        if (offset === totalBytes) {
          if (!page.complete || page.nextCursor) throw historyFailure('历史内容终点无效。');
          const complete = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
          if (complete.sourceThreadId !== threadId || complete.sourceItemId !== placeholder.id || complete.item?.id !== placeholder.id)
            throw historyFailure('完整历史内容与当前条目不匹配。');
          const thread = project.model.state.threads[threadId];
          const stillDeferred = thread.turns.flatMap(turn => turn.items).find(item => item.id === placeholder.id);
          if (stillDeferred?.type === 'historyDeferred' && stillDeferred.cursor === placeholder.cursor) {
            window.loaded.set(placeholder.id, { placeholder, bytes: totalBytes });
            project.model.replace({ ...thread, turns: thread.turns.map(turn => ({ ...turn,
              items: turn.items.map(item => item.id === placeholder.id ? complete.item : item) })) });
          }
          return { loaded: true, itemId: placeholder.id };
        }
        if (!page.nextCursor || page.nextCursor === cursor || !bytes.length) throw historyFailure('历史内容游标未推进。');
        cursor = page.nextCursor;
      }
    } finally { window.loading.delete(placeholder.id); this.publishHistory(project, window); }
  }

  async observeThread(project, threadId, { client, current, deadline }) {
    const acceptSnapshot = result => {
      if (!current() || result.thread?.id !== threadId) return;
      delete project.observationErrors?.[threadId];
      this.installObservation(project, result);
    };
    try {
      if (!this.supportsBoundedHistory(client) && ((project.summaries ?? []).find(item => item.id === threadId)?.desktop?.archived || project.model.state?.threads?.[threadId]?.desktop?.archived)) {
        const result = await client.request('thread/read', { threadId, includeTurns: true }, { onResult: acceptSnapshot, timeoutMs: Math.min(6000, Math.max(1, deadline - Date.now())) });
        this.requireConnection(project, client);
        if (result.thread?.id !== threadId) throw new Error('恢复结果与目标会话不匹配');
        project.configurations[threadId] = result.thread.desktop.configuration;
        this.onChange();
        return;
      }
      if (!client.capabilities?.methods?.includes('areal/thread/observe')) {
        throw new Error('当前 Core 不支持安全观察已有聊天；请更新 Core 后重新连接');
      }
      const resumed = await this.readObservation(project, threadId, { client, current, timeoutMs: Math.min(6000, Math.max(1, deadline - Date.now())) });
      this.requireConnection(project, client);
      if (resumed.thread?.id !== threadId) throw new Error('恢复结果与目标会话不匹配');
      if (resumed.thread?.desktop?.archived) {
        project.configurations[threadId] = resumed.thread.desktop.configuration;
        project.model.setQueue(threadId, resumed.thread.desktop.queue);
        project.model.setInteractions(threadId, { revision: resumed.thread.desktop.interactionRevision, data: resumed.thread.desktop.interactions });
        this.onChange();
        return;
      }
      if (resumed.thread?.conversation?.kind === 'side') {
        project.configurations[threadId] = resumed.thread.desktop?.configuration;
        this.onChange();
        return;
      }
      const timeoutMs = Math.min(6000, Math.max(1, deadline - Date.now()));
      const results = await Promise.allSettled([
        client.request('areal/interaction/list', { threadId }, {
          timeoutMs, onResult: result => { if (current()) project.model.setInteractions(threadId, result); },
        }),
        this.refreshConfiguration(project, threadId, { client, timeoutMs, current }),
        this.refreshQueue(project, threadId, { client, timeoutMs, current }),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;

    } catch (error) {
      if (!this.supportsBoundedHistory(client) && isObservationSizeFailure(error) && this.currentConnection(project, client) && client.ready) {
        project.observationErrors ??= {};
        project.observationErrors[threadId] = { connectionGeneration: project.connectionGeneration,
          code: 'RESPONSE_TOO_LARGE', message: '聊天历史超过当前支持的 64 MiB，无法完整加载。', retryable: false };
        this.onChange();
        if (client.capabilities?.methods?.includes('areal/subscription/remove')) {
          try { await client.request('areal/subscription/remove', { threadIds: [threadId] }, { timeoutMs: 2500 }); }
          catch (removeError) {
            if (!this.currentConnection(project, client) || !client.ready) throw removeError;
          }
        }
      }
      throw error;
    }
  }

  supportsBrowser(project) {
    const capabilities = project.client?.capabilities;
    return capabilities?.methods?.includes('areal/thread/observe')
      && capabilities?.methods?.includes('areal/thread/tools/attach')
      && capabilities?.features?.browserToolAttachment === true
      && capabilities?.browserToolBundles?.some(bundle => bundle.bundleId === 'areal.browser.v1');
  }

  async ensureBrowserTools(project, threadId) {
    if (!this.supportsBrowser(project)) return;
    const client = project.client;
    const { thread } = await this.readObservation(project, threadId, { client });
    this.requireConnection(project, client);
    if (thread.desktop?.archived || thread.parentThreadId || thread.conversation?.kind === 'side' || thread.status?.type !== 'idle') return;
    // 固定工具包追加也安全重连原空闲 ToolHost；
    // Core 拒绝不同的在线所有者，并保留全部既有工具定义。
    await this.submit(project, 'areal/thread/tools/attach', {
      threadId, expectedToolsetRevision: thread.toolsetRevision ?? 0, bundleId: 'areal.browser.v1',
    });
    await this.readObservation(project, threadId, { client });
    this.requireConnection(project, client);
  }

  async bindBrowserHostForClaim(project, threadId) {
    const client = project.client;
    if (!client?.capabilities?.methods?.includes('areal/thread/observe')) {
      throw new Error('当前 Core 不支持安全观察已有聊天；请更新 Core 后重新连接');
    }
    // A local, explicit page claim may rebind an idle host. Read Core's
    // current state first; the Core checks idle state and host ownership again.
    const observed = await this.readObservation(project, threadId, { client });
    this.requireConnection(project, client);
    const thread = observed.thread;
    if (!thread?.dynamicTools?.some(tool => tool.name === 'browser_v1')
      || thread.desktop?.archived || thread.status?.type !== 'idle') {
      throw new Error('聊天正在执行或浏览器未启用，请刷新后再认领页面');
    }
    await this.readObservation(project, threadId, { client, resume: true });
    this.requireConnection(project, client);
  }

  async refreshQueue(project, threadId, { client = project.client, timeoutMs, current = () => this.currentConnection(project, client) } = {}) {
    return client.request('areal/queue/list', { threadId }, {
      timeoutMs, onResult: queue => { if (current()) project.model.setQueue(threadId, queue); },
    });
  }

  async editQueue(project, request) {
    const { threadId, operation, expectedRevision } = request;
    if (!['update', 'remove', 'reorder', 'pause', 'resume', 'steer'].includes(operation)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('无效队列操作');
    const params = { threadId, expectedRevision };
    if (operation === 'update' || operation === 'remove' || operation === 'steer') {
      if (typeof request.queueItemId !== 'string' || !request.queueItemId) throw new Error('缺少排队消息');
      params.queueItemId = request.queueItemId;
    }
    if (operation === 'update') {
      const retained = request.retainedInput ?? [];
      const original = project.model.state.queues[threadId]?.items.find(item => item.id === request.queueItemId);
      if (!Array.isArray(retained) || retained.length > 16 || retained.some(part => part.type === 'text'
        || !original?.input.some(input => isDeepStrictEqual(input, part)))) throw new Error('排队附件引用已变化，请核对原消息');
      const changed = request.text?.trim() || request.attachments?.length || request.mcpContent?.length ? messageInput(this, request) : [];
      params.input = [...changed.filter(part => part.type === 'text'), ...retained, ...changed.filter(part => part.type !== 'text')];
      if (!params.input.length || params.input.filter(part => part.type !== 'text').length > 16) throw new Error('排队消息不能为空，且最多 16 个附件');
    }
    if (operation === 'steer') {
      if (typeof request.expectedTurnId !== 'string' || !request.expectedTurnId) throw new Error('缺少目标活动轮次');
      params.expectedTurnId = request.expectedTurnId;
    }
    if (operation === 'reorder') {
      if (!Array.isArray(request.queueItemIds) || request.queueItemIds.length > 128
        || request.queueItemIds.some(id => typeof id !== 'string')
        || new Set(request.queueItemIds).size !== request.queueItemIds.length) throw new Error('无效队列顺序');
      params.queueItemIds = request.queueItemIds;
    }
    try {
      const result = await this.submit(project, `areal/queue/${operation}`, params, { requestId: request.requestId });
      if (operation === 'steer') {
        // 转移收据只保存绑定 ID 和版本，不把完整队列复制到每张收据。
        await this.refreshQueue(project, threadId).catch(() => {});
      } else project.model.setQueue(threadId, result);
      this.onChange();
      return result;
    } catch (error) {
      // 冲突只刷新展示，不用新 revision 重放用户的旧操作。
      await this.refreshQueue(project, threadId).catch(() => {});
      throw error;
    }
  }

  textInput(text) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024) throw new Error('请输入有效任务内容（最多 64 KiB）');
    return [{ type: 'text', text }];
  }

  async refreshConfiguration(project, threadId, { client = project.client, timeoutMs, current = () => this.currentConnection(project, client) } = {}) {
    let result;
    if (project.model.state.threads[threadId]?.conversation?.kind === 'side') {
      // Side cannot call the ordinary execution inspection route. Its read snapshot
      // supplies the same authoritative configuration and active-turn precondition.
      const { thread } = this.supportsBoundedHistory(client)
        ? await this.readObservation(project, threadId, { client, timeoutMs, current, install: false })
        : await client.request('thread/read', { threadId, includeTurns: true }, { timeoutMs });
      if (thread?.id !== threadId || thread.conversation?.kind !== 'side') throw new Error('Side 配置快照与目标会话不匹配');
      result = { configuration: thread.desktop?.configuration,
        activeTurnId: thread.turns?.find(turn => turn.status === 'inProgress')?.id };
    } else result = await client.request('areal/thread/inspect', { threadId }, { timeoutMs });
    this.requireConnection(project, client);
    if (!result?.configuration || !Number.isSafeInteger(result.configuration.revision)) {
      throw new Error('Core 未返回有效的会话配置，请重新打开任务');
    }
    if (!current()) throw Object.assign(new Error('观察归属已变化'), { code: 'STALE_CONNECTION' });
    project.configurations ??= {};
    project.configurations[threadId] = { ...result.configuration, modelName: result.modelName, resolvedParameters: result.resolvedParameters };
    this.onChange();
    return result;
  }

  async configureThread(project, threadId, request) {
    if (request.options?.permissionPreset !== undefined && project.client?.capabilities?.features?.permissionPresets !== true) {
      throw new Error('当前 Core 不支持权限模式，请更新后台后重试');
    }
    const token = randomUUID();
    project.configurationChanges ??= new Map();
    if (project.configurationChanges.has(threadId)) throw new Error('会话配置正在更新，请稍后重试');
    project.configurationChanges.set(threadId, token);
    try {
      await this.changePending(project, pending => {
        if (pending.some(value => !isRemoteControl(value) && value.params.threadId === threadId)) {
          throw new Error('该会话有未结算的请求结果，请先处理后再修改配置');
        }
        return pending;
      });
      if (request.model === undefined && request.profile === undefined && request.options === undefined && request.parameters === undefined && request.selectedSkills === undefined) {
        throw new Error('请选择需要修改的配置');
      }
      if (request.profile === null) {
        throw new Error('当前 Core 不支持清除已选择的 Profile');
      }
      if (request.selectedSkills !== undefined && (!Array.isArray(request.selectedSkills) || request.selectedSkills.some(skill => typeof skill?.id !== 'string' || !skill.id || typeof skill?.revision !== 'string' || !skill.revision))) {
        throw new Error('所选技能无效');
      }
      const inspection = await this.refreshConfiguration(project, threadId);
      if (inspection.activeTurnId) throw new Error('任务正在执行，完成或停止后才能修改配置');
      if (request.expectedRevision !== undefined && request.expectedRevision !== inspection.configuration.revision) throw new Error('会话配置已变化，请刷新后重新保存');
      const params = {
        threadId,
        expectedRevision: inspection.configuration.revision,
        ...(request.profile ? { agentProfile: request.profile } : {}),
        ...(request.model === null ? { resetModel: true } : request.model ? { model: request.model } : {}),
        ...(request.options !== undefined ? { options: { ...inspection.configuration.options, ...request.options } } : {}),
        ...(request.parameters !== undefined ? { parameters: request.parameters } : request.model !== undefined ? { parameters: {} } : {}),
        // 空数组是公开契约：清除会话覆盖并恢复 Profile，不是“不用任何技能”。
        ...(request.selectedSkills !== undefined ? { selectedSkills: request.selectedSkills.map(skill => ({ id: skill.id, revision: skill.revision })) } : {}),
      };
      const client = project.client;
      const configuration = await this.submit(project, 'areal/thread/configure', params, { requestId: request.requestId });
      if (this.currentConnection(project, client)) project.configurations[threadId] = { ...configuration,
        modelName: configuration.defaultModelRevision && configuration.defaultModelRevision === inspection.configuration.defaultModelRevision ? project.configurations[threadId]?.modelName : undefined };
      this.onChange();
    } catch (error) {
      try { await this.refreshConfiguration(project, threadId); }
      catch (refreshError) { this.observationFailure(project, threadId, refreshError); }
      throw error;
    } finally {
      if (project.configurationChanges.get(threadId) === token) {
        project.configurationChanges.delete(threadId);
      }
    }
  }

  changePending(project, change) {
    const task = (project.pendingWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      const before = project.pending;
      project.pending = change(before);
      this.onChange();
      try { await this.save(`${project.id}-pending.json`, project.pending); }
      catch (error) { project.pending = before; this.onChange(); throw error; }
      this.onChange();
    });
    project.pendingWrite = task;
    return task;
  }

  changeOutcomes(project, change) {
    const task = (project.outcomeWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      const next = change(project.outcomes ?? {});
      if (next === project.outcomes) return;
      await this.save(`${project.id}-outcomes.json`, next);
      project.outcomes = next; this.onChange();
    });
    project.outcomeWrite = task;
    return task;
  }

  async rememberWorkgroupOutcome(project, entry, value, planRevision = value.record.planRevision) {
    await this.changeOutcomes(project, outcomes => ({ ...outcomes, [entry.params.requestId]: {
      accepted: true, method: entry.method, workgroupId: value.id, planRevision,
    } }));
  }

  async recoverWorkgroupSubmission(project, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId && workgroupMutationMethods.has(item.method));
    if (entry && this.awaitingResponses.has(entry)) return null;
    let receipt = project.outcomes?.[requestId];
    if (!receipt?.workgroupId && entry?.method === 'areal/workgroup/revise') {
      const value = await project.client.request('areal/workgroup/read', { id: entry.params.id });
      const revision = value.record.revisions?.[requestId];
      if (revision && revision.planRevision === entry.params.expectedRevision + 1) {
        await this.rememberWorkgroupOutcome(project, entry, value, revision.planRevision);
        receipt = project.outcomes[requestId];
      }
    }
    // Creation has no public Core receipt lookup. An absent record is unknown,
    // never a reason to retry a mutation or identify a similar-looking group.
    if (!receipt?.workgroupId || !workgroupMutationMethods.has(receipt.method)) return null;
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return receipt;
  }

  async recoverProcessSubmission(project, threadId, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId);
    if (entry && (entry.method !== 'areal/process/start' || entry.params.threadId !== threadId || this.awaitingResponses.has(entry))) return null;
    const value = await project.client.request('areal/request/read', { threadId, requestId });
    const receipt = matchingReceipt(entry ?? { method: 'areal/process/start', params: { threadId, requestId } }, value.data, threadId);
    if (typeof receipt?.result?.id !== 'string') return null;
    const processes = await project.client.request('areal/process/list', { threadId });
    const process = processes.data.find(item => item.id === receipt.result.id);
    // A durable acceptance can precede actual process startup. Only attach once
    // it has a Runtime process, or confirmed cleanup proves it has ended.
    if (!process || (!process.processId && !process.cleanupConfirmed)) return null;
    // process/list includes historical epochs. Core's get validates the live
    // Runtime handle; an old/unavailable handle must not become an attached PTY.
    if (!process.cleanupConfirmed) await project.client.request('areal/process/get', { threadId, id: process.id });
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return { ...receipt.result, argv: process.argv, closed: process.cleanupConfirmed === true, controls: process.inputs.length };
  }

  async recoverAgentSubmission(project, parentThreadId, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId && item.method === 'areal/agent/spawn');
    if (entry && (this.awaitingResponses.has(entry) || entry.params.parentThreadId !== parentThreadId)) return null;
    const receipt = project.outcomes?.[requestId];
    if (receipt?.method !== 'areal/agent/spawn' || receipt.accepted !== true || receipt.parentThreadId !== parentThreadId
      || typeof receipt.threadId !== 'string' || typeof receipt.turnId !== 'string') return null;
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return receipt;
  }

  remoteRecord(project, association) {
    const matches = value => value?.remote && ['hostId', 'devicePeerId', 'projectId', 'commandId'].every(key => value.remote[key] === association[key]);
    return Object.values(project.outcomes ?? {}).find(matches) ?? project.pending.find(matches);
  }

  async readRemoteRecord(project, association, beforeReceipt) {
    // 将读取本身排在 pending 队列中，不能看见下一笔尚未落盘的临时内存。
    const read = (project.pendingWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      await project.outcomeWrite?.catch(() => {});
      return this.remoteRecord(project, association);
    });
    project.pendingWrite = read;
    const entry = await read;
    return entry ? this.recoverRemoteSubmission(project, entry, beforeReceipt) : null;
  }

  async rememberRemoteOutcome(project, entry, result, error) {
    const taskReply = entry.method === 'areal/channel/reply' && entry.remote.method === 'task.question.reply';
    const taskPause = entry.method === 'areal/task/pause' && entry.remote.method === 'task.pause';
    let receipt;
    if (entry.method === 'areal/goal/create' && !error) {
      if (typeof result?.goal?.id !== 'string' || !Number.isSafeInteger(result.revision)) throw new Error('目标受理结果不完整');
      receipt = {goalId:result.goal.id,revision:result.revision};
    }
    if (taskPause && !error) {
      if (result?.id !== entry.params.taskId || result.paused !== true || result.runs?.at(-1)?.id !== entry.params.expectedRunId
        || !Number.isSafeInteger(result.revision) || result.revision !== entry.params.expectedRevision + 1) throw new Error('Task 暂停受理结果不完整');
      receipt = { taskId: result.id, runId: entry.params.expectedRunId, revision: result.revision, paused: true };
    }
    if (taskReply && !error) {
      if (result?.accepted !== true || ['messageId', 'taskId', 'runId'].some(key => typeof result[key] !== 'string' || !result[key] || Buffer.byteLength(result[key]) > 128)
        || result.taskId !== entry.params.taskId || result.runId !== entry.params.runId
        || !Number.isSafeInteger(result.channelSequence) || result.channelSequence < 1) throw new Error('Task 原生受理结果不完整');
      receipt = { accepted: true, messageId: result.messageId, taskId: result.taskId, runId: result.runId, channelSequence: result.channelSequence };
    }
    const threadId = taskReply || taskPause ? undefined : entry.params.threadId ?? result?.thread?.id;
    const turnId = taskReply || taskPause ? undefined : ['turn/interrupt', 'areal/interaction/respond'].includes(entry.method) ? entry.params.turnId : result?.turn?.id;
    if ((threadId !== undefined && (typeof threadId !== 'string' || Buffer.byteLength(threadId) > 128))
      || (turnId !== undefined && (typeof turnId !== 'string' || Buffer.byteLength(turnId) > 128))) throw new Error('原生关联超过预算');
    if (!error && !taskReply && !taskPause && (typeof threadId !== 'string' || (entry.method === 'areal/turn/start' && typeof turnId !== 'string')))
      throw new Error('原生受理结果不完整');
    const outcome = { operationId: entry.operationId, remote: entry.remote, method: entry.method,
      accepted: !error, admissionState: error ? 'rejected' : 'accepted', ...(receipt ? { receipt } : {}),
      ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}),
      ...(error ? { error: { code: error.code ?? 'CORE_UNAVAILABLE', ...(typeof (error.coreCode ?? error.code) === 'number' ? { coreCode: error.coreCode ?? error.code } : {}) } } : {}) };
    if (Buffer.byteLength(JSON.stringify(outcome)) > 4096) throw new Error('受理结果超过预算');
    // 终态先落盘，再移除 pending；并发查询不能覆盖已保存的完整关联。
    await this.changeOutcomes(project, outcomes => outcomes[entry.operationId]?.remote ? outcomes : { ...outcomes, [entry.operationId]: outcome });
    try { await this.changePending(project, pending => pending.filter(value => value.operationId !== entry.operationId)); }
    catch { /* 已落盘终态优先；遗留 pending 可在下次只读查询时清理。 */ }
    return project.outcomes[entry.operationId];
  }

  async recoverRemoteSubmission(project, entry, beforeReceipt) {
    const known = project.outcomes?.[entry.operationId];
    if (known?.remote) {
      if (project.pending.some(value => value.operationId === entry.operationId)) {
        try { await this.changePending(project, pending => pending.filter(value => value.operationId !== entry.operationId)); } catch {}
      }
      return known;
    }
    if (this.awaitingResponses.has(entry) || !project.client?.ready || project.client.closed || !project.model?.state?.connected)
      return entry;
    if (!['areal/thread/start', 'areal/turn/start', 'areal/turn/submit', 'areal/turn/enqueue', 'areal/thread/configure', ...['update','remove','reorder','pause','resume','steer'].map(op => `areal/queue/${op}`), ...['create','pause','resume','clear'].map(op => `areal/goal/${op}`)].includes(entry.method)) return entry;
    const client = project.client, generation = project.service?.generation;
    try {
      beforeReceipt?.(entry);
      // 精确查询原生键，不打开 Thread、不配置、不重放；离线只返回已有日志。
      const value = await client.request('areal/request/read', { requestId: entry.params.requestId,
        ...(entry.method !== 'areal/thread/start' ? { threadId: entry.params.threadId } : {}) });
      if (project.client !== client || project.service?.generation !== generation) return entry;
      const receipt = matchingReceipt(entry, value.data, entry.method !== 'areal/thread/start' ? entry.params.threadId : undefined);
      const response = entry.method === 'areal/thread/start' && typeof receipt?.threadId === 'string'
        ? { result: { thread: { id: receipt.threadId } } }
        : receipt?.result ? { result: receipt.result }
        : receipt?.state === 'completed' ? receipt.response : undefined;
      if (response?.error && !explicitRejection(response.error.data ?? response.error)) return entry;
      if (response) return await this.rememberRemoteOutcome(project, entry, response.result, response.error);
    } catch { /* 查询失败或空收据都不能证明未执行。 */ }
    return project.outcomes?.[entry.operationId] ?? entry;
  }

  async submitRemote(project, method, parameters, remote, dispatch) {
    const operationId = randomUUID();
    // interrupt 无请求键，respond 的 requestId 是交互领域标识；日志 UUID 不得覆盖它们。
    const entry = { method, operationId, params: { ...structuredClone(parameters), ...(['turn/interrupt', 'turn/steer', 'areal/interaction/respond'].includes(method) ? {} : { requestId: operationId }) }, remote: structuredClone(remote) };
    if (Buffer.byteLength(JSON.stringify(entry)) > 72 * 1024)
      throw Object.assign(new Error('提交记录超过预算'), { code: 'LIMIT_EXCEEDED' });
    let original;
    this.awaitingResponses.add(entry);
    try {
      await this.changePending(project, pending => {
        original = this.remoteRecord(project, remote);
        if (original) {
          if (original.remote.semanticDigest !== remote.semanticDigest)
            throw Object.assign(new Error('命令标识已用于不同内容'), { code: 'COMMAND_CONFLICT' });
          return pending;
        }
        if (pending.length + Object.keys(project.outcomes ?? {}).length >= 4096)
          throw Object.assign(new Error('提交日志容量已满'), { code: 'CAPACITY_EXCEEDED' });
        if (!['turn/interrupt', 'areal/interaction/respond'].includes(method) && parameters.threadId && project.configurationChanges?.has(parameters.threadId))
          throw Object.assign(new Error('会话配置正在变化'), { code: 'TARGET_CHANGED' });
        if (!['turn/interrupt', 'areal/interaction/respond'].includes(method) && parameters.threadId && pending.some(value => !isRemoteControl(value) && value.params.threadId === parameters.threadId && !(value.remote && project.outcomes?.[value.operationId]?.remote)))
          throw Object.assign(new Error('此会话有未结算提交'), { code: 'SUBMISSION_UNKNOWN', submissionUnknown: true });
        return [...pending, entry];
      });
      if (original) return this.recoverRemoteSubmission(project, original);
      let result, error;
      try { result = await dispatch(entry); }
      catch (cause) {
        if (cause.submissionUnknown || cause.code === -32603) return entry;
        error = cause;
      }
      try { return await this.rememberRemoteOutcome(project, entry, result, error); }
      catch { return entry; }
    } finally {
      this.awaitingResponses.delete(entry);
      this.scheduleReconciliation(project);
      this.onChange();
    }
  }

  async submit(project, method, parameters, { requestId, remote, dispatch } = {}) {
    const observationError = project.observationErrors?.[parameters.threadId];
    if (observationError && ['areal/turn/start', 'areal/turn/enqueue', 'areal/turn/submit', 'turn/start', 'turn/steer', 'areal/queue/resume', 'areal/queue/steer', 'areal/goal/create', 'areal/goal/resume'].includes(method)) {
      throw Object.assign(new Error(observationError.message), { code: observationError.code, submissionUnknown: false });
    }
    if (remote) return this.submitRemote(project, method, parameters, remote, dispatch);
    const semantics = project.client?.capabilities?.methodSemantics?.[method];
    if (semantics && semantics.effect !== 'mutation') throw new Error('此方法不是业务写入');
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId))) throw new Error('无效请求标识');
    const params = { ...parameters, requestId: requestId ?? randomUUID() };
    const entry = { method, params, operation: operationOf(method, params) };
    // 活跃请求仅保存在内存；重启后仍在恢复日志中的请求应显示为结果未知。
    this.awaitingResponses.add(entry);
    try {
      // 检查与持久化在同一队列中，两个同时到达的发送不能穿透阻塞。
      await this.changePending(project, pending => {
        if (project.outcomes?.[params.requestId] || pending.some(value => value.params.requestId === params.requestId)) throw new Error('请求标识已使用，请核对原提交；不会重复执行。');
        if (method !== 'areal/thread/configure' && project.configurationChanges?.has(parameters.threadId)) {
          throw new Error('会话配置正在更新，请稍后再发送任务');
        }
        const conflicting = ['areal/thread/fork', 'areal/side/start'].includes(method)
          ? pending.find(value => value.method === method && value.params.sourceThreadId === parameters.sourceThreadId)
          : pending.find(value => !isRemoteControl(value) && (parameters.taskId ? value.params.taskId === parameters.taskId : parameters.threadId ? value.params.threadId === parameters.threadId : false) && !(value.remote && project.outcomes?.[value.operationId]?.remote));
        if (conflicting) {
          const awaiting = this.awaitingResponses.has(conflicting);
          throw Object.assign(new Error(awaiting
            ? '当前操作正在等待响应，请稍后再试'
            : '上一次提交结果未知，请先查询受理结果'),
          awaiting ? {} : { submissionUnknown: true, requestId: conflicting.params.requestId });
        }
        return [...pending, entry];
      });
      let result, dispatchStarted = false;
      try {
        if (this.closing) throw new Error('应用正在退出');
        dispatchStarted = true;
        result = await this.requestSubmission(project, method, params);
      }
      catch (error) {
        if (!dispatchStarted || explicitRejection(error)) {
          try { await this.changePending(project, pending => pending.filter(value => value !== entry)); }
          catch { throw Object.assign(new Error('原请求结果已知，但恢复日志更新失败；请检查本机存储'), { submissionUnknown: true, requestId: params.requestId, outcome: { kind: 'unconfirmed', operation: entry.operation }, recovery: { kind: 'queryOriginal' } }); }
        }
        if (dispatchStarted && !explicitRejection(error)) Object.assign(error, {
          submissionUnknown: true, outcome: error.outcome ?? { kind: 'unconfirmed', operation: entry.operation },
          recovery: error.recovery ?? { kind: 'queryOriginal' },
        });
        error.requestId = params.requestId;
        throw error;
      }
      try {
        if (workgroupMutationMethods.has(method)) await this.rememberWorkgroupOutcome(project, entry, result);
        else if (requestId !== undefined || ['areal/turn/submit', 'areal/agent/spawn'].includes(method))
          await this.rememberOutcome(project, entry, { status: 'completed', result });
        await this.changePending(project, pending => pending.filter(value => value !== entry));
      } catch {
        project.refreshErrors ??= {};
        project.refreshErrors[params.requestId] = { id: randomUUID(), projectId: project.id,
          connectionGeneration: project.connectionGeneration, operation: entry.operation,
          message: 'Core 已受理，本机恢复记录尚未更新。', refreshPending: true };
      }
      try { await this.providers.acceptModelSelection(result?.lastAcceptedModel); }
      catch (error) {
        project.refreshErrors ??= {};
        project.refreshErrors[params.requestId] ??= { id: randomUUID(), projectId: project.id, scope: 'modelSelection',
          connectionGeneration: project.connectionGeneration, operation: entry.operation,
          message: this.providers.redact(error.message), refreshPending: false };
      }
      return result;
    } finally {
      this.awaitingResponses.delete(entry);
      this.scheduleReconciliation(project);
      this.onChange();
    }
  }

  async processControlOutcome(project, params, result, cause) {
    let value;
    try { value = await project.client.request('areal/process/list', { threadId: params.threadId }); }
    catch { throw Object.assign(new Error('无法核对终端执行结果；不会重发输入'), { submissionUnknown: true }); }
    const operation = value.data.find(p => p.id === params.id)?.inputs?.find(op => op.operationId === result.operationId);
    if (operation?.outcome === 'succeeded') return result;
    if (operation?.outcome === 'failed') throw Object.assign(cause ?? new Error('终端操作执行失败；请检查进程状态'), { executionFailed: true });
    throw Object.assign(new Error('终端操作执行结果未确认；不会重发输入'), { submissionUnknown: true });
  }

  async requestSubmission(project, method, params) {
    const client = project.client;
    if (method === 'areal/blob/release') {
      let current;
      try { current = this.supportsBoundedHistory(project.client)
        ? await this.readObservation(project, params.threadId, { install: false })
        : await project.client.request('thread/read', { threadId: params.threadId, includeTurns: false }); }
      catch (error) { throw Object.assign(new Error(`无法核对附件所属会话：${error.message}`), { outcome: { kind: 'rejected' } }); }
      if (current.thread.desktop?.archived) throw Object.assign(new Error('归档会话只读，不能释放附件'), { outcome: { kind: 'rejected' } });
    }
    const { requestId, previousItems, ...steer } = params;
    const { threadId, ...spawn } = steer;
    const durableSteer = project.client.capabilities?.methods?.includes('areal/plugin/hooks/list');
    try {
      return await project.client.request(method, method === 'areal/agent/spawn' ? spawn
        : method === 'turn/steer' ? { ...steer, ...(durableSteer ? { requestId } : {}) } : params,
      ['areal/marketplace/addGit', 'areal/marketplace/update'].includes(method) ? { timeoutMs: 120000 } : undefined);
    } catch (error) {
      if (explicitRejection(error)) throw error;
      const entry = { method, params, operation: operationOf(method, params) };
      if (workgroupMutationMethods.has(method) || method === 'areal/agent/spawn') throw error;
      const client = project.client;
      let receipt;
      try { receipt = await this.readReceipt(project, entry, client); } catch {  }
      if (receipt && receiptStatus(receipt) === 'completed') {
        const result = receiptResult(receipt);
        if (processControls.has(method)) return this.processControlOutcome(project, params, result, error);
        if (creationTargets.get(method) === 'thread' && !result?.thread) {
          const id = receipt.threadId ?? result?.threadId;
          if (id) return { thread: { id }, requestId };
        }
        return result;
      }
      if (receipt && receiptStatus(receipt) === 'failed') {
        const failure = receipt.error ?? receipt.response?.error;
        Object.assign(error, { message: failure?.message ?? error.message, outcome: { kind: 'admitted', operation: receipt.operation ?? entry.operation } });
      }
      Object.assign(error, { requestId, submissionUnknown: true, outcome: error.outcome ?? { kind: 'unconfirmed', operation: entry.operation },
        recovery: error.recovery ?? { kind: 'queryOriginal' } });
      throw error;
    }
  }

  async readReceipt(project, entry, client, timeoutMs = 2500) {
    const family = client.capabilities?.methodSemantics?.[entry.method]?.receipt;
    const scopedThreadId = entry.params.threadId && (family ? family === 'thread' : !managementMethods.has(entry.method) && !taskMutationMethods.has(entry.method)) ? entry.params.threadId : undefined;
    const result = await client.request('areal/request/read', { requestId: entry.params.requestId,
      ...(scopedThreadId ? { threadId: scopedThreadId } : {}) }, { timeoutMs });
    this.requireConnection(project, client);
    return matchingReceipt(entry, result.data, scopedThreadId);
  }

  async readSubmission(project, method, params) {
    const client = project.client, generation = project.connectionGeneration;
    const pending = project.pending.find(entry => entry.method === method && entry.params.requestId === params.requestId);
    if (pending && this.awaitingResponses.has(pending)) return { confirmed: false, state: 'admitted' };
    const known = project.outcomes?.[params.requestId];
    const entry = pending ?? { method, params, ...(known?.method === method && known.operation ? { operation: known.operation } : {}) };
    const receipt = await this.readReceipt(project, entry, client);
    const current = () => this.currentConnection(project, client) && project.connectionGeneration === generation;
    if (!current()) throw Object.assign(new Error('连接已换代'), { code: 'STALE_CONNECTION' });
    const status = receipt && receiptStatus(receipt);
    if (!['completed', 'failed'].includes(status)) return { confirmed: false, state: status ?? 'unconfirmed' };
    if (pending) {
      await this.rememberOutcome(project, entry, receipt, current);
      if (current()) await this.changePending(project, entries => current() ? entries.filter(value => value !== pending) : entries);
    }
    const failure = receipt.error ?? receipt.response?.error;
    const error = failure ? desktopError(failure) : undefined;
    return { confirmed: true, accepted: true, status, operation: receipt.operation ?? entry.operation,
      ...(error ? { error, message: error.message } : { result: receiptResult(receipt) }) };
  }

  async rememberOutcome(project, entry, receipt, current = () => true) {
    const result = receiptResult(receipt), failure = receipt.error ?? receipt.response?.error;
    const status = receiptStatus(receipt);
    const threadId = entry.method === 'areal/agent/spawn' ? result?.threadId : entry.params.threadId ?? receipt.threadId ?? result?.threadId ?? result?.thread?.id;
    const taskId = entry.params.taskId ?? receipt.taskId ?? (taskMutationMethods.has(entry.method) ? result?.id : undefined);
    const operation = receipt.operation ?? { ...(entry.operation ?? operationOf(entry.method, entry.params)),
      ...(creationTargets.get(entry.method) === 'thread' && threadId ? { target: { kind: 'thread', threadId } }
        : creationTargets.get(entry.method) === 'task' && taskId ? { target: { kind: 'task', taskId } } : {}) };
    await this.changeOutcomes(project, outcomes => {
      if (!current()) return outcomes;
      return { ...outcomes, [entry.params.requestId]: { accepted: true, status, operation, method: entry.method,
        ...(threadId ? { threadId } : {}), ...(taskId ? { taskId } : {}),
        ...(entry.params.sourceThreadId ? { sourceThreadId: entry.params.sourceThreadId } : {}),
        ...(entry.params.parentThreadId ? { parentThreadId: entry.params.parentThreadId } : {}),
        ...(result?.turnId ?? result?.turn?.id ? { turnId: result.turnId ?? result.turn.id } : {}),
        ...(entry.method === 'turn/steer' && entry.params.input ? { input: entry.params.input } : {}),
        ...(failure ? { message: this.providers.redact(failure.message) } : {}),
        ...(['areal/queue/update', 'areal/queue/pause', 'areal/queue/resume', 'areal/queue/remove', 'areal/queue/reorder'].includes(entry.method) && Number.isSafeInteger(result?.revision) ? { result: { revision: result.revision } } : {}),
      } };
    });
    return { result, threadId, taskId, status };
  }

  reconciliationCurrent(project, client, generation) {
    return this.currentConnection(project, client) && client.ready && project.connectionGeneration === generation
      && !this.lifecycleOperations?.activeRequestId && !this.lifecycleOperations?.activeTargets.has(project.id)
      && !this.lifecycleOperations?.blocking(project.id);
  }

  stopReconciliation(project) {
    clearTimeout(project.reconciliation?.timer);
    project.reconciliation = null;
  }

  scheduleReconciliation(project) {
    const client = project.client, generation = project.connectionGeneration;
    if (!project.pending?.length || !this.reconciliationCurrent(project, client, generation)) return;
    const previous = project.reconciliation;
    if (previous?.client === client && previous.generation === generation && (previous.timer || previous.running)) return;
    this.stopReconciliation(project);
    const worker = project.reconciliation = { client, generation, deadline: Date.now() + 30000, attempt: 0, running: false };
    const current = () => project.reconciliation === worker && this.reconciliationCurrent(project, client, generation);
    const schedule = () => {
      const delay = reconciliationDelays[Math.min(worker.attempt++, reconciliationDelays.length - 1)];
      if (!current() || !project.pending.length || Date.now() + delay >= worker.deadline) return;
      worker.timer = setTimeout(async () => {
        worker.timer = null;
        if (!current()) return;
        worker.running = true;
        try { await this.reconcile(project, { client, generation, deadline: worker.deadline }); }
        catch {  }
        finally { worker.running = false; schedule(); }
      }, delay);
      worker.timer.unref?.();
    };
    schedule();
  }

  reconcile(project, options = {}) {
    const client = options.client ?? project.client, generation = options.generation ?? project.connectionGeneration;
    const previous = project.reconciliationRead;
    if (previous?.client === client && previous.generation === generation) return previous.promise;
    const pass = { client, generation };
    pass.promise = this.reconcileEntries(project, { ...options, client, generation }).finally(() => {
      if (project.reconciliationRead === pass) project.reconciliationRead = null;
    });
    project.reconciliationRead = pass;
    return pass.promise;
  }

  async reconcileEntries(project, { client, generation, deadline = Date.now() + 30000 }) {
    const current = () => this.reconciliationCurrent(project, client, generation);
    for (const entry of [...project.pending]) {
      if (!current() || Date.now() >= deadline) break;
      if (this.awaitingResponses.has(entry)) continue;
      try {
        if (entry.remote) { await this.recoverRemoteSubmission(project, entry); continue; }
        if (workgroupMutationMethods.has(entry.method)) { await this.recoverWorkgroupSubmission(project, entry.params.requestId); continue; }
        if (entry.method === 'areal/agent/spawn') { await this.recoverAgentSubmission(project, entry.params.parentThreadId, entry.params.requestId); continue; }
        if (entry.method === 'turn/steer' && !client.capabilities?.methods?.includes('areal/plugin/hooks/list')
          && !client.capabilities?.features?.operationOutcomes) {
          await this.openThread(project, entry.params.threadId);
          if (!current()) break;
          const turn = project.model.state.threads[entry.params.threadId]?.turns.find(item => item.id === entry.params.expectedTurnId);
          const normalize = input => input.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: part.type, url: part.url });
          const accepted = turn?.items.some(item => item.type === 'userMessage' && !entry.params.previousItems.includes(item.id)
            && JSON.stringify(normalize(item.content)) === JSON.stringify(normalize(entry.params.input)));
          if (accepted) {
            await this.rememberOutcome(project, entry, { status: 'completed', result: { turnId: turn.id } }, current);
            if (current()) await this.changePending(project, pending => current() ? pending.filter(value => value !== entry) : pending);
          }
          continue;
        }
        if (entry.localOnly) { await this.refreshConfiguration(project, entry.params.threadId); continue; }
        let receipt = await this.readReceipt(project, entry, client, Math.min(2500, Math.max(1, deadline - Date.now())));
        if (!current() || this.awaitingResponses.has(entry) || !project.pending.includes(entry) || !receipt) continue;
        if (!['completed', 'failed'].includes(receiptStatus(receipt))) continue;
        if (processControls.has(entry.method) && receiptStatus(receipt) === 'completed') {
          try { await this.processControlOutcome(project, entry.params, receiptResult(receipt)); }
          catch (error) { if (!error.executionFailed) throw error; receipt = { ...receipt, status: 'failed', error: { message: error.message } }; }
        }
        if (!current()) break;
        const outcome = await this.rememberOutcome(project, entry, receipt, current);
        if (!current()) break;
        await this.changePending(project, pending => current() ? pending.filter(value => value !== entry) : pending);
        if (!current()) break;
        delete project.refreshErrors?.[entry.params.requestId];
        if (outcome.status === 'completed') {
          if (entry.method === 'areal/thread/configure') project.configurations[entry.params.threadId] = outcome.result;
          if (taskMutationMethods.has(entry.method) && !['areal/channel/reply', 'areal/task/runNow'].includes(entry.method)) project.model.setTask(outcome.result);
          await this.providers.acceptModelSelection(outcome.result?.lastAcceptedModel).catch(() => {});
          void this.refreshAfterAdmission(project, outcome.threadId, receipt.operation ?? entry.operation).catch(() => {});
        }
      } catch (error) {
        if (!current()) break;
        project.refreshErrors ??= {};
        project.refreshErrors[entry.params.requestId ?? `legacy:${entry.params.threadId}`] = { id: randomUUID(), projectId: project.id,
          connectionGeneration: generation, operation: entry.operation, message: this.providers.redact(error.message), refreshPending: true };
        this.onChange();
      }
    }
  }

  async command(name, request, context = {}) {
    const semantics = commandSemantics(name, request);
    if (name === 'history' && request.operation === 'release') {
      const project = this.projects.get(request.projectId);
      return project ? this.historyCommand(project, request) : { released: true };
    }
    if (semantics.requestId && !request[semantics.requestId]) request = { ...request, [semantics.requestId]: randomUUID() };
    if (name === 'stop') {
      const project = this.projects.get(request.projectId);
      if (!project?.service || !project.client?.ready) throw Object.assign(new Error('原 Core 连接不可用，不能中断轮次'), { code: 'LIFECYCLE_INCOMPLETE' });
      return this.lifecycleOperations.request({ requestId: request.requestId, kind: 'interruptTurn', mode: 'cancel',
        expectedDesktopGeneration: this.lifecycleOperations.generation,
        expectedTargets: [{ projectId: request.projectId, serviceId: project.service.serviceId, generation: project.service.generation }],
        threadId: request.threadId, turnId: request.turnId });
    }
    const lifecycleBlock = this.lifecycleOperations.blocking(request?.projectId, request?.threadId);
    if ((lifecycleBlock || this.lifecycleOperations.activeRequestId || this.lifecycleOperations.activeTargets.has(request?.projectId))
      && (['open', 'list', 'connect'].includes(name) || require('./lifecycle.cjs').isRecoveryCommand(name, request))) {
      const project = this.projects.get(request.projectId);
      if (!project?.service || !project.client?.ready) throw Object.assign(new Error('原 Core 已断开，不能确认核查目标'), { code: 'LIFECYCLE_INCOMPLETE' });
      const original = lifecycleBlock?.targets.find(target => target.projectId === request.projectId);
      if (original && (project.service.serviceId !== original.serviceId || project.service.generation !== original.generation))
        throw Object.assign(new Error('原 Core 代际已变化，不能用新实例代替核查'), { code: 'CONFIRMATION_STALE' });
      if (name === 'history') return this.historyCommand(project, request);
      if (name === 'manage') return manage(this, project, request, context);
      if (name === 'open') await this.openThread(project, request.threadId);
      if (name === 'list') await this.listThreads(project);
      return this.snapshot();
    }
    this.lifecycleOperations.assertProject(request?.projectId, request?.threadId);
    if (this.closing && require('./lifecycle.cjs').isRecoveryCommand(name, request)) {
      const project = this.projects.get(request.projectId);
      if (!project?.service || !project.client?.ready) throw new Error('原 Core 已断开，不能确认核查目标');
      if (name === 'history') return this.historyCommand(project, request);
      return manage(this, project, request, context);
    }
    if (this.closing) throw new Error('应用正在退出');
    if (name === 'analytics') return this.analytics.command(request);
    // 后台只读状态不占任务或配置准入；参数仍由轨迹能力校验。
    if (name === 'trajectory' && request?.operation === 'status') return this.trajectory.command(request);
    if (name === 'trajectory' && request?.operation === 'setEnabled') return this.trajectory.setEnabled(request);
    if (name === 'feedback' && request?.operation === 'status') return this.feedback.command(request);
    if (name === 'chatgpt') return this.providers.chatgpt(request);
    if (name === 'providers') return this.providers.command(request);
    if (name === 'resources') return this.resources.command(request);
    if (this.providerUpdating || this.resourcesUpdating) throw new Error('配置正在应用，请稍后重试');
    this.activeCommands++;
    try { return await this.executeCommand(name, request, context); }
    finally { this.activeCommands--; }
  }

  async executeCommand(name, request, context = {}) {
    if (this.closing) throw new Error('应用正在退出');
    if (name === 'trajectory') return this.trajectory.command(request);
    if (name === 'feedback') return this.feedback.command(request);
    if (name === 'tasks') return taskCatalog(this, request);
    if (name === 'projectless') return this.projectless.command(request);
    if (name === 'library') return this.library.command(request);
    if (name === 'workspace') return workspaceCommand(this, request);
    const { projectId, threadId } = request;
    const project = await this.start(projectId);
    if (this.closing) throw new Error('应用正在退出');
    switch (name) {
      case 'connect': return this.snapshot();
      case 'prepareCreator': return this.resources.prepareCreator(project, request.profile);
      case 'dismissRecovery': {
        await this.changeOutcomes(project, previous => { const outcomes = { ...previous }; if (!outcomes[request.requestId]?.remote) delete outcomes[request.requestId]; return outcomes; }); break;
      }
      case 'media': return mediaCommand(project, request, this);
      case 'manage':
        if (isTaskDraftConfiguration(project.configurations?.[threadId]) && request.operation?.startsWith('goal')) {
          throw new Error('任务管理会话不执行目标；请在会话中描述要调整的定时任务。');
        }
        return manage(this, project, request, context);
      case 'list': await this.listThreads(project); break;
      case 'open': await this.openThread(project, threadId); break;
      case 'history': return this.historyCommand(project, request);
      case 'attachBrowser': {
        if (!project.client.capabilities?.methods?.includes('areal/thread/tools/attach')
          || project.client.capabilities?.features?.browserToolAttachment !== true
          || !project.client.capabilities?.browserToolBundles?.some(bundle => bundle.bundleId === 'areal.browser.v1')) {
          throw new Error('当前 Core 不支持在已有聊天启用浏览器');
        }
        const existing = project.model.state.threads[threadId];
        if (!existing || existing.desktop?.archived || existing.status?.type !== 'idle'
          || existing.toolsetRevision !== request.expectedToolsetRevision && (existing.toolsetRevision ?? 0) !== request.expectedToolsetRevision) {
          throw new Error('聊天状态或工具版本已变化，请刷新后重试');
        }
        const result = await this.submit(project, 'areal/thread/tools/attach', {
          threadId, expectedToolsetRevision: request.expectedToolsetRevision, bundleId: 'areal.browser.v1',
        }, { requestId: request.requestId });
        await this.refreshAfterAdmission(project, threadId, operationOf('areal/thread/tools/attach', request));
        return result;
      }
      case 'configure': {
        if (isTaskDraftConfiguration(project.configurations?.[threadId])
          && (request.options !== undefined || request.profile !== undefined)) {
          throw new Error('任务管理会话的执行限制不能修改；请在会话中描述要调整的任务。');
        }
        await this.configureThread(project, threadId, request); break;
      }
      case 'queue': {
        if (!request.requestId) return this.refreshQueue(project, threadId);
        if (typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.requestId)
          || !['update','remove','reorder','pause','resume','steer'].includes(request.operation)) throw new Error('无效队列收据查询');
        const method = `areal/queue/${request.operation}`;
        return this.readSubmission(project, method, { requestId: request.requestId, threadId });
      }
      case 'queueEdit': return this.editQueue(project, request);
      case 'create': {
        if (project.client?.capabilities?.features?.permissionPresets !== true) {
          throw new Error('当前 Core 不支持权限模式，请更新后台后创建聊天');
        }
        if (request.browserEnabled === true
          && projectCoreCapabilities(this.binary, project.client?.capabilities).features?.browserToolAttachment !== true) {
          throw new Error('当前 Core 不支持新聊天启用浏览器');
        }
        await this.resources.beforeCreate(project);
        const { thread } = await this.submit(project, 'areal/thread/start', { cwd: project.root,
          ...(this.supportsBrowser(project) ? { dynamicTools: [browserTool] } : {}),
          ...(request.parameters ? { parameters: request.parameters } : {}),
          options: { permissionPreset: 'ask', ...request.options },
          ...(request.model ? { model: request.model } : {}),
          ...((request.profile ?? project.resourceProfile ?? this.defaultProfile) ? { agentProfile: request.profile ?? project.resourceProfile ?? this.defaultProfile } : {}),
        }, { requestId: request.requestId });
        await this.refreshAfterAdmission(project, thread.id, operationOf('areal/thread/start', request), { backgroundList: true });
        return { threadId: thread.id, requestId: request.requestId };
      }
      case 'fork': {
        if (!project.client.capabilities?.methods?.includes('areal/thread/fork')) throw new Error('当前 Core 不支持从此轮次创建分支');
        const result = await this.submit(project, 'areal/thread/fork', {
          sourceThreadId: request.sourceThreadId, anchor: request.anchor, workspaceMode: 'sharedCurrent',
          ...(request.target ? { target: request.target } : {}),
        }, { requestId: request.requestId });
        // 创建收据已确认受理；后续投影失败不能把已提交的创建显示成可重试错误。
        await this.refreshAfterAdmission(project, result.thread.id, operationOf('areal/thread/fork', request));
        return { threadId: result.thread.id, requestId: result.requestId };
      }
      case 'side': {
        if (!project.client.capabilities?.methods?.includes('areal/side/start')) throw new Error('当前 Core 不支持旁路讨论');
        if (request.operation === 'list') {
          if (!project.client.capabilities?.methods?.includes('areal/conversation/list')) throw new Error('当前 Core 不支持相关讨论列表');
          return project.client.request('areal/conversation/list', { view: 'side', sourceThreadId: request.sourceThreadId,
            includeArchived: request.includeArchived === true, limit: 30, ...(request.cursor ? { cursor: request.cursor } : {}) });
        }
        if (request.operation === 'context') return project.client.request('areal/side/context/read', {
          threadId: request.threadId, ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.evidenceRef ? { evidenceRef: request.evidenceRef } : {}),
          ...(request.maxBytes ? { maxBytes: request.maxBytes } : {}),
        });
        if (request.operation === 'recover') {
          const receipts = await project.client.request('areal/request/read', { requestId: request.requestId });
          const receipt = receipts.data?.find(item => item.method === 'areal/side/start');
          const id = receipt?.result?.threadId;
          if (!id) return { confirmed: false };
          await this.changeOutcomes(project, outcomes => ({ ...outcomes, [request.requestId]: {
            accepted: true, method: 'areal/side/start', sourceThreadId: request.sourceThreadId, threadId: id,
          } }));
          await this.changePending(project, pending => pending.filter(item => item.params.requestId !== request.requestId));
          // 收据已确认；恢复投影失败不能推翻受理结果或留下待重发的首问。
          try { await this.openThread(project, id); } catch { /* 可凭目标身份再次打开。 */ }
          return { confirmed: true, threadId: id };
        }
        if (request.operation === 'send') {
          const current = project.model.state.threads[request.threadId];
          if (current?.conversation?.kind !== 'side') throw new Error('目标不是旁路讨论');
          const result = await this.submit(project, 'areal/turn/start', { threadId: request.threadId,
            input: [{ type: 'text', text: request.text }] }, { requestId: request.requestId });
          // 追问已受理；快照读取失败只能通过重新打开恢复，不能重发输入。
          try { await this.openThread(project, request.threadId); } catch { /* 保留明确受理结果。 */ }
          return result;
        }
        const result = await this.submit(project, 'areal/side/start', {
          sourceThreadId: request.sourceThreadId, workspaceAccess: request.workspaceAccess === 'readOnly' ? 'readOnly' : 'none',
          ...(request.selection ? { selection: request.selection } : {}),
          ...(request.anchor ? { anchor: request.anchor } : {}),
          input: [{ type: 'text', text: request.text }],
          ...(request.resetModel === true ? { resetModel: true } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.parameters ? { parameters: request.parameters } : {}),
        }, { requestId: request.requestId });
        // 与 Fork 一样，投影刷新不改变 Core 已确认的创建结果。
        await this.refreshAfterAdmission(project, result.thread.id, operationOf('areal/side/start', request));
        return { threadId: result.thread.id, turnId: result.turn?.id, requestId: result.requestId };
      }
      case 'send': {
        if (isTaskDraftConfiguration(project.configurations?.[threadId])) {
          const zone = project.configurations[threadId].options.appendInstructions.split('\n')[1].slice('Time zone: '.length);
          return manageTaskDraft(this, project, { operation: 'taskDraftSend', threadId, timeZone: zone,
            text: request.text, attachments: request.attachments, requestId: request.requestId });
        }
        await this.ensureBrowserTools(project, threadId);
        const input = messageInput(this, request);
        const current = project.model.state.threads[threadId];
        let submitted;
        if (current?.goals?.goal || current?.goalOwner || current?.parentThreadId || current?.source === 'nativeTaskAgent' || current?.conversation?.kind === 'side') {
          const enqueue = current.turns?.some(turn => turn.status === 'inProgress');
          submitted = await this.submit(project, enqueue ? 'areal/turn/enqueue' : 'areal/turn/start', { threadId, input }, { requestId: request.requestId });
        } else {
          if (!projectCoreCapabilities(this.binary, project.client.capabilities).features?.ordinaryTurnSubmit) throw new Error('当前 Core 不支持普通会话提交，请更新 Core。');
          submitted = await this.submit(project, 'areal/turn/submit', { threadId,
            expectedConfigRevision: project.configurations[threadId].revision, intent: { type: 'message', input } }, { requestId: request.requestId });
        }
        if (submitted.queueItemId) context.onBrowserTurnQueued?.(submitted.queueItemId);
        else if (submitted.turn?.id) context.onBrowserTurnStarted?.(submitted.turn.id);
        return submitted;
      }
      case 'editMessage': {
        if (!projectCoreCapabilities(this.binary, project.client.capabilities).features?.editLastMessage) throw new Error('当前 Core 不支持编辑消息，请更新 Core。');
        await this.ensureBrowserTools(project, threadId);
        const submitted = await this.submit(project, 'areal/turn/submit', { threadId,
          expectedConfigRevision: request.expectedConfigRevision,
          intent: { type: 'edit', expectedTurnId: request.expectedTurnId, itemId: request.itemId, input: messageInput(this, request) } }, { requestId: request.requestId });
        if (submitted.turn?.id) context.onBrowserTurnStarted?.(submitted.turn.id);
        return submitted;
      }
      case 'continue': {
        if (!projectCoreCapabilities(this.binary, project.client.capabilities).features?.ordinaryTurnSubmit) throw new Error('当前 Core 不支持继续执行，请更新 Core。');
        await this.ensureBrowserTools(project, threadId);
        const submitted = await this.submit(project, 'areal/turn/submit', { threadId,
          expectedConfigRevision: request.expectedConfigRevision ?? project.configurations[threadId].revision,
          intent: { type: 'continue', expectedTurnId: request.expectedTurnId } }, { requestId: request.requestId });
        if (submitted.turn?.id) context.onBrowserTurnStarted?.(submitted.turn.id);
        return submitted;
      }
      case 'steer': {
        if (isTaskDraftConfiguration(project.configurations?.[threadId])) throw new Error('请等待当前安排完成后再补充修改要求。');
        const active = project.model.state.threads[threadId]?.turns.find(turn => turn.status === 'inProgress');
        if (!active || active.id !== request.expectedTurnId) throw new Error('原轮次已结束，请作为新消息发送');
        await this.submit(project, 'turn/steer', { threadId, expectedTurnId: active.id, input: messageInput(this, request), previousItems: active.items.map(item => item.id) }, { requestId: request.requestId });
        break;
      }
      case 'respond': {
        const interaction = project.model.state.interactions[threadId]?.data.find(item => item.requestId === request.requestId && item.status === 'pending');
        if (!interaction) throw new Error('交互已过期，请刷新任务状态');
        try {
          await project.client.request('areal/interaction/respond', { threadId, turnId: interaction.turnId, requestId: interaction.requestId,
            ...(interaction.kind === 'approval' ? { decision: request.decision, argumentsDigest: interaction.argumentsDigest } : { answers: request.answers }),
          });
        } catch (error) {
          const current = await project.client.request('areal/interaction/list', { threadId }).catch(() => null);
          if (current) project.model.setInteractions(threadId, current);
          throw error;
        }
        break;
      }
      case 'reconcile': await this.reconcile(project); await this.refreshAfterAdmission(project); return { outcomes: project.outcomes };
      default: throw new Error('不支持的操作');
    }
    return this.snapshot();
  }

  hasWork({ includePausedQueues = true } = {}) {
    return [...this.projects.values()].some(project => project.pending.some(entry => !isRemoteControl(entry)) || Object.values(project.model.state.threads)
      .some(thread => thread.turns?.some(turn => turn.status === 'inProgress'))
      // Paused pending messages are persisted input, not live execution. Lifecycle
      // checks can preserve them through shutdown; provider changes still guard them.
      || Object.values(project.model.state.queues).some(queue => queue.items.some(item => item.status === 'running'
        || (item.status === 'pending' && (includePausedQueues || queue.paused !== true)))));
  }

  async shutdown({ requireSafe = true, cancel = false } = {}) {
    if (!requireSafe) return this.disconnect();
    const receipt = await this.lifecycleOperations.request({ requestId: randomUUID(), kind: 'stopDesktop', mode: cancel ? 'cancel' : 'ifIdle',
      expectedDesktopGeneration: this.lifecycleOperations.generation, expectedTargets: this.lifecycleOperations.targets() });
    if (receipt.desktopExit !== 'requested') throw Object.assign(new Error('后台停止尚未完成，请检查原请求'),
      { code: 'LIFECYCLE_INCOMPLETE', requestId: receipt.requestId, lifecycle: receipt });
    return receipt;
  }

  async disconnect() {
    this.closing = true;
    for (const project of new Set([...this.projects.values(), ...[...this.ownedEngines.values()].map(entry => entry.project)])) {
      clearTimeout(project.reconnectTimer); project.reconnectTimer = null;
      project.taskNotificationMonitor?.stop();
      this.stopReconciliation(project);
      project.client?.close();
    }
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.projects.values()].map(project => project.summaryReads));
    await this.providers.close();
    await this.proxyRelay?.close();
    await this.analytics.flush();
  }

}

module.exports = { CoreBackend };
