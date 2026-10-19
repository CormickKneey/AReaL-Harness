'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { realpath } = require('node:fs/promises');
const execute = promisify(execFile);

async function assertPackageUsersReleased({ packaged, executable = process.execPath } = {}) {
  if (!packaged || process.platform !== 'darwin') return;
  const actual = await realpath(executable);
  const boundary = actual.lastIndexOf('.app/Contents/');
  if (boundary < 0) throw new Error('无法核对当前安装包来源');
  const bundle = actual.slice(0, boundary + 4);
  const { stdout } = await execute('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,comm='], { maxBuffer: 4 * 1024 * 1024 });
  const processes = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3] }] : [];
  });
  const current = new Set([process.pid]);
  for (;;) {
    const before = current.size;
    for (const child of processes) if (current.has(child.parent)) current.add(child.pid);
    if (current.size === before) break;
  }
  const paths = new Map();
  for (const child of processes) if (!current.has(child.pid) && child.executable.startsWith('/') && !paths.has(child.executable))
    paths.set(child.executable, realpath(child.executable).catch(() => null));
  await Promise.all([...paths].map(async ([path, actual]) => paths.set(path, await actual)));
  const unknown = processes.filter(child => !current.has(child.pid) && child.executable.startsWith(bundle + '/') && paths.get(child.executable) === null);
  if (unknown.length) throw Object.assign(new Error('无法核对部分运行程序的安装来源，请先退出这些程序再重试安装。进程 ' + unknown.map(child => child.pid).join('、')),
    { code: 'LIFECYCLE_BLOCKED' });
  const blockers = processes.filter(child => !current.has(child.pid) && paths.get(child.executable)?.startsWith(bundle + '/'));
  if (blockers.length) throw Object.assign(new Error('这份安装包仍被其他应用会话或独立 CLI 使用。请从其原配置目录安全退出后重试安装。进程 ' + blockers.map(child => child.pid).join('、')),
    { code: 'LIFECYCLE_BLOCKED' });
}
module.exports = { assertPackageUsersReleased };
