// @ts-check
"use strict";

const { executeCore } = require("./core-process.cjs");
const { readFile, realpath } = require("node:fs/promises");
const { isAbsolute, resolve, join } = require("node:path");
const WebSocket = require("ws");
const { desktopError } = require("@areal/workbench/desktop-contract");
/** @typedef {import('./project-index.cjs').SavedProject} SavedProject */
/** @typedef {import('@areal/runtime-client/core').CoreClient} CoreClient */
/** @typedef {{protocolVersion:1,state:'ready',serviceId:string,generation:string,configFingerprint:string,workspace:string,dataDir:string,endpoint:string,authFile:string,owner?:unknown,[key:string]:unknown}} ServiceDescriptor */
/** @typedef {SavedProject & {service?:ServiceReference|null,endpoint?:string|null,reconnectTimer?:NodeJS.Timeout|null,client?:CoreClient|null,model:{connection:(connected:boolean,error?:string|null)=>void},taskNotificationMonitor?:{stop:()=>void}}} ServiceProject */
/** @typedef {{project:ServiceProject,service?:ServiceReference,lifetimes?:Set<import('node:stream').Duplex>}} OwnedEngine */
/** @typedef {{binary:string,home:string,applicationOwner?:import('./application-owner.cjs').ApplicationOwner,hooks:{environment:()=>NodeJS.ProcessEnv},providers:{redact:(value:string)=>string},ownedEngines:Map<string,OwnedEngine>,projects:Map<string,ServiceProject>,saved:SavedProject[]}} ServiceHost */
/** @typedef {Pick<ServiceHost,'binary'|'home'|'hooks'|'providers'> & Partial<Pick<ServiceHost,'applicationOwner'|'ownedEngines'>>} ServiceReader */
/** @typedef {{serviceId:string,generation:string}} ServiceReference */
/** @typedef {ServiceReference & {projectId:string,requestId:string}} StopTarget */
/** @typedef {ServiceReference & {configFingerprint:string,dataDir:string}} RecoveryTarget */
/** @typedef {{service:ServiceReference & {configFingerprint:string,workspace:string,dataDir:string,owner:unknown,state?:unknown},recovery:{version:1,generation:string,eligible:boolean,reason:string},[key:string]:unknown}} RecoveryStatus */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 服务管理只走公共 CLI；轮次核查只读原代际的认证 app-server，不持有或终止 Core/Runtime 子进程。
/** @param {ServiceReader} backend @param {string[]} args @param {NodeJS.ProcessEnv} [environment] @param {{id:string}} [project] @returns {Promise<unknown>} */
async function request(backend, args, environment = backend.hooks.environment(), project) {
  let stdout;
  try {
    const execution = executeCore(backend.binary, ["service", ...args, "--json"], {
      ...(["ensure", "recover"].includes(args[0]) && backend.applicationOwner
        ? { applicationOwner: backend.applicationOwner }
        : {}),
      env: environment,
      timeout: ["status", "capabilities", "operation"].includes(args[0]) ? 10_000 : 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    if (project && execution.child?.ownerLifetime) {
      const entry = backend.ownedEngines?.get(project.id);
      if (!entry) throw new Error("Core owner lifetime has no project registration");
      entry.lifetimes ??= new Set();
      entry.lifetimes.add(execution.child?.ownerLifetime);
      execution.child?.ownerLifetime.on("error", () => {});
    }
    ({ stdout } = await execution);
  } catch (error) {
    const details = desktopError(error);
    const stderr =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    /** @type {unknown} */
    let failure;
    try {
      failure = JSON.parse(stderr)?.error;
    } catch {
      /* CLI/launcher diagnostics can be plain text. */
    }
    const message =
      record(failure) && typeof failure.message === "string"
        ? failure.message
        : stderr || details.message;
    if (message.includes("service is busy; wait for work to settle or stop with --cancel")) {
      throw Object.assign(
        new Error("Core 仍有活动目标、排队消息或后台任务，请等待完成或先暂停相关任务后重试。"),
        { code: "CORE_BUSY" },
      );
    }
    throw Object.assign(
      new Error(`Core 服务请求失败：${backend.providers.redact(message).slice(0, 2048)}`),
      {
        code:
          record(failure) && typeof failure.code === "string"
            ? failure.code
            : record(error) && error.timedOut
              ? "TIMEOUT"
              : details.code,
      },
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Core 返回了无效的本地服务描述");
  }
}

/** @param {ServiceReader} backend @param {string} operation @param {string[]} args @param {NodeJS.ProcessEnv} environment @param {{root:string,id?:string}} project @param {string} dataDir */
async function connectService(backend, operation, args, environment, project, dataDir) {
  const descriptor = await request(
    backend,
    [operation, ...args, ...(operation === "ensure" ? ["--no-auto-restart"] : [])],
    environment,
    typeof project.id === "string" ? { id: project.id } : undefined,
  );
  if (
    operation === "status" &&
    record(descriptor) &&
    typeof descriptor.state === "string" &&
    ["stopped", "unavailable", "stopping"].includes(descriptor.state)
  ) {
    throw Object.assign(new Error("Core 服务已停止或正在停止，请显式重新连接"), {
      code: "CORE_STOPPED",
    });
  }
  let endpoint;
  try {
    endpoint = new URL(
      record(descriptor) && typeof descriptor.endpoint === "string" ? descriptor.endpoint : "",
    );
  } catch {
    throw Object.assign(new Error("Core 返回了无效的服务地址"), { code: "CORE_INCOMPATIBLE" });
  }
  if (
    !serviceDescriptor(descriptor) ||
    descriptor.workspace !== (await realpath(project.root)) ||
    descriptor.dataDir !== (await realpath(dataDir)) ||
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    !isAbsolute(descriptor.authFile)
  ) {
    throw Object.assign(new Error("Core 服务描述与当前工作区不匹配"), {
      code: "CORE_INCOMPATIBLE",
    });
  }
  if (
    backend.applicationOwner &&
    !require("./application-owner.cjs").sameOwner(descriptor.owner, backend.applicationOwner)
  )
    throw Object.assign(
      new Error("原 Core 不属于本次 GUI 应用，请先从原 owner 的安全管理入口停止后再连接"),
      { code: "APPLICATION_OWNER_MISMATCH" },
    );
  /** @type {unknown} */
  const auth = JSON.parse(await readFile(resolve(descriptor.authFile), "utf8"));
  const principal =
    record(auth) && Array.isArray(auth.principals)
      ? auth.principals.find(
          /** @param {unknown} item */ (item) => {
            if (!record(item) || !Array.isArray(item.permissions)) return false;
            const permissions = item.permissions;
            return ["observe", "interact", "manage"].every((permission) =>
              permissions.includes(permission),
            );
          },
        )
      : undefined;
  if (!record(principal) || typeof principal.token !== "string" || !principal.token)
    throw new Error("Core 未提供桌面身份");
  return { descriptor, token: principal.token };
}

/** @param {ServiceReference} target */
const targetArguments = (target) => [
  "--instance",
  target.serviceId,
  "--expected-generation",
  target.generation,
];

/** @param {ServiceHost} backend @param {SavedProject} project @param {RecoveryTarget} target */
async function recoveryStatus(backend, project, target) {
  const value = await request(backend, ["status", "--instance", target.serviceId, "--recovery"]);
  if (
    !recoveryResponse(
      value,
      target,
      await realpath(project.root),
      await realpath(target.dataDir),
      backend.applicationOwner,
    )
  )
    throw Object.assign(new Error("原服务的恢复证明与当前应用不匹配"), {
      code: "CORE_INCOMPATIBLE",
    });
  return value;
}

/** @param {ServiceHost} backend @param {SavedProject} project @param {RecoveryTarget} target @param {{args:string[],environment:NodeJS.ProcessEnv}} launch */
function recoverService(backend, project, target, launch) {
  return connectService(
    backend,
    "recover",
    [...targetArguments(target), ...launch.args],
    launch.environment,
    project,
    target.dataDir,
  );
}

/** @param {ServiceReader} backend @param {ServiceReference} target */
async function lifecycleCapabilities(backend, target) {
  let value;
  try {
    value = await request(backend, ["capabilities", ...targetArguments(target)]);
  } catch (error) {
    throw Object.assign(new Error("原 Core Host 不支持持久生命周期回执，请先安全升级后台。"), {
      code: /generation changed/.test(desktopError(error).message)
        ? "CONFIRMATION_STALE"
        : "LIFECYCLE_UNSUPPORTED",
    });
  }
  if (!record(value) || value.version !== 1 || value.stopOperations !== 1)
    throw Object.assign(new Error("原 Core Host 不支持持久生命周期回执，请先安全升级后台。"), {
      code: "LIFECYCLE_UNSUPPORTED",
    });
  return value;
}

/** @param {ServiceReader} backend @param {StopTarget} target @param {boolean} cancel */
function requestStop(backend, target, cancel) {
  return request(backend, [
    "stop",
    ...targetArguments(target),
    "--request-id",
    target.requestId,
    ...(cancel ? ["--cancel"] : []),
  ]);
}

/** @param {ServiceReader} backend @param {StopTarget} target */
async function readStop(backend, target) {
  const result = await request(backend, [
    "operation",
    ...targetArguments(target),
    "--request-id",
    target.requestId,
  ]);
  if (!record(result) || !Object.hasOwn(result, "operation"))
    throw new Error("Core 返回了无效的生命周期回执查询");
  return result.operation;
}

/** @param {ServiceHost} backend @param {ServiceReference & {projectId:string}} target */
function detachStoppedProject(backend, target) {
  const owned = backend.ownedEngines?.get(target.projectId);
  if (
    owned?.service?.serviceId === target.serviceId &&
    owned.service.generation === target.generation
  ) {
    for (const lifetime of owned.lifetimes ?? []) lifetime.destroy();
    backend.ownedEngines.delete(target.projectId);
  }
  const project = backend.projects.get(target.projectId) ?? owned?.project;
  if (
    project?.service?.serviceId !== target.serviceId ||
    project.service.generation !== target.generation
  )
    return;
  project.service = null;
  project.endpoint = null;
  clearTimeout(project.reconnectTimer ?? undefined);
  project.reconnectTimer = null;
  project.taskNotificationMonitor?.stop();
  project.client?.close();
  project.client = null;
  project.model.connection(false);
}

/** @param {CoreClient} client @param {string} threadId @param {string} turnId @param {{observe?:()=>Promise<unknown>,assertCurrent?:()=>void}} [options] */
async function readTurnMetadata(
  client,
  threadId,
  turnId,
  { observe, assertCurrent = () => {} } = {},
) {
  const invalid = () =>
    Object.assign(new Error("原轮次历史元数据不完整或身份不匹配"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
    });
  const features = client.capabilities?.features;
  const bounded =
    record(features) && features.boundedObservation === true && features.boundedHistory === true;
  assertCurrent();
  let result;
  if (!bounded) result = await client.request("thread/read", { threadId, includeTurns: true });
  else if (observe) result = await observe();
  else {
    for (const maxBytes of [262144, 1048576]) {
      try {
        result = await client.request(
          "areal/thread/observe",
          { threadId, mode: "bounded", maxBytes },
          { maxResponseBytes: maxBytes },
        );
        break;
      } catch (error) {
        assertCurrent();
        if (maxBytes === 1048576 || desktopError(error).reason !== "HISTORY_BUDGET_TOO_SMALL")
          throw error;
      }
    }
  }
  assertCurrent();
  if (
    !record(result) ||
    !record(result.thread) ||
    result.thread.id !== threadId ||
    !Array.isArray(result.thread.turns)
  )
    throw invalid();
  const found = result.thread.turns.find(
    /** @param {unknown} turn */ (turn) => record(turn) && turn.id === turnId,
  );
  if (record(found)) {
    return { id: turnId, status: found.status };
  }
  if (!bounded) return null;
  const history = result.history;
  if (
    !record(history) ||
    typeof history.snapshotId !== "string" ||
    typeof history.complete !== "boolean"
  )
    throw invalid();
  let cursor = history.nextCursor;
  if (cursor != null && typeof cursor !== "string") throw invalid();
  while (!history.complete && cursor) {
    assertCurrent();
    const page = await client.request(
      "areal/conversation/history",
      { threadId, view: "own", cursor, maxBytes: 262144 },
      { maxResponseBytes: 262144 },
    );
    assertCurrent();
    if (
      !record(page) ||
      page.snapshotId !== history.snapshotId ||
      !Array.isArray(page.data) ||
      page.data.some(
        /** @param {unknown} entry */ (entry) =>
          !record(entry) || entry.sourceThreadId !== threadId,
      ) ||
      typeof page.complete !== "boolean"
    )
      throw invalid();
    const entry = page.data.find(
      /** @param {unknown} entry */ (entry) => record(entry) && entry.sourceTurnId === turnId,
    );
    if (record(entry)) {
      return { id: turnId, status: entry.sourceTurnStatus };
    }
    if (page.complete) return null;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor)
      throw invalid();
    cursor = page.nextCursor;
  }
  if (!history.complete) throw invalid();
  return null;
}

/** @param {ServiceReader & {saved:SavedProject[]}} backend @param {ServiceReference & {projectId:string}} target @param {string} threadId @param {string} turnId */
async function readOriginalTurn(backend, target, threadId, turnId) {
  const project =
    backend.saved.find((project) => project.id === target.projectId) ??
    backend.ownedEngines?.get(target.projectId)?.project;
  if (!project)
    throw Object.assign(new Error("原工作区登记不可用，无法核对轮次"), {
      code: "LIFECYCLE_INCOMPLETE",
    });
  const { descriptor, token } = await connectService(
    backend,
    "status",
    ["--instance", target.serviceId],
    backend.hooks.environment(),
    project,
    join(backend.home, target.projectId, "state"),
  );
  if (descriptor.serviceId !== target.serviceId || descriptor.generation !== target.generation)
    throw Object.assign(new Error("原 Core 代际已变化，不能用新实例代替核查"), {
      code: "CONFIRMATION_STALE",
    });
  const { CoreClient, MAX_RESPONSE_BYTES } = await import("@areal/runtime-client/core");
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        maxPayload: MAX_RESPONSE_BYTES,
      }),
  });
  try {
    await client.connect();
    return await readTurnMetadata(client, threadId, turnId);
  } finally {
    client.close();
  }
}

