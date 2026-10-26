// @ts-check
"use strict";
/** @typedef {Record<string,unknown>} Fields */
/** @typedef {{type:'stdio',command:string,args:string[],cwd:string|null,envVars:string[]}|{type:'streamableHttp',url:string,bearerTokenEnv:string|null}} McpTransport */
/** @typedef {{transport:McpTransport,startupTimeoutMs:number,callTimeoutMs:number|null,enabledTools:string[]|null}} McpConfig */
/** @typedef {{id:string,runtimeId:string,config:McpConfig}} UserMcp */
/** @typedef {{revision:number,skills:Record<string,Record<string,boolean>>,mcp:UserMcp[]}} ResourceState */
/** @typedef {{id:string,scope:string,managed:boolean,enabled:boolean,root:string,name:string,description:string,revision:string,error?:undefined}} AvailableSkill */
/** @typedef {AvailableSkill|{id:string,scope:string,managed:boolean,enabled:false,name:string,root?:string,error:string}} Skill */
/** @typedef {{id:string,revision:string,root:string,metadata:{name:string,description:string}}} DeployedSkill */
/** @typedef {Fields & {id:string,revision:number,state:string,config:McpConfig}} McpServer */
/** @typedef {Fields & {pluginId:string,installedDigest:string,trusted:boolean,state:string}} PluginConnection */
/** @param {unknown} value @returns {value is Fields} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {ResourceState} */
function resources(value) {
  if (
    !record(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !record(value.skills) ||
    !Array.isArray(value.mcp)
  )
    throw new Error("资源配置记录无效");
  const skills = Object.fromEntries(
    Object.entries(value.skills).map(([scope, entries]) => {
      if (!record(entries)) throw new Error("技能启用记录无效");
      return [
        scope,
        Object.fromEntries(
          Object.entries(entries).map(([id, enabled]) => {
            if (typeof enabled !== "boolean") throw new Error("技能启用记录无效");
            return [id, enabled];
          }),
        ),
      ];
    }),
  );
  const mcp = value.mcp.map((item) => {
    if (!record(item) || typeof item.id !== "string" || typeof item.runtimeId !== "string")
      throw new Error("MCP 配置记录无效");
    return { id: item.id, runtimeId: item.runtimeId, config: normalizeMcp(item.config) };
  });
  return { revision: value.revision, skills, mcp };
}
/** @param {unknown} value @returns {DeployedSkill[]} */
function deployedSkills(value) {
  if (!Array.isArray(value)) throw new Error("技能部署记录无效");
  return value.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.revision !== "string" ||
      typeof item.root !== "string" ||
      !record(item.metadata) ||
      typeof item.metadata.name !== "string" ||
      typeof item.metadata.description !== "string"
    )
      throw new Error("技能部署记录无效");
    return {
      id: item.id,
      revision: item.revision,
      root: item.root,
      metadata: { name: item.metadata.name, description: item.metadata.description },
    };
  });
}
/** @param {unknown} value */
function deployment(value) {
  if (!record(value) || !Array.isArray(value.profiles) || !value.profiles.length)
    throw new Error("桌面资源配置无效");
  const profiles = value.profiles.map((item) => {
    if (!record(item) || typeof item.id !== "string" || typeof item.revision !== "string")
      throw new Error("桌面任务配置无效");
    return { ...item, id: item.id, revision: item.revision };
  });
  return { ...value, profiles };
}
/** @param {unknown} value @returns {{data:McpServer[]}} */
function mcpServers(value) {
  if (!record(value) || !Array.isArray(value.data)) throw new Error("Core MCP 目录无效");
  const data = value.data.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.revision !== "number" ||
      !Number.isSafeInteger(item.revision) ||
      typeof item.state !== "string" ||
      !mcpConfig(item.config)
    )
      throw new Error("Core MCP 记录无效");
    return {
      ...item,
      id: item.id,
      revision: item.revision,
      state: item.state,
      config: item.config,
    };
  });
  return { data };
}
/** @param {unknown} value @returns {{data:PluginConnection[]}} */
function pluginConnections(value) {
  if (!record(value) || !Array.isArray(value.data)) throw new Error("Core 插件连接目录无效");
  const data = value.data.map((item) => {
    if (
      !record(item) ||
      typeof item.pluginId !== "string" ||
      typeof item.installedDigest !== "string" ||
      typeof item.trusted !== "boolean" ||
      typeof item.state !== "string"
    )
      throw new Error("Core 插件连接记录无效");
    return {
      ...item,
      pluginId: item.pluginId,
      installedDigest: item.installedDigest,
      trusted: item.trusted,
      state: item.state,
    };
  });
  return { data };
}
/** @param {unknown} value */
function availableSkills(value) {
  if (!record(value) || !Array.isArray(value.data)) throw new Error("Core 技能目录无效");
  const data = value.data.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.revision !== "string" ||
      typeof item.available !== "boolean"
    )
      throw new Error("Core 技能记录无效");
    return { ...item, id: item.id, revision: item.revision, available: item.available };
  });
  return { data };
}
/** @param {unknown} raw @returns {McpConfig} */
function normalizeMcp(raw) {
  if (!record(raw)) throw new Error("无效 MCP 配置");
  const t = raw.transport;
  /** @param {unknown} v @returns {v is string} */
  const env = (v) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
  /** @param {Fields} object @param {string[]} allowed */
  const keys = (object, allowed) => {
    if (Object.keys(object).some((k) => !allowed.includes(k)))
      throw new Error("MCP 配置包含不支持的字段");
  };
  keys(raw, ["transport", "startupTimeoutMs", "callTimeoutMs", "enabledTools"]);
  if (!record(t)) throw new Error("请配置 MCP transport");
  /** @type {McpTransport} */ let transport;
  if (t.type === "stdio") {
    keys(t, ["type", "command", "args", "cwd", "envVars"]);
    const args = t.args ?? [];
    const envVars = t.envVars ?? [];
    if (
      typeof t.command !== "string" ||
      !t.command.trim() ||
      t.command.includes("\0") ||
      !strings(args) ||
      args.length > 256 ||
      args.some((a) => a.includes("\0")) ||
      !strings(envVars) ||
      envVars.length > 64 ||
      envVars.some((e) => !env(e)) ||
      (t.cwd != null && (typeof t.cwd !== "string" || !t.cwd))
    )
      throw new Error("MCP 命令、参数或环境变量名称无效");
    transport = {
      type: t.type,
      command: t.command,
      args,
      cwd: t.cwd ?? null,
      envVars,
    };
  } else if (t.type === "streamableHttp") {
    keys(t, ["type", "url", "bearerTokenEnv"]);
    if (typeof t.url !== "string") throw new Error("MCP URL 无效");
    let url;
    try {
      url = new URL(t.url);
    } catch {
      throw new Error("MCP URL 无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (t.bearerTokenEnv != null && !env(t.bearerTokenEnv))
    )
      throw new Error("MCP URL 或认证环境变量名称无效");
    transport = {
      type: t.type,
      url: t.url,
      bearerTokenEnv: t.bearerTokenEnv ?? null,
    };
  } else throw new Error("不支持的 MCP transport");
  const startupTimeoutMs = raw.startupTimeoutMs ?? 30000,
    callTimeoutMs = raw.callTimeoutMs === undefined ? 120000 : raw.callTimeoutMs;
  if (
    typeof startupTimeoutMs !== "number" ||
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs <= 0 ||
    (callTimeoutMs !== null &&
      (typeof callTimeoutMs !== "number" ||
        !Number.isSafeInteger(callTimeoutMs) ||
        callTimeoutMs <= 0))
  )
    throw new Error("MCP 超时必须为正整数");
  const enabledTools = raw.enabledTools ?? null;
  if (
    enabledTools !== null &&
    (!strings(enabledTools) ||
      enabledTools.length > 128 ||
      enabledTools.some((v) => typeof v !== "string" || !v || v.length > 256))
  )
    throw new Error("无效工具列表");
  const result = { transport, startupTimeoutMs, callTimeoutMs, enabledTools };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536)
    throw new Error("MCP 配置过大");
  return result;
}

