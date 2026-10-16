import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useSettingsOperation } from "./useSettingsOperation.js";
import { useDraftBlocker, useGuardedNavigation } from "./UnsavedChanges.js";
import { ModelEditor } from "./ModelEditor.js";
import { ChatGPTSubscription } from "./ChatGPTSubscription.js";
import { useEffect, useState } from "react";
import { Pencil, Trash2, Unplug, ArrowUp, ArrowDown, RefreshCw, MoreHorizontal } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.js";
import { DialogFooter } from "../components/ui/dialog.js";
import { EmptySettings, Feedback, SettingsDialog, useResource } from "./common.js";
import { ConnectionMethodPicker } from "./ConnectionMethodPicker.js";
import { newConnectionDraft } from "./provider-ui-state.js";
import { ProviderTemplatePicker } from "./ProviderTemplatePicker.js";
import { ProviderApiKeySection, ProviderConnectionSection } from "./model-provider-section/ProviderCardSections.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import "./ModelSettings.css";
import type { Action, Data } from "../services.js";

const CHATGPT = "chatgpt";
export function ModelSettings({ action, onOpenSessionSettings }: { action: Action; onOpenSessionSettings: () => void }) {
  const navigate = useGuardedNavigation();
  const api = (operation: string, values: Data = {}) => action("providers", { operation, ...values });
  const state = useResource(() => api("list"), "application");
  const [accountModels, setAccountModels] = useState<Data[]>([]);
  const [connectionChoice, setConnectionChoice] = useState<Data | null>(null);
  const [accountLabel, setAccountLabel] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [detailTab, setDetailTab] = useState("models");
  const [accountReady, setAccountReady] = useState(false);
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState<Data | null>(null);
  const [key, setKey] = useState<string | undefined>();
  const [keyVisible, setKeyVisible] = useState(false);
  const { busy, error, message, setError, setMessage, run, execute } = useSettingsOperation();
  const [remove, setRemove] = useState<Data | null>(null);
  const [modelDraft, setModelDraft] = useState<{ model: Data; index: number } | null>(null);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [probe, setProbe] = useState<Data>({});
  const items: Data[] = state.value?.data ?? [];
  const provider = draft ?? items.find(p => p.id === selected);
  const authentication = provider?.authentication ?? (provider?.apiKeyEnv ? "apiKey" : "none");
  const visibleModels = (provider?.models ?? []).map((model: Data, index: number) => ({ model, index })).filter(({ model }: { model: Data }) => `${model.displayName ?? ""} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase()));
  const edit = (patch: Data) => setDraft({ ...provider, ...patch, basedOnRevision: draft?.basedOnRevision ?? state.value?.revision });
  const select = (item: Data) => { setSelected(item.id); setPicker(false); setConnectionChoice(null); setDraft(null); setKey(undefined); setKeyVisible(false); setModelQuery(""); setError(""); setMessage(""); };
  const choose = (id: string) => navigate(() => { setSelected(id); setDetailTab("models"); setPicker(false); setConnectionChoice(null); setDraft(null); setKey(undefined); setKeyVisible(false); setModelQuery(""); setError(""); setMessage(""); });
  const save = async (candidate = provider, apiKey = key) => {
    if (!candidate) throw new Error("没有可保存的供应商");
    let result: Data;
    try {
      result = await api("saveAndApply", { expectedRevision: candidate.basedOnRevision ?? state.value?.revision, provider: candidate, authentication: candidate.authentication ?? (candidate.apiKeyEnv ? "apiKey" : "none"), ...(apiKey !== undefined ? { apiKey } : {}) });
    } catch (cause) {
      const previous = state.value;
      const current = await state.refresh();
      // 仅在原目录完整恢复时更新 CAS 基线；外部编辑冲突不能被重试覆盖。
      if (current && JSON.stringify([current.data, current.defaultModel]) === JSON.stringify([previous?.data, previous?.defaultModel]))
        setDraft(value => value ? { ...value, basedOnRevision: current.revision } : value);
      throw cause;
    }
    const saved = candidate.id ? result.data.find((p: Data) => p.id === candidate.id) : result.data.at(-1);
    state.accept(result); select(saved); setProbe({});
    setMessage("");
    return saved;
  };
  const baseline = items.find(item => item.id === selected);
  // 开关与输入框是草稿；状态只投影 Core 的已保存目录和凭据诊断。
  const savedStatus = (item?: Data) => !item ? "未保存" : !item.enabled ? "已停用"
    : state.value?.credentialStates?.[item.id] === "unavailable" ? "缺少凭据" : "可用";
  const dirty = key !== undefined || (draft !== null && (!baseline || Object.keys(draft).some(field => field !== "basedOnRevision" && JSON.stringify(draft[field]) !== JSON.stringify(field === "authentication" ? baseline.apiKeyEnv ? "apiKey" : "none" : baseline[field]))));
  const discard = () => { setDraft(null); setKey(undefined); setKeyVisible(false); setError(""); };
  useDraftBlocker({
    label: "供应商",
    dirty,
    busy,
    discard,
    save: () => execute(async () => { await save(); }),
  });
  const saveThen = (task: (saved: Data) => Promise<void>) => run(async () => { const saved = draft || key !== undefined ? await save() : provider; await task(saved); });
  const current = selected ?? (accountModels.length ? CHATGPT : items.find(item => item.enabled)?.id ?? items[0]?.id ?? null);
  useEffect(() => {
    // 初始选择只决定一次；账号临时状态变化不能把用户移到另一份连接配置。
    if (selected === null && !picker && state.value && accountLabel) setSelected(accountModels.length ? CHATGPT : items.find(item => item.enabled)?.id ?? items[0]?.id ?? CHATGPT);
  }, [selected, picker, state.value, accountLabel, accountModels.length]);
  const refreshCatalog = () => navigate(() => { discard(); void state.refresh(); });
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const catalog = [
    { id: CHATGPT, name: "ChatGPT", enabled: accountModels.length > 0, detail: accountLabel || "订阅 · 状态待刷新" },
    ...items.map(item => ({ id: item.id as string, name: item.name as string, enabled: !!item.enabled, detail: savedStatus(item) })),
  ].filter(item => matches(item.name));
  const enabled = catalog.filter(item => item.enabled);
  const disabled = catalog.filter(item => !item.enabled);
  const overrides = Object.entries(state.value?.effective?.sources ?? {}).filter(([field, source]) => field.startsWith("model.") && ["env", "cli"].includes((source as Data).kind));
  const defaultModel = state.value?.defaultModel;
  const isDefault = (providerId: string, modelId: string) => defaultModel?.providerId === providerId && defaultModel?.modelId === modelId;
  const changeDefault = (providerId: string, modelId: string) => run(async () => {
    try {
      state.accept(await api("defaultAndApply", { expectedRevision: state.value?.revision, model: { providerId, modelId } }));
    } catch (cause) {
      await state.refresh();
      throw cause;
    }
  });
  const subscriptionModels = accountModels.filter(model => `${model.displayName ?? model.name ?? ""} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase()));
  const modelSearch = <SettingsSearchInput placeholder="搜索模型名称或 ID" aria-label="搜索模型名称或 ID" value={modelQuery} onChange={e => setModelQuery(e.target.value)} onClear={() => setModelQuery("")} clearLabel="清除模型搜索" containerClassName="provider-model-search" />;
  return <div className="model-settings">
    <Feedback error={state.error || error} message={message} />
    <div className="provider-settings" data-provider={current === CHATGPT && !picker ? CHATGPT : "custom"}>
      <aside className="provider-navigation" aria-label="供应商目录">
        <div className="provider-navigation-top"><h2>供应商</h2><Button variant="ghost" size="icon" aria-label="刷新供应商" disabled={busy || state.loading} onClick={refreshCatalog}><RefreshCw size={16} /></Button></div>
        <SettingsSearchInput placeholder="搜索供应商" aria-label="搜索供应商" value={query} onChange={e => setQuery(e.target.value)} onClear={() => setQuery("")} clearLabel="清除搜索" />

        <div className="provider-catalog">
          {[["已启用", enabled], ["未启用", disabled]].map(([label, group]) => (group as typeof catalog).length ? <section key={label as string}>
            <p className="provider-catalog-label">{label as string}</p>
            {(group as typeof catalog).map(item => <button type="button" className="provider-catalog-row" key={item.id} aria-current={current === item.id} data-enabled={item.enabled} disabled={busy} onClick={() => choose(item.id)}>
              <span className="provider-catalog-dot" aria-hidden="true" />
              <span>{item.name}</span>
              <small>{item.detail}</small>
            </button>)}
          </section> : null)}
          {!catalog.length && <p className="settings-muted provider-list-empty">{state.loading ? "正在加载供应商…" : query ? "没有匹配的供应商" : "尚未添加供应商"}</p>}
        </div>
        <Button className="provider-catalog-add" variant="outline" disabled={busy} onClick={() => navigate(() => { discard(); setPicker(true); setConnectionChoice(null); setSelected(null); setMessage(""); })}>添加供应商</Button>
      </aside>
      <div className="provider-detail">
        <div className="provider-file-status" role="status" aria-label="配置状态">
          {busy ? "正在保存…" : state.value?.pendingApply ? "配置已在其他位置变更" : !state.value ? "正在读取…" : ""}
        </div>
        {overrides.length > 0 && <p className="settings-muted" role="status">命令行或环境配置覆盖了文件值；保存不会修改这些覆盖。{overrides.map(([field, source]) => `${field}：${(source as Data).name ?? (source as Data).flag}`).join(" ")}</p>}
        {picker && (connectionChoice ? <ConnectionMethodPicker definition={connectionChoice} disabled={busy} onBack={() => setConnectionChoice(null)} onSelect={authentication => {
          if (authentication === "siwc") { choose(CHATGPT); setDetailTab("connection"); return; }
          setSelected(""); setDraft(newConnectionDraft(connectionChoice, authentication, state.value?.revision));
          setKey(authentication === "apiKey" ? "" : undefined); setKeyVisible(false); setPicker(false); setConnectionChoice(null); setDetailTab("connection"); setError("");
        }} /> : <ProviderTemplatePicker disabled={busy} onBack={() => choose(current ?? CHATGPT)} onCreate={setConnectionChoice} />)}
        <div hidden={picker || (current !== CHATGPT && !provider)}>
          <header className="provider-detail-heading">
            <div><h2>{current === CHATGPT ? "ChatGPT" : provider?.name || "新供应商"}</h2><p className="settings-muted" role="status" aria-label="供应商状态">{current === CHATGPT ? accountLabel || "正在读取订阅状态…" : savedStatus(baseline)}</p></div>
            {current !== CHATGPT && provider && <label className="provider-enable-control">启用<Switch disabled={busy} aria-label="启用供应商" checked={provider.enabled} onCheckedChange={enabled => edit({ enabled })} /></label>}
          </header>
          <Tabs value={detailTab} onValueChange={value => setDetailTab(value as string)}>
            <TabsList variant="line" aria-label="供应商设置" className="provider-detail-tabs">
              <TabsTrigger value="models" disabled={busy}>模型</TabsTrigger>
              <TabsTrigger value="connection" disabled={busy}>连接配置</TabsTrigger>
            </TabsList>
            <TabsContent value="models" keepMounted>
              {current === CHATGPT ? <div className="provider-model-section">
                <div className="provider-connection-summary"><span>{accountLabel || "ChatGPT 订阅"}</span><Button variant="outline" onClick={() => setDetailTab("connection")}>管理账号</Button></div>
                <h3>模型 · {accountModels.length}</h3>
                {modelSearch}
                <div className="subscription-model-list provider-model-scroll" aria-label="ChatGPT 模型">
                  {subscriptionModels.map(model => <div key={model.id} className="provider-model-row">
                    <div className="provider-model-label"><strong>{model.displayName || model.name || model.id}</strong></div>
                    {isDefault("areal_openai", model.id) && <span className="provider-model-default">新会话默认</span>}
                    <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`模型 ${model.displayName || model.name || model.id} 更多操作`} disabled={busy} />}><MoreHorizontal size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={busy || !accountReady || isDefault("areal_openai", model.id)} onClick={() => void changeDefault("areal_openai", model.id)}>设为新会话默认</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
                  </div>)}
                  {!subscriptionModels.length && <p className="settings-muted provider-list-empty">{modelQuery ? "没有匹配的模型" : accountReady ? "当前账号没有可用模型。" : "前往连接配置登录或刷新账号，以读取模型。"}</p>}
                </div>
              </div> : provider ? <fieldset disabled={busy} className="provider-inline">
          <div className="provider-model-section">
            <div className="provider-connection-summary"><span>{dirty ? "有未保存的修改" : "连接已配置"}</span><Button variant="outline" disabled={busy || !provider.enabled || !provider.models.some((m: Data) => m.enabled)} onClick={() => void saveThen(async saved => { const model = saved.models.find((m: Data) => m.enabled); await api("probe", { id: saved.id, model: model.id }); setProbe(p => ({ ...p, [model.id]: "连接成功" })); setMessage(`模型 ${model.id} 连接成功`); })}>测试连接</Button></div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
              <span className="text-ui-base text-foreground-subtle">模型 · {provider.models.length}</span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void saveThen(async saved => { const result = await api("discover", { id: saved.id }); setDiscovered(result.models); setChecked([]); })}>获取模型</Button>
                <Button variant="secondary" onClick={() => setModelDraft({ model: { id: "", enabled: true, parameters: {} }, index: -1 })}>添加模型</Button>
              </div>
            </div>
            {modelSearch}
            {provider.models.length ? <div className="provider-model-scroll overflow-hidden rounded-lg border border-input-border bg-input">
              {visibleModels.map(({ model, index }: { model: Data; index: number }) => <div key={`${model.id}:${index}`} className="provider-model-row flex items-center gap-2 px-3 py-2 border-b border-input-border last:border-b-0">
                <div className="min-w-0 flex-1 provider-model-label"><strong>{model.displayName || model.id}</strong>{model.displayName && model.displayName !== model.id && <small>{model.id}</small>}</div>
                {isDefault(provider.id, model.id) && <span className="provider-model-default">新会话默认</span>}
                {probe[model.id] && <small>{probe[model.id]}</small>}
                <Switch disabled={busy} size="sm" aria-label={`启用模型 ${model.id}`} checked={model.enabled} onCheckedChange={enabled => edit({ models: provider.models.map((m: Data, i: number) => i === index ? { ...m, enabled } : m) })} />
                <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`模型 ${model.displayName || model.id} 更多操作`} disabled={busy} />}><MoreHorizontal size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem aria-label={`测试模型 ${model.id}`} disabled={busy || !provider.enabled || !model.enabled} onClick={() => void saveThen(async saved => { await api("probe", { id: saved.id, model: model.id }); setProbe(p => ({ ...p, [model.id]: "连接成功" })); setMessage(`模型 ${model.id} 连接成功`); })}><Unplug size={14} />测试连接</DropdownMenuItem>
                <DropdownMenuItem disabled={busy || dirty || !provider.enabled || !model.enabled || isDefault(provider.id, model.id)} onClick={() => void changeDefault(provider.id, model.id)}>设为新会话默认</DropdownMenuItem>
                <DropdownMenuItem aria-label={`编辑模型 ${model.id}`} disabled={busy} onClick={() => setModelDraft({ model, index })}><Pencil size={14} />编辑模型</DropdownMenuItem>
                <DropdownMenuItem aria-label={`上移模型 ${model.id}`} disabled={busy || index === 0} onClick={() => { const models = [...provider.models]; [models[index - 1], models[index]] = [models[index], models[index - 1]]; edit({ models }); }}><ArrowUp size={14} />上移</DropdownMenuItem>
                <DropdownMenuItem aria-label={`下移模型 ${model.id}`} disabled={busy || index === provider.models.length - 1} onClick={() => { const models = [...provider.models]; [models[index + 1], models[index]] = [models[index], models[index + 1]]; edit({ models }); }}><ArrowDown size={14} />下移</DropdownMenuItem>
                <DropdownMenuItem aria-label={`删除模型 ${model.id}`} disabled={busy} onClick={() => edit({ models: provider.models.filter((_: Data, i: number) => i !== index) })}><Trash2 size={14} />删除模型</DropdownMenuItem>
                </DropdownMenuContent></DropdownMenu>
              </div>)}
              {!visibleModels.length && <p className="settings-muted p-3">没有匹配的模型</p>}
            </div> : <div className="mt-1 flex h-12 items-center rounded-lg border border-dashed border-border px-4 text-ui-base text-foreground-subtle">暂无模型，点击添加模型或从服务获取。</div>}
          </div>

              </fieldset> : null}
            </TabsContent>
            <TabsContent value="connection" keepMounted>
              <div className="chatgpt-subscription-panel"><ChatGPTSubscription action={action} onModelsChange={setAccountModels} onAccountChange={setAccountLabel} onReadyChange={setAccountReady} /></div>
              {current !== CHATGPT && provider && <fieldset disabled={busy} className="provider-inline provider-connection-form">
          <div className="provider-name-field"><label className="settings-muted" htmlFor="provider-name">供应商名称</label>
            <div className="provider-name-control"><Input id="provider-name" aria-label="供应商名称" size="lg" value={provider.name} onChange={e => edit({ name: e.target.value })} className="flex-1 font-semibold" />
            {provider.id && <Button variant="ghost" size="icon" aria-label={`移除 ${provider.name}`} onClick={() => navigate(() => setRemove(provider))}><Trash2 size={16} /></Button>}
            </div>
          </div>
          <div className="provider-connection-fields">
          <ProviderConnectionSection provider={{ config: { api: { baseUrl: provider.baseUrl, type: provider.protocol } } }} apiFormat={provider.protocol} baseUrlValue={provider.baseUrl} onApiFormatChange={protocol => edit({ protocol })} onBaseUrlChange={baseUrl => edit({ baseUrl })} onBaseUrlBlur={() => {}} />
          <div>
            <span className="mb-1 block text-ui-base text-foreground-subtle">认证方式</span>
            <SettingsSelect aria-label="认证方式" value={authentication} onValueChange={value => {
              edit({ authentication: value as "apiKey" | "none" }); setError(""); if (value === "none") setKey(undefined);
            }}><option value="apiKey">API Key</option><option value="none">无需认证</option></SettingsSelect>
          </div>
          </div>
          {authentication === "apiKey" ? <>
            <ProviderApiKeySection apiKeyValue={key ?? ""} apiKeyVisible={keyVisible} onApiKeyChange={value => { setKey(value); edit({}); }} onToggleApiKeyVisibility={() => setKeyVisible(!keyVisible)} onApiKeyBlur={() => {}} />
          </> : null}
          <SettingsDisclosure title={<> 高级参数 </>}><div className="settings-field-pair mt-3">
            <label>默认温度<Input type="number" min={0} max={2} step={0.1} value={provider.parameters.temperature ?? ""} onChange={e => edit({ parameters: { ...provider.parameters, temperature: e.target.value === "" ? null : Number(e.target.value) } })} /></label>
            <label>最大输出 Token<Input type="number" min={1} step={1} value={provider.parameters.maxOutputTokens ?? ""} onChange={e => edit({ parameters: { ...provider.parameters, maxOutputTokens: e.target.value === "" ? null : Number(e.target.value) } })} /></label>
          </div></SettingsDisclosure>

              </fieldset>}
            </TabsContent>
          </Tabs>
          {current !== CHATGPT && provider && <div className="provider-save-actions"><span role="status" className="settings-muted">{dirty ? "有未保存的修改" : ""}</span><Button variant="outline" disabled={busy || !dirty} onClick={() => provider.id ? navigate(discard) : choose(items[0]?.id ?? CHATGPT)}>取消修改</Button><Button disabled={busy || (!dirty && !state.value?.pendingApply)} onClick={() => void run(async () => { await save(); })}>{busy ? "保存中…" : "保存"}</Button></div>}
        </div>
        {!picker && current !== CHATGPT && !provider && <EmptySettings>{state.loading ? "正在加载供应商…" : "选择左侧供应商，或添加一个新的供应商。"}</EmptySettings>}
        <footer className="provider-default-link"><span>新会话默认模型</span><Button variant="link" disabled={busy} onClick={onOpenSessionSettings}>前往会话配置</Button></footer>
      </div>
    </div>
    {modelDraft && provider && <ModelEditor model={modelDraft.model} editing={modelDraft.index >= 0} ids={provider.models.filter((_: Data, i: number) => i !== modelDraft.index).map((m: Data) => m.id)} onClose={() => setModelDraft(null)} onSave={model => { const models = [...provider.models]; if (modelDraft.index < 0) models.push(model); else models[modelDraft.index] = model; edit({ models }); setModelDraft(null); }} />}

    {discovered && provider && <SettingsDialog title="选择模型" description="从服务返回的模型列表中选择添加。" onClose={() => setDiscovered(null)}><div className="max-h-80 overflow-auto">{discovered.map(id => <label key={id} className="flex gap-3 p-2"><input type="checkbox" checked={checked.includes(id)} onChange={e => setChecked(e.target.checked ? [...checked, id] : checked.filter(v => v !== id))} />{id}</label>)}</div><Button onClick={() => { edit({ models: [...provider.models, ...checked.filter(id => !provider.models.some((m: Data) => m.id === id)).map(id => ({ id, enabled: true }))] }); setDiscovered(null); }}>添加所选模型</Button></SettingsDialog>}
    {remove && <SettingsDialog className="settings-confirm-dialog" title="移除供应商？" description={`移除 ${remove.name} 后，引用该供应商的任务需要重新选择模型。历史消息保留。`} onClose={() => setRemove(null)} busy={busy}><Feedback error={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemove(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await api("removeAndApply", { id: remove.id, expectedRevision: state.value?.revision }); setRemove(null); setDraft(null); setKey(undefined); setSelected(items.find(item => item.id !== remove.id)?.id ?? (accountModels.length ? CHATGPT : null)); await state.refresh(); })}>{busy ? "移除中…" : "移除"}</Button></DialogFooter></SettingsDialog>}
  </div>;
}