// Status alone normalizes a vanished Host to stopped. Recovery also requires
// the original Host's clean-shutdown marker; PID/socket disappearance is not proof.
/** @param {ServiceReader} backend @param {ServiceReference & {projectId:string,root:string}} target */
async function inspectOriginalService(backend, target) {
  const descriptor = await request(backend, ["status", "--instance", target.serviceId]);
  const dataDir = await realpath(join(backend.home, target.projectId, "state"));
  const workspace = await realpath(target.root);
  /** @param {unknown} value @returns {value is Record<string,unknown>} */
  const matches = (value) =>
    record(value) &&
    value.protocolVersion === 1 &&
    value.serviceId === target.serviceId &&
    value.generation === target.generation &&
    value.dataDir === dataDir &&
    value.workspace === workspace;
  if (!matches(descriptor))
    throw Object.assign(new Error("原 Core 身份或代际已变化，不能用新实例代替核查"), {
      code: "CONFIRMATION_STALE",
    });
  if (descriptor.state === "stopped") {
    const serviceHome = backend.hooks.environment().AREAL_HARNESS_SERVICE_HOME;
    if (!serviceHome) throw new Error("Core service registry home unavailable");
    /** @type {unknown} */
    const stored = JSON.parse(
      await readFile(join(serviceHome, "services", target.serviceId, "service.json"), "utf8"),
    );
    return { descriptor, cleanupConfirmed: matches(stored) && stored.state === "stopped" };
  }
  if (descriptor.state !== "ready") return { descriptor, cleanupConfirmed: false };
  const { token, descriptor: connected } = await connectService(
    backend,
    "status",
    ["--instance", target.serviceId],
    backend.hooks.environment(),
    target,
    dataDir,
  );
  if (!matches(connected))
    throw Object.assign(new Error("原 Core 代际已变化"), { code: "CONFIRMATION_STALE" });
  const { CoreClient } = await import("@areal/runtime-client/core");
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(connected.endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        maxPayload: 4 * 1024 * 1024,
      }),
  });
  try {
    await client.connect();
    return {
      descriptor,
      cleanupConfirmed: false,
      status: await client.request("areal/server/status"),
    };
  } finally {
    client.close();
  }
}

