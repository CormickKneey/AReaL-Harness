import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BookOpen, Check, MoreHorizontal, Plus, Settings } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Switch } from "../components/ui/switch.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { Feedback } from "./common.js";
import type { ComposerSkill } from "../ComposerSkills.js";
import type { Action, Data } from "../services.js";

export type ResourceDraftSeed = { kind: "creator"; projectId: string }
  | { kind?: "resource"; text: string; skill?: ComposerSkill };
export type CenterSkill = {
  key: string;
  id: string;
  revision: string;
  name: string;
  description: string;
  enabled: boolean;
  scope: "user" | "project" | "plugin";
  sourceLabel: string;
  projectId?: string;
  pluginId?: string;
  catalogRevision?: number;
  error?: string;
};

async function skillBody(action: Action, skill: CenterSkill, project?: Data) {
  if (skill.scope !== "plugin") {
    const result = await action("resources", { operation: "skillRead", scope: skill.scope, projectId: skill.projectId, id: skill.id });
    if (result.truncated) throw new Error("Skill 正文超过可读取的 256 KiB 上限。");
    return String(result.content);
  }
  if (!project?.state?.connected) throw new Error("连接所属项目后读取 Skill 正文。");
  const profile = project.profiles.find((item: Data) => item.id === "areal-standard") ?? project.profiles[0];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const page = await action("manage", { operation: "skill", projectId: project.id,
      agentProfile: { id: profile?.id, revision: profile?.revision }, skill: { id: skill.id, revision: skill.revision },
      resource: "SKILL.md", offset, maxBytes: 8192 });
    if (page.sizeBytes > 256 * 1024) throw new Error("Skill 正文超过可读取的 256 KiB 上限。");
    chunks.push(Uint8Array.from(atob(page.dataBase64), char => char.charCodeAt(0)));
    if (page.eof) break;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Skill 分页无效。");
    offset = page.nextOffset;
  }
  const body = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) { body.set(chunk, position); position += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export function PluginSkillsPage({ action, projects, project, packageSkills, selected, onOpen, onManagePlugin,
  onStartDraft, compact, onCreate, createBusy,
}: {
  action: Action;
  projects: Data[];
  project?: Data;
  packageSkills: CenterSkill[];
  selected: CenterSkill | null;
  onOpen: (skill: CenterSkill) => void;
  onManagePlugin: (id: string) => void;
  onStartDraft: (seed: ResourceDraftSeed) => Promise<void>;
  compact: boolean;
  onCreate: () => void;
  createBusy: boolean;
}) {
  const [items, setItems] = useState<CenterSkill[]>([]);
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState("user");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const listId = useId();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [content, setContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  const generation = useRef(0);
  const projectKey = projects.filter(item => !item.projectless).map(item => `${item.id}:${item.root}`).join("|");
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    const owners = [{ scope: "user" as const, projectId: undefined, label: "个人" },
      ...projects.filter(item => !item.projectless).map(item => ({ scope: "project" as const, projectId: item.id as string, label: item.name || item.root.split(/[\\/]/).pop() }))];
    const results = await Promise.allSettled(owners.map(owner => action("resources", { operation: "skills", scope: owner.scope, projectId: owner.projectId })));
    if (generation.current !== version) return;
    const failures: string[] = [];
    setItems(results.flatMap((result, index) => {
      const owner = owners[index];
      if (result.status === "rejected") { failures.push(`${owner.label} · ${result.reason.message}`); return []; }
      return (result.value.data ?? []).map((item: Data) => ({ ...item, key: `${owner.scope}:${owner.projectId || "user"}:${item.id}`,
        scope: owner.scope, projectId: owner.projectId, sourceLabel: owner.label, catalogRevision: result.value.revision }));
    }));
    setError(failures.join(" "));
  }, [action, projectKey]);
  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    window.addEventListener("areal-plugins-changed", changed);
    return () => { generation.current++; window.removeEventListener("areal-plugins-changed", changed); };
  }, [refresh]);
  useEffect(() => {
    let current = true;
    setContent("");
    if (!selected) return;
    if (selected.scope === "plugin" && !selected.enabled) {
      setContentLoading(false); setError("");
      return;
    }
    setContentLoading(true); setError("");
    void skillBody(action, selected, projects.find(item => item.id === selected.projectId) ?? project)
      .then(value => { if (current) setContent(value); })
      .catch(cause => { if (current) setError(cause.message); })
      .finally(() => { if (current) setContentLoading(false); });
    return () => { current = false; };
  }, [selected?.key, selected?.revision, action, project?.state?.connected]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await work(); await refresh(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const toggle = (skill: CenterSkill) => run(async () => {
    await action("resources", { operation: "skillToggle", scope: skill.scope, projectId: skill.projectId,
      id: skill.id, enabled: !skill.enabled, expectedRevision: skill.catalogRevision });
    setMessage("已保存，将在新任务中生效。");
  });
  const startDraft = (skill: CenterSkill) => run(async () => onStartDraft({
    text: `请使用 ${skill.name} 帮助我完成任务。`,
    skill: { id: skill.id, revision: skill.revision, name: skill.name, description: skill.description, source: skill.sourceLabel },
  }));
  if (selected) return <article className="plugin-detail-page" data-testid="skill-detail-page">
    <header className="plugin-detail-header"><span className="plugin-resource-icon"><BookOpen size={28} /></span><div><h1>{selected.name}</h1><p>{selected.description}</p></div><div className="plugin-detail-actions">
      {selected.pluginId && <Button variant="outline" onClick={() => onManagePlugin(selected.pluginId!)}><Settings size={15} />管理插件</Button>}
      <Button disabled={busy || !selected.enabled || !!selected.error} onClick={() => void startDraft(selected)}>试用</Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多 Skill 操作"><MoreHorizontal size={18} /></Button>} /><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void navigator.clipboard.writeText(selected.id)}>复制 Skill 标识</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div></header>
    <Feedback error={error} message={message} />
    <dl className="plugin-metadata"><dt>来源</dt><dd>{selected.sourceLabel}</dd><dt>Skill 标识</dt><dd>{selected.id}</dd><dt>版本</dt><dd>{selected.revision}</dd><dt>状态</dt><dd>{selected.enabled ? "已启用" : "已停用"}</dd></dl>
    {selected.scope === "plugin" && !selected.enabled && <p role="status">启用所属插件后可读取 Skill 正文。</p>}
    {contentLoading && <p role="status">正在读取 Skill 内容…</p>}
    <div className="plugin-skill-content"><MessageResponse>{content}</MessageResponse></div>
  </article>;
  const all = [...items, ...packageSkills];
  const matches = (item: CenterSkill) => `${item.name} ${item.id} ${item.description} ${item.sourceLabel}`.toLowerCase().includes(query.trim().toLowerCase());
  const visible = all.filter(matches);
  const owners = [{ label: "个人", value: "user" }, ...projects.filter(item => !item.projectless).map(item => ({ label: item.name || item.root.split(/[\\/]/).pop(), value: item.id as string }))];
  const activeScope = owners.some(owner => owner.value === scopeId) ? scopeId : "user";
  const scoped = visible.filter(item => activeScope === "user" ? item.scope === "user" : item.projectId === activeScope);
  const search = <SettingsSearchInput aria-label="搜索 Skills" placeholder="搜索 Skills…" value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery("")} clearLabel="清除 Skill 搜索" />;
  const row = (item: CenterSkill) => <article className="plugin-catalog-row" key={item.key} aria-label={`${item.name} · ${item.sourceLabel}`}>
    <button className="plugin-row-info" aria-label={`查看技能 ${item.id}`} disabled={busy || !!item.error} onClick={() => onOpen(item)}>
      <span className="plugin-resource-icon plugin-skill-icon" aria-hidden="true"><svg width="16" height="18" viewBox="0 0 16 18"><path d="M8 1 14 4.5 8 8 2 4.5Z" fill="#ffd38a" /><path d="M2 4.5 8 8 8 16 2 12.5Z" fill="#ffe8bc" /><path d="M8 8 14 4.5 14 12.5 8 16Z" fill="#ad8be5" /></svg></span>
      <span><strong title={`${item.name} · ${item.sourceLabel}`}>{item.name}</strong><small className={compact ? undefined : "sr-only"}>{item.sourceLabel}</small><small>{item.error || item.description || item.id}</small></span>
    </button>
    {compact && item.pluginId ? <Button variant="ghost" onClick={() => onManagePlugin(item.pluginId!)}>管理插件</Button> : compact ? <Switch aria-label={`${item.enabled ? "停用" : "启用"}技能 ${item.id}`} checked={item.enabled} disabled={busy || !!item.error} onCheckedChange={() => void toggle(item)} /> : item.enabled && <Check size={14} className="plugin-skill-installed" aria-label="已启用" />}
  </article>;
  const preview = (values: CenterSkill[], key: string, label: string) => {
    const shown = expanded[key] || query.trim() ? values : values.slice(0, 6);
    const id = `${listId}-${key}`;
    return <section className="plugin-skill-section" aria-label={label}>
      <div id={id} className="plugin-catalog-grid">{shown.map(row)}</div>
      {!values.length && <p className="plugin-skill-empty">{query.trim() ? "没有匹配的 Skill" : "尚未安装 Skills"}</p>}
      {values.length > 6 && !query.trim() && <button className="plugin-skills-more" aria-expanded={!!expanded[key]} aria-controls={id} onClick={() => setExpanded(current => ({ ...current, [key]: !current[key] }))}>{expanded[key] ? "收起" : `查看更多，另有 ${values.length - 6} 个 Skill`}</button>}
    </section>;
  };
  if (compact) return <section className="plugin-skills plugin-skills-compact">
    <div className="plugin-skills-toolbar"><h2>已安装 <small>{all.length}</small></h2>{search}<Button disabled={createBusy} onClick={onCreate}><Plus size={15} />创建 Skill</Button></div>
    <Feedback error={error} message={message} />
    <div className="plugin-row-list">{visible.map(row)}</div>
    {!visible.length && <div className="resource-empty"><BookOpen size={28} /><strong>{query ? "没有匹配的 Skill" : "尚未安装 Skills"}</strong><p>{query ? "试试其他名称或关键词。" : "创建可复用的 Skill，或从插件市场安装。"}</p></div>}
  </section>;
  return <section className="plugin-skills plugin-skills-workspace">
    <header className="plugin-center-header plugin-skills-header"><div><h1>Skills</h1><p>为不同任务添加可复用的专业能力。</p></div><div className="plugin-center-toolbar">{search}<Button disabled={createBusy} onClick={onCreate} title={`在${project?.name || "所选项目"}中创建 Skill`}><Plus size={14} />创建 Skill</Button></div></header>
    <Feedback error={error} message={message} />
    <div className="plugin-skill-section-heading"><h2>已安装 <small>{all.length}</small></h2></div>
    {preview(visible, "installed", "已安装 Skills")}
    <div className="plugin-skill-source-tabs"><SettingsSegmentedTabs ariaLabel="Skill 来源" items={owners} value={activeScope} onValueChange={setScopeId} /></div>
    {preview(scoped, `scope-${activeScope}`, `${owners.find(owner => owner.value === activeScope)?.label}的 Skills`)}
  </section>;
}
