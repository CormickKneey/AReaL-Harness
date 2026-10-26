// @ts-check
"use strict";
const { executeCore } = require("./core-process.cjs");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  record,
  strings,
  stringMap,
  modelConfig,
  parameters,
  modelSnapshot,
} = require("./provider-contract.cjs");

/** @param {string} value */
const protocolToCore = (value) => (value === "chatCompletions" ? "chat-completions" : value);
/** @param {string} endpoint */
const baseUrl = (endpoint) => endpoint.replace(/\/(chat\/completions|responses)\/?$/, "");
/** @param {unknown} value */
function credentialValue(value, { privateKey = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length > (privateKey ? 32768 : 16384) ||
    value.includes("\0") ||
    (!privateKey && /[^\x20-\x7e]/.test(value))
  )
    throw new Error("凭据格式无效");
  return value.trim();
}

// Core 拥有配置和版本；此处只保存加密凭据与迁移回执，不可变凭据引用保护失败的 CAS。
class ModelConfiguration {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {import('electron').SafeStorage} [encryption] */
  constructor(backend, encryption) {
    this.backend = backend;
    this.encryption = encryption;
    /** @type {{keys:Record<string,string>,migrated:string[]}} */
    this.vault = { keys: {}, migrated: [] };
    /** @type {{data:Array<{id:string,name:string,baseUrl:string,protocol:string,enabled:boolean,models:import('./provider-contract.cjs').ModelConfig[],parameters:import('./provider-contract.cjs').ModelParameters,secret?:string}>,retired?:string[]}|undefined} */
    this.legacy = undefined;
    /** @type {import('./provider-contract.cjs').ModelSnapshot|undefined} */
    this.value = undefined;
    /** @type {Promise<import('./provider-contract.cjs').ModelSnapshot>|null} */
    this.reading = null;
  }
  async init() {
    try {
      this.vault = credentialVault(
        JSON.parse(await readFile(join(this.backend.home, "provider-credentials.json"), "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      this.legacy = legacyProviders(
        JSON.parse(await readFile(join(this.backend.home, "providers.json"), "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  /** @param {'read'|'write'} operation @param {import('./provider-contract.cjs').ModelUpdate} [request] */
  async execute(operation, request) {
    const args = ["config", "models", operation];
    if (this.backend.config) args.push("--config", this.backend.config);
    for (const reference of Object.keys(this.vault.keys))
      args.push("--stored-credential-env", reference);
    let stdout;
    try {
      // 与项目启动使用相同的凭据环境，由 Core 判断就绪状态，输出不含密钥。
      ({ stdout } = await executeCore(this.backend.binary, args, {
        env: { ...this.backend.hooks.environment(), ...this.environment() },
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        input: request ? JSON.stringify(request) : undefined,
      }));
    } catch (error) {
      const failure = record(error) ? error : {};
      const timedOut = failure.timedOut === true;
      console.error(
        JSON.stringify({
          event: "core-model-configuration-failed",
          operation,
          exitCode: typeof failure.code === "number" ? failure.code : null,
          code: typeof failure.code === "string" ? failure.code : null,
          signal: failure.signal ?? null,
          killed: failure.killed === true,
          timedOut,
        }),
      );
      const detail = timedOut
        ? "Core 模型配置请求超时，请检查后台服务日志。"
        : failure.signal
          ? "Core 模型配置进程意外终止，请检查后台服务日志。"
          : `Core 模型配置失败：${this.backend.providers.redact(typeof failure.stderr === "string" ? failure.stderr : failure.message).slice(0, 2048)}。`;
      throw new Error(`${detail}配置若已变化，请刷新核对后再操作。`);
    }
    try {
      return modelSnapshot(JSON.parse(stdout));
    } catch {
      throw new Error("Core 返回了无效的模型配置");
    }
  }
  /** @returns {Promise<import('./provider-contract.cjs').ModelSnapshot>} */
  current() {
    // 设置页与多个项目启动可同时读取，首次迁移只允许一个写入者。
    if (!this.reading)
      this.reading = this.read().finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
  /** @returns {Promise<import('./provider-contract.cjs').ModelSnapshot>} */
  async read() {
    const previous = this.value;
    let current = await this.execute("read");
    if (this.legacy && !this.vault.migrated.includes(current.path)) {
      const imported = this.legacy.data.map(
        ({ id, name, baseUrl: url, protocol, enabled, models, parameters, secret }) => ({
          id,
          name,
          endpoint: url + (protocol === "responses" ? "/responses" : "/chat/completions"),
          protocol: protocolToCore(protocol),
          enabled,
          models,
          parameters,
          ...(secret ? { apiKeyEnv: `AREAL_CREDENTIAL_${id}` } : {}),
        }),
      );
      for (const item of imported) {
        const existing = current.data.find((p) => p.id === item.id);
        if (existing && !isDeepStrictEqual(existing, item))
          throw new Error(
            `旧供应商与 Core 配置存在同 ID 冲突：${item.id}。请先调整文件中的 ID，再刷新。`,
          );
      }
      // 保留原文档用于恢复；配置写入成功但回执中断后，重试不得覆盖已保存密钥。
      for (const item of this.legacy.data)
        if (item.secret) {
          const reference = `AREAL_CREDENTIAL_${item.id}`;
          if (this.vault.keys[reference] && this.vault.keys[reference] !== item.secret)
            throw new Error(`旧供应商凭据冲突：${item.id}`);
          this.vault.keys[reference] = item.secret;
        }
      await this.backend.save("provider-credentials.json", this.vault);
      current = await this.execute("write", {
        expectedRevision: current.revision,
        data: [
          ...current.data,
          ...imported.filter((item) => !current.data.some((p) => p.id === item.id)),
        ],
        defaultModel: current.defaultModel,
      });
      this.vault.migrated.push(current.path);
      await this.backend.save("provider-credentials.json", this.vault);
    }
    if (this.value === previous) this.value = current;
    return this.value ?? current;
  }
  /** @param {unknown} value */
  async credential(value, { privateKey = false } = {}) {
    const secret = credentialValue(value, { privateKey });
    if (!secret) return undefined;
    if (
      !this.encryption?.isEncryptionAvailable() ||
      this.encryption.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("系统安全存储不可用，API Key 未保存");
    const reference = `AREAL_CREDENTIAL_${randomUUID().replaceAll("-", "")}`;
    this.vault.keys[reference] = this.encryption.encryptString(secret).toString("base64");
    await this.backend.save("provider-credentials.json", this.vault);
    return reference;
  }
  /** @param {{apiKeyEnv?:string}} item */
  key(item) {
    if (!item?.apiKeyEnv) return "";
    const encrypted = this.vault.keys[item?.apiKeyEnv];
    if (!encrypted) return process.env[item?.apiKeyEnv] ?? "";
    try {
      if (!this.encryption) throw new Error("系统安全存储不可用");
      return this.encryption.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      throw new Error("无法读取已保存的 API Key，请解锁系统钥匙串或重新填写密钥");
    }
  }
  /** @param {import('./provider-contract.cjs').ModelSnapshot} snapshot */
  credentialsFor(snapshot) {
    const references = new Set(
      snapshot.data
        .map((item) => item.apiKeyEnv)
        .filter(
          (reference) =>
            typeof reference === "string" &&
            reference.startsWith("AREAL_CREDENTIAL_") &&
            Object.hasOwn(this.vault.keys, reference),
        ),
    );
    return Object.fromEntries(
      [...references].map((reference) => [reference, this.key({ apiKeyEnv: reference })]),
    );
  }
  environment() {
    // 已冻结的任务与队列配置仍可能引用停用的凭据。
    return Object.fromEntries(
      Object.keys(this.vault.keys).map((reference) => [
        reference,
        this.key({ apiKeyEnv: reference }),
      ]),
    );
  }
  public() {
    const value = this.value;
    if (!value) throw new Error("模型配置尚未读取");
    return {
      ...value,
      data: value.data.map((item) => ({
        ...item,
        protocol: item.protocol === "chat-completions" ? "chatCompletions" : item.protocol,
        baseUrl: baseUrl(item.endpoint),
      })),
      projects: [...this.backend.projects.values()].map((project) => ({
        projectId: project.id,
        root: project.root,
        connected: !!project.client?.ready,
        applied:
          !!project.client?.ready &&
          !project.providerError &&
          !this.backend.providers?.pendingApplications?.has(project.id) &&
          project.providerRevision === value.revision,
        error: project.providerError ?? null,
      })),
      pendingApply: [...this.backend.projects.values()].some(
        (project) =>
          project.service &&
          (project.providerRevision !== value.revision ||
            project.providerError ||
            this.backend.providers?.pendingApplications?.has(project.id)),
      ),
    };
  }
}
module.exports = { ModelConfiguration, protocolToCore, baseUrl, credentialValue };

/** @param {unknown} value @returns {{keys:Record<string,string>,migrated:string[]}} */
function credentialVault(value) {
  if (!record(value) || !stringMap(value.keys) || !strings(value.migrated))
    throw new Error("供应商凭据记录无效");
  return { keys: value.keys, migrated: value.migrated };
}
/** @param {unknown} value @returns {NonNullable<ModelConfiguration['legacy']>} */
function legacyProviders(value) {
  if (
    !record(value) ||
    !Array.isArray(value.data) ||
    (value.retired !== undefined && !strings(value.retired))
  )
    throw new Error("旧供应商配置无效");
  const data = value.data.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.baseUrl !== "string" ||
      typeof item.protocol !== "string" ||
      typeof item.enabled !== "boolean" ||
      !Array.isArray(item.models) ||
      !item.models.every(modelConfig) ||
      !parameters(item.parameters) ||
      (item.secret !== undefined && typeof item.secret !== "string")
    )
      throw new Error("旧供应商配置无效");
    return {
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
      protocol: item.protocol,
      enabled: item.enabled,
      models: item.models,
      parameters: item.parameters,
      ...(item.secret === undefined ? {} : { secret: item.secret }),
    };
  });
  return { data, ...(value.retired === undefined ? {} : { retired: value.retired }) };
}