/** @typedef {{scope:'user',projectId?:string}|{scope:'project',projectId:string}} Scope */
/** @typedef {{name:string,event:'PreToolUse'|'PostToolUse'|'PostToolUseFailure',matcher:string,argv:string[],timeoutMs:number}} Hook */
/** @typedef {{transport:{type:'stdio',command:string,args?:string[]|null,cwd?:string|null,envVars?:string[]|null}|{type:'streamableHttp',url:string,bearerTokenEnv?:string|null},startupTimeoutMs?:number|null,callTimeoutMs?:number|null,enabledTools?:string[]|null}} McpInput */
/** @typedef {{operation:'hooks'}|{operation:'hooksSave',expectedRevision:string,hooks:Hook[]}|{operation:'builtinSkill',id:'openai-skill-creator'}| (Scope & ({operation:'skills'|'mcp'}|{operation:'skillRead',id:string}|{operation:'skillToggle',id:string,enabled:boolean,expectedRevision:number}|{operation:'skillSave',id:string,name?:string|null,description?:string|null,content:string,expectedRevision:number}|{operation:'mcpSave',id:string,config:McpInput,expectedRevision:number}|{operation:'mcpConnect'|'mcpDisconnect',id:string,projectId:string,expectedRevision?:number}))} ResourceRequest */
/** @typedef {{path:string,external:boolean,revision:string,hooks:Hook[],projects:Array<{projectId:string,root:string,connected:boolean,applied:boolean}>}} HooksStatus */
/** @typedef {{skill:{id:string,revision:string,name:string,description:string},provenance:{upstream:string,revision:string,contentDigest:string}}} BuiltinSkill */
/** @typedef {{revision:number,data:Array<Skill & {overridden:boolean}>,customDeployment:boolean}} SkillsStatus */
/** @typedef {{id:string,state:string,scope:'project',revision:number,config:McpConfig}|{id:string,runtimeId:string,state:string,scope:'user',revision?:number,liveRevision:number,config:McpConfig}} ScopedMcp */
/** @typedef {{revision:number,data:ScopedMcp[]}} McpStatus */
/** @typedef {{revision:number,warning:string|null}} ResourceSaved */
/** @template {string} N @typedef {N extends 'resources' ? ResourceRequest : never} Request */
/** @template {string} N @template P @typedef {N extends 'resources' ? P extends {operation:'hooks'|'hooksSave'} ? HooksStatus : P extends {operation:'builtinSkill'} ? BuiltinSkill : P extends {operation:'skills'} ? SkillsStatus : P extends {operation:'skillRead'} ? {content:string,truncated:boolean} : P extends {operation:'mcp'|'mcpConnect'|'mcpDisconnect'} ? McpStatus : P extends {operation:'mcpSave'} ? P extends {scope:'project'} ? McpStatus : P extends {scope:'user'} ? ResourceSaved : McpStatus|ResourceSaved : P extends {operation:'skillToggle'|'skillSave'} ? ResourceSaved : never : never} Response */
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string";
}
/** @param {unknown} value @returns {value is number} */
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** @param {unknown} value @returns {value is Hook} */
function hook(value) {
  return (
    record(value) &&
    text(value.name) &&
    ["PreToolUse", "PostToolUse", "PostToolUseFailure"].some((entry) => entry === value.event) &&
    text(value.matcher) &&
    strings(value.argv) &&
    integer(value.timeoutMs)
  );
}
/** @param {unknown} value @returns {value is McpConfig} */
function mcpConfig(value) {
  if (
    !record(value) ||
    !record(value.transport) ||
    !integer(value.startupTimeoutMs) ||
    value.startupTimeoutMs < 1 ||
    !(value.callTimeoutMs === null || (integer(value.callTimeoutMs) && value.callTimeoutMs > 0)) ||
    !(value.enabledTools === null || strings(value.enabledTools))
  )
    return false;
  const t = value.transport;
  return t.type === "stdio"
    ? text(t.command) && strings(t.args) && (t.cwd === null || text(t.cwd)) && strings(t.envVars)
    : t.type === "streamableHttp" &&
        text(t.url) &&
        (t.bearerTokenEnv === null || text(t.bearerTokenEnv));
}
/** @template {string} N @param {N} name @param {unknown} value @returns {value is Request<N>} */
function isRequest(name, value) {
  if (name !== "resources" || !record(value)) return false;
  if (value.operation === "hooks") return true;
  if (value.operation === "hooksSave")
    return text(value.expectedRevision) && Array.isArray(value.hooks) && value.hooks.every(hook);
  if (value.operation === "builtinSkill")
    return (
      value.id === "openai-skill-creator" &&
      Object.keys(value).every((key) => ["operation", "id"].includes(key))
    );
  if (
    !(value.scope === "user" || value.scope === "project") ||
    (value.projectId !== undefined && !text(value.projectId)) ||
    (value.scope === "project" && !text(value.projectId))
  )
    return false;
  if (value.operation === "skills" || value.operation === "mcp") return true;
  if (!text(value.id)) return false;
  if (value.operation === "skillRead") return true;
  if (value.operation === "mcpConnect" || value.operation === "mcpDisconnect")
    return (
      text(value.projectId) &&
      (value.expectedRevision === undefined || integer(value.expectedRevision))
    );
  if (!integer(value.expectedRevision)) return false;
  if (value.operation === "skillToggle") return typeof value.enabled === "boolean";
  if (value.operation === "skillSave")
    return (
      text(value.content) &&
      (value.name == null || text(value.name)) &&
      (value.description == null || text(value.description))
    );
  if (value.operation !== "mcpSave") return false;
  try {
    normalizeMcp(value.config);
    return true;
  } catch {
    return false;
  }
}
/** @param {unknown} value @returns {value is BuiltinSkill} */
function builtin(value) {
  return (
    record(value) &&
    record(value.skill) &&
    ["id", "revision", "name", "description"].every((k) =>
      text(value.skill && record(value.skill) ? value.skill[k] : undefined),
    ) &&
    record(value.provenance) &&
    ["upstream", "revision", "contentDigest"].every(
      (k) => record(value.provenance) && text(value.provenance[k]),
    )
  );
}
/** @param {unknown} value @returns {value is Skill} */
function skill(value) {
  return (
    record(value) &&
    text(value.id) &&
    text(value.scope) &&
    typeof value.managed === "boolean" &&
    typeof value.enabled === "boolean" &&
    text(value.name) &&
    (value.error === undefined
      ? text(value.root) && text(value.description) && text(value.revision)
      : text(value.error) &&
        value.enabled === false &&
        (value.root === undefined || text(value.root)))
  );
}
/** @param {unknown} value @returns {value is McpStatus} */
function mcpStatus(value) {
  return (
    record(value) &&
    integer(value.revision) &&
    Array.isArray(value.data) &&
    value.data.every(
      (item) =>
        record(item) &&
        text(item.id) &&
        text(item.state) &&
        mcpConfig(item.config) &&
        (item.scope === "user"
          ? text(item.runtimeId) &&
            integer(item.liveRevision) &&
            (item.revision === undefined || integer(item.revision))
          : item.scope === "project" && integer(item.revision)),
    )
  );
}
/** @param {unknown} value @returns {value is ResourceSaved} */
function saved(value) {
  return (
    record(value) && integer(value.revision) && (value.warning === null || text(value.warning))
  );
}
/** @template {string} N @template P @param {N} name @param {P} request @param {unknown} value @returns {value is Response<N,P>} */
function isResponse(name, request, value) {
  if (name !== "resources" || !record(request) || !record(value)) return false;
  if (request.operation === "hooks" || request.operation === "hooksSave")
    return (
      text(value.path) &&
      typeof value.external === "boolean" &&
      text(value.revision) &&
      Array.isArray(value.hooks) &&
      value.hooks.every(hook) &&
      Array.isArray(value.projects) &&
      value.projects.every(
        (item) =>
          record(item) &&
          text(item.projectId) &&
          text(item.root) &&
          typeof item.connected === "boolean" &&
          typeof item.applied === "boolean",
      )
    );
  if (request.operation === "builtinSkill") return builtin(value);
  if (request.operation === "skills")
    return (
      integer(value.revision) &&
      Array.isArray(value.data) &&
      value.data.every(
        (item) => record(item) && typeof item.overridden === "boolean" && skill(item),
      ) &&
      typeof value.customDeployment === "boolean"
    );
  if (request.operation === "skillRead")
    return text(value.content) && typeof value.truncated === "boolean";
  if (["mcp", "mcpConnect", "mcpDisconnect"].some((entry) => entry === request.operation))
    return mcpStatus(value);
  if (request.operation === "mcpSave")
    return request.scope === "project" ? mcpStatus(value) : saved(value);
  return ["skillSave", "skillToggle"].some((entry) => entry === request.operation) && saved(value);
}
/** @param {unknown} value @returns {Hook[]} */
function readHooks(value) {
  if (!Array.isArray(value) || !value.every(hook)) throw new Error("钩子配置结构无效");
  return value;
}
module.exports = {
  readHooks,
  record,
  resources,
  deployedSkills,
  deployment,
  mcpServers,
  pluginConnections,
  availableSkills,
  normalizeMcp,
  isRequest,
  isResponse,
  mcpConfig,
  hook,
  builtin,
};
