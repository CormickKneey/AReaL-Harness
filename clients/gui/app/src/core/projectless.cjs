'use strict';
const { readFile, mkdir, realpath, stat } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { homedir } = require('node:os');

// Desktop reserves workspace roots; Core remains the sole owner of threads and
// execution. Repeating a preparation ID never creates another root or a turn.
class ProjectlessWorkspaces {
  constructor(backend) { this.backend = backend; this.records = {}; this.pending = Promise.resolve(); }
  async init() {
    try { this.records = JSON.parse(await readFile(join(this.backend.home, 'projectless-drafts.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot() { return { directory: this.backend.library.value.settings.projectlessDirectory ?? join(this.backend.userHome ?? homedir(), 'Documents', 'AReaL') }; }
  async command(request) {
    if (request.operation === 'directory') {
      if (typeof request.path !== 'string' || !isAbsolute(request.path)) throw new Error('请选择绝对目录路径');
      const directory = await realpath(request.path);
      if (!(await stat(directory)).isDirectory()) throw new Error('请选择文件夹');
      await this.backend.library.change(state => { state.settings.projectlessDirectory = directory; });
      return this.snapshot();
    }
    if (request.operation !== 'prepare' || typeof request.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.requestId)) throw new Error('无效项目外草稿标识');
    const next = this.pending.catch(() => {}).then(async () => {
      const id = request.requestId;
      let selected;
      if (request.directory !== undefined) {
        if (typeof request.directory !== 'string' || !isAbsolute(request.directory) || request.directory.split(/[\\/]/).includes('..')) throw new Error('请选择现有文件夹的绝对路径');
        selected = await realpath(request.directory);
        if (!(await stat(selected)).isDirectory()) throw new Error('请选择现有文件夹');
      }
      let record = this.records[id];
      if (record && selected !== undefined && selected !== record.root) throw new Error('此草稿已绑定原工作目录，不能重新绑定；请创建新草稿');
      const normalProject = root => this.backend.saved.find(project => project.root === root && !project.projectless);
      if (normalProject(record?.root ?? selected)) throw new Error('此目录已属于已有项目，请选择该项目创建任务');
      if (!record) {
        if (selected === undefined) {
          const base = this.snapshot().directory;
          await mkdir(base, { recursive: true, mode: 0o700 });
          selected = join(await realpath(base), id);
        }
        record = { root: selected, ...(request.directory !== undefined ? { existing: true } : {}) };
        if (normalProject(record.root)) throw new Error('此目录已属于已有项目，请选择该项目创建任务');
        const records = { ...this.records, [id]: record };
        await this.backend.save('projectless-drafts.json', records);
        this.records = records;
      }
      if (record.existing || this.backend.saved.some(project => project.projectlessRequestId === id)) {
        if (!(await stat(record.root)).isDirectory()) throw new Error('原项目外目录不可用');
      } else await mkdir(record.root, { recursive: true, mode: 0o700 });
      if (await realpath(record.root) !== record.root) throw new Error('项目外目录已被替换，请检查原目录后重试');
      const projectId = await this.backend.addProjectPath(record.root, undefined, id);
      if (normalProject(record.root)) throw new Error('此目录已属于已有项目，请选择该项目创建任务');
      return { projectId, cwd: record.root };
    });
    this.pending = next.catch(() => {});
    return next;
  }
}
module.exports = { ProjectlessWorkspaces };