/** @param {unknown} value @returns {value is ServiceDescriptor} */
function serviceDescriptor(value) {
  return (
    record(value) &&
    value.protocolVersion === 1 &&
    value.state === "ready" &&
    typeof value.serviceId === "string" &&
    /^[a-f0-9]{24}$/.test(value.serviceId) &&
    typeof value.generation === "string" &&
    typeof value.configFingerprint === "string" &&
    typeof value.workspace === "string" &&
    typeof value.dataDir === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.authFile === "string"
  );
}
/** @param {unknown} value @param {RecoveryTarget} target @param {string} workspace @param {string} dataDir @param {unknown} owner @returns {value is RecoveryStatus} */
function recoveryResponse(value, target, workspace, dataDir, owner) {
  if (!record(value) || !record(value.service) || !record(value.recovery)) return false;
  const service = value.service,
    recovery = value.recovery;
  return (
    recovery.version === 1 &&
    recovery.generation === target.generation &&
    typeof recovery.eligible === "boolean" &&
    typeof recovery.reason === "string" &&
    service.serviceId === target.serviceId &&
    service.generation === target.generation &&
    service.configFingerprint === target.configFingerprint &&
    service.workspace === workspace &&
    service.dataDir === dataDir &&
    require("./application-owner.cjs").sameOwner(service.owner, owner)
  );
}

