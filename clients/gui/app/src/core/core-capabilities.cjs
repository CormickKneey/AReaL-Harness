'use strict';
const { execFileSync } = require('node:child_process');
const { statSync } = require('node:fs');

const requiredCoreCommands = Object.freeze([
  Object.freeze(['config', 'models', 'read']),
  Object.freeze(['config', 'models', 'write']),
]);

function coreCommandHelp(binary, args) {
  try {
    return execFileSync(binary, [...args, '--help'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
}

function inspectCoreCapabilities(binary) {
  const missing = requiredCoreCommands.filter(args => /unrecognized subcommand/.test(coreCommandHelp(binary, args.slice(0, -1))));
  if (!missing.length) return;
  let identity = binary;
  try {
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const built = statSync(binary).mtime.toISOString();
    identity = `${binary}（${version}，构建时间 ${built}）`;
  } catch { /* 版本信息只用于诊断，缺少它不影响拒绝结果。 */ }
  const commands = missing.map(args => args.join(' ')).join('、');
  throw new Error(`当前 Core 不支持 ${commands}：${identity}。请在 AReaL-Harness 重新构建包含这些命令的 areal，再用新的绝对路径启动。`);
}

// Project only the current connection's public declaration. This does not
// grant permissions, start a workspace, or infer support from source/version.
function projectCoreCapabilities(binary, capabilities) {
  const methods = new Set(capabilities?.methods ?? []);
  const supports = (...required) => required.every(method => methods.has(method));
  return {
    binary,
    apiVersion: capabilities?.apiVersion ?? null,
    runtimeEpoch: capabilities?.runtime?.epoch ?? null,
    runtimeAvailable: capabilities ? capabilities.runtime != null : null,
    features: capabilities ? {
      conversation: supports('thread/start', 'turn/start'),
      browserToolAttachment: supports('areal/thread/tools/attach') && capabilities?.features?.browserToolAttachment === true
        && capabilities?.browserToolBundles?.some(bundle => bundle.bundleId === 'areal.browser.v1') === true,
      forkPreview: supports('areal/thread/fork', 'areal/conversation/history') && capabilities?.features?.conversationDerivationV1?.preview === true,
      goals: supports('areal/goal/create', 'areal/goal/get'),
      tasks: supports('areal/task/create', 'areal/inbox/list'),
      processes: supports('areal/process/start', 'areal/process/list', 'areal/process/get', 'areal/process/read', 'areal/process/write', 'areal/process/closeStdin', 'areal/process/wait', 'areal/process/terminate', 'areal/process/resize'),
      workgroups: supports('areal/workgroup/start', 'areal/workgroup/list'),
    } : null,
  };
}

module.exports = { requiredCoreCommands, inspectCoreCapabilities, projectCoreCapabilities };
