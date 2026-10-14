import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Feedback } from "./common.js";

type RecordValue = Record<string, unknown>;
type Definition = {
  id: string;
  event: string;
  matcher: string | null;
  handler: RecordValue;
  timeout_secs: number;
  status_message?: string | null;
  async: boolean;
};
type HookView = {
  pluginId: string;
  installedDigest: string;
  definitionDigest: string;
  definitions: { definition: Definition; trusted: boolean }[];
  diagnostics: string[];
};
type Props = {
  id: string;
  installedDigest: string;
  disabled: boolean;
  api: (operation: string, values?: RecordValue) => Promise<unknown>;
  onConfigure: (parameters: RecordValue) => Promise<void> | void;
  refreshKey?: string | number;
};
const object = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function readView(value: unknown, id: string, digest: string): HookView {
  if (!object(value) || !Array.isArray(value.data)) throw new Error("插件钩子响应格式无效。");
  const row: unknown = value.data.find((entry: unknown) => object(entry) && entry.pluginId === id);
  if (!object(row)) throw new Error("当前插件的钩子不可用，请刷新插件详情。");
  if (row.installedDigest !== digest) throw new Error("已安装包已变化，请刷新插件详情后重新审阅。");
  if (typeof row.definitionDigest !== "string" || !row.definitionDigest || !Array.isArray(row.definitions)
    || !Array.isArray(row.diagnostics) || !row.diagnostics.every((d: unknown) => typeof d === "string")) {
    throw new Error("插件钩子响应格式无效。");
  }
  const definitions = row.definitions.map((entry: unknown) => {
    if (!object(entry) || typeof entry.trusted !== "boolean" || !object(entry.definition)) throw new Error("钩子定义格式无效。");
    const definition = entry.definition;
    if (typeof definition.id !== "string" || typeof definition.event !== "string"
      || (definition.matcher !== null && typeof definition.matcher !== "string")
      || !object(definition.handler) || typeof definition.timeout_secs !== "number"
      || !Number.isFinite(definition.timeout_secs) || typeof definition.async !== "boolean"
      || (definition.status_message != null && typeof definition.status_message !== "string")) {
      throw new Error("钩子定义格式无效。");
    }
    return { definition: definition as Definition, trusted: entry.trusted };
  });
  return { pluginId: id, installedDigest: digest, definitionDigest: row.definitionDigest,
    definitions, diagnostics: row.diagnostics as string[] };
}
const message = (error: unknown) => error instanceof Error ? error.message : "读取插件钩子失败。";

export function PluginHookSettings({ id, installedDigest, disabled, api, onConfigure, refreshKey }: Props) {
  const [view, setView] = useState<HookView>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewedIdentity, setReviewedIdentity] = useState<string>();
  const generation = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const next = readView(await apiRef.current("pluginHooks"), id, installedDigest);
      if (generation.current === request) {
        const nextIdentity = JSON.stringify([id, installedDigest, next.definitionDigest]);
        setReviewedIdentity(previous => previous === nextIdentity ? previous : undefined);
        setView(next);
      }
    } catch (cause) {
      if (generation.current === request) { setError(message(cause)); setView(undefined); setReviewedIdentity(undefined); }
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [id, installedDigest]);
  useEffect(() => {
    setReviewedIdentity(undefined); setView(undefined); setBusy(false);
    void refresh();
    return () => { ++generation.current; };
  }, [refresh, refreshKey]);
  // Identity gating also applies during the render preceding effect cleanup.
  const current = view?.pluginId === id && view.installedDigest === installedDigest ? view : undefined;
  const identity = current ? JSON.stringify([id, installedDigest, current.definitionDigest]) : undefined;
  const reviewed = !!identity && reviewedIdentity === identity;
  const blocked = disabled || loading || busy || !current || !!error;
  const configure = async (trusted: boolean) => {
    if (blocked || !current || (trusted && !reviewed)) return;
    const request = generation.current;
    setBusy(true); setError(""); setReviewedIdentity(undefined);
    try {
      // The parent owns durable submission/UNKNOWN recovery. Never retry this mutation.
      await onConfigure({ id, expectedDigest: installedDigest, definitionDigest: current.definitionDigest,
        enabled: trusted, trusted });
      if (generation.current === request) { setBusy(false); await refresh(); }
    } catch (cause) {
      if (generation.current === request) setError(cause instanceof Error ? cause.message : "钩子配置未完成，请核对提交状态。");
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };
  return <section aria-label="插件钩子" className="space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h4>插件钩子</h4>
      <Button variant="outline" size="sm" disabled={disabled || busy || loading} onClick={() => void refresh()}>刷新钩子</Button>
    </div>
    <p className="text-foreground-subtle text-ui-sm">钩子可运行 shell 命令或调用已连接的 MCP 工具。安装、启用插件或连接 MCP 均不会授予钩子信任。</p>
    <Feedback error={error} message={loading ? "正在读取当前安装包的钩子…" : undefined} />
    {current && <>
      <dl className="text-ui-sm space-y-1">
        <dt>已安装包摘要</dt><dd className="break-all font-mono">{current.installedDigest}</dd>
        <dt>当前定义摘要</dt><dd className="break-all font-mono">{current.definitionDigest}</dd>
      </dl>
      {current.diagnostics.map((diagnostic, index) => <p className="text-ui-sm" key={index}>{diagnostic}</p>)}
      {current.definitions.length === 0 ? <p>当前安装包没有可执行的钩子定义。</p> : <>
        <ul className="space-y-3">
          {current.definitions.map(({ definition, trusted }, index) => <li key={`${definition.id}:${index}`} className="space-y-1 rounded-md border p-3">
            <p><strong>{definition.event}</strong> · {trusted ? "当前定义已获信任" : "尚未授予信任"}</p>
            <p className="text-ui-sm">匹配：{definition.matcher || "全部"} · 超时：{definition.timeout_secs} 秒 · {definition.async ? "后台执行" : "同步执行"}</p>
            {definition.status_message && <p className="text-ui-sm">状态提示：{definition.status_message}</p>}
            <p className="text-ui-sm">{definition.handler.type === "command" ? "Shell 命令" : "MCP 工具及参数"}</p>
            <pre className="whitespace-pre-wrap break-all text-ui-sm">{definition.handler.type === "command"
              ? String(definition.handler.command ?? "") : JSON.stringify(definition.handler, null, 2)}</pre>
            {typeof definition.handler.command_windows === "string" && <p className="whitespace-pre-wrap break-all text-ui-sm">Windows 命令：{definition.handler.command_windows}</p>}
            <details><summary className="text-ui-sm">完整定义</summary><pre className="whitespace-pre-wrap break-all text-ui-sm">{JSON.stringify(definition, null, 2)}</pre></details>
          </li>)}
        </ul>
        <label className="flex items-start gap-2 text-ui-sm">
          <input type="checkbox" checked={reviewed} disabled={blocked} onChange={event => setReviewedIdentity(event.target.checked ? identity : undefined)} />
          我已审阅以上安装包摘要、全部钩子定义及其执行内容，允许当前定义运行。
        </label>
        <div className="settings-form-actions">
          <Button disabled={blocked || !reviewed} onClick={() => void configure(true)}>信任并启用当前钩子</Button>
          <Button variant="outline" disabled={blocked || !current.definitions.some(entry => entry.trusted)} onClick={() => void configure(false)}>撤销钩子信任并停用</Button>
        </div>
      </>}
    </>}
  </section>;
}