module.exports = {
  readOwnedServices,
  connectService,
  recoveryStatus,
  recoverService,
  lifecycleCapabilities,
  requestStop,
  readStop,
  detachStoppedProject,
  readOriginalTurn,
  readTurnMetadata,
  inspectOriginalService,
  serviceRequest: request,
};

/** @typedef {RecoveryTarget & {workspace:string,state:string,owner:unknown,[key:string]:unknown}} OwnedService */
/** Only consume descriptors belonging to this application; registry extensions and other owners stay opaque.
 * @param {unknown} value @param {import('./application-owner.cjs').ApplicationOwner} owner @returns {OwnedService[]} */
function readOwnedServices(value, owner) {
  if (!Array.isArray(value)) throw new Error("Core 返回了无效的服务登记列表");
  return value.flatMap(
    /** @param {unknown} descriptor */ (descriptor) => {
      if (!record(descriptor)) throw new Error("Core 返回了无效的服务登记列表");
      if (!require("./application-owner.cjs").sameOwner(descriptor.owner, owner)) return [];
      if (!ownedService(descriptor))
        throw Object.assign(new Error("所属 Core 服务登记结构无效"), { code: "CORE_INCOMPATIBLE" });
      return [descriptor];
    },
  );
}
/** @param {unknown} value @returns {value is OwnedService} */
function ownedService(value) {
  return (
    record(value) &&
    ["serviceId", "generation", "configFingerprint", "workspace", "dataDir", "state"].every(
      (key) => typeof value[key] === "string",
    )
  );
}
