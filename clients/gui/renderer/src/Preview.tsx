import {
  BrowserToolbar,
  BrowserEmptyState,
  BrowserLoadErrorState,
} from "./EmbeddedBrowserPaneParts.js";
// Core owns isolated native pages; the copied ZCode parts own the presentation.
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import type { PlatformServices, Data } from "./services.js";
import { call } from "./services.js";
import { BrowserVerificationCard } from "./BrowserVerificationCard.js";
import type { Action } from "./services.js";
import type { PreviewRequest, OwnedPreviewOperation } from '@areal/workbench/desktop-contract';
const locations = new Map<string, { url: string; link?: string }>();
export function Preview({
  services,
  projectId,
  threadId,
  initialUrl,
  initialRequest = 0,
  fullAddress = false,
  browserEnabled = false,
  browserAvailable = false,
  toolsetRevision = 0,
  thread,
  action,
  onReview,
  onTool,
}: {
  services: PlatformServices;
  projectId: string;
  threadId: string;
  initialUrl: string;
  initialRequest?: number;
  fullAddress?: boolean;
  browserEnabled?: boolean;
  browserAvailable?: boolean;
  toolsetRevision?: number;
  thread?: Data;
  action: Action;
  onReview: (turnId: string) => void;
  onTool: (itemId: string) => void;
  onError: (s: string) => void;
}) {
  const owner = `${projectId}:${threadId}`;
  const [url, setUrl] = useState(locations.get(owner)?.url ?? initialUrl);
  const [state, setState] = useState<Data>({});
  const [error, setError] = useState("");
  const [responsive, setResponsive] = useState(false);
  const [width, setWidth] = useState(390);
  const [addressFocused, setAddressFocused] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const editing = useRef(false);
  const current = useRef(owner);
  current.current = owner;
  const mounted = useRef(false);
  const sequence = useRef(0);
  const request = async (operation: OwnedPreviewOperation, extra: Data = {}) => {
    if (["navigate", "back", "forward", "reload"].includes(operation)) editing.current = false;
    const seq = ++sequence.current;
    try {
      const value = await services.preview({
        operation,
        projectId,
        threadId,
        ...extra,
      });
      if (!mounted.current || current.current !== owner || seq !== sequence.current) return;
      if (value.url) {
        if (!editing.current) setUrl(value.url);
        locations.set(owner, { ...locations.get(owner), url: value.url });
      }
      setState(value);
      if (operation !== "state") setError("");
    } catch (e) {
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    }
  };
  const stateRef = useRef(state);
  stateRef.current = state;
  const errorRef = useRef(error);
  errorRef.current = error;
  useEffect(() => {
    mounted.current = true;
    let active = true,
      reading = false;
    let lastDisplay = "";
    const update = () => {
      if (!active || !box.current) return;
      const r = box.current.getBoundingClientRect();
      // Native pages sit above the renderer, so keep them hidden through popup exit animations.
      const overlay = document.querySelector(
        ':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]):is([data-open], [data-ending-style])',
      );
      const value = stateRef.current;
      const workspace = box.current.closest('.work-area');
      const composer = workspace?.getAttribute('data-workspace-view') === 'panel'
        ? workspace.querySelector('.active-composer, .draft-composer')
        : null;
      // A native view is above Renderer paint: hiding its parent in CSS does
      // not hide the page, and a floating input must retain its actual space.
      const height = Math.max(0, Math.min(r.bottom, composer?.getBoundingClientRect().top ?? r.bottom) - r.top);
      const display: PreviewRequest = {
        operation: "show",
        projectId,
        threadId,
        // 被回收的原生页面只恢复已确认地址，不使用地址栏里的未提交草稿。
        url: locations.get(owner)?.url,
        visible: !!value.url && !value.error && !errorRef.current && !overlay && height > 0 &&
          box.current.checkVisibility({ visibilityProperty: true }),
        bounds: { x: r.x, y: r.y, width: r.width, height },
      };
      const signature = JSON.stringify(display);
      if (signature === lastDisplay) return;
      lastDisplay = signature;
      void services.preview(display).catch((e) => {
        lastDisplay = "";
        if (active) setError(e.message);
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(box.current!);
    const composer = box.current?.closest('.work-area')?.querySelector('.active-composer, .draft-composer');
    if (composer) resize.observe(composer);
    const mutation = new MutationObserver(update);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open", "data-ending-style", "data-workspace-view"],
    });
    window.addEventListener("resize", update);
    update();
    void request("state");
    const timer = setInterval(async () => {
      if (!reading) {
        reading = true;
        await request("state");
        reading = false;
      }
      update();
    }, 500);
    return () => {
      active = false;
      mounted.current = false;
      sequence.current++;
      clearInterval(timer);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", update);
      void services.preview({ operation: "hide", projectId, threadId }).catch(() => {});
    };
  }, [services, projectId, threadId]);
  useEffect(() => {
    const link = `${initialRequest}:${initialUrl}`;
    if (initialUrl && locations.get(owner)?.link !== link) {
      locations.set(owner, { url: initialUrl, link });
      setUrl(initialUrl);
      void request("navigate", { url: initialUrl });
    }
  }, [initialUrl, initialRequest, owner]);
  const failure = error || state.error;
  const uninspectedUnknown = thread?.turns?.some((turn: Data) => turn.items?.some((item: Data) =>
    item.type === 'dynamicToolCall' && !item.execution?.inspection &&
    (item.execution?.outcome === 'unknown' || item.execution?.hooks?.some((hook: Data) => hook.outcome === 'unknown')))) === true;
  let address = url;
  if (!fullAddress && !addressFocused && !editing.current) {
    try { address = new URL(url).host; } catch { /* Keep a not-yet-valid user draft. */ }
  }
  return (
    <div className="preview-panel">
      <BrowserToolbar
        addressValue={address}
        browserState={{
          canGoBack: !!state.canGoBack,
          canGoForward: !!state.canGoForward,
          isReady: !!state.url,
          isLoading: !!state.loading,
          currentUrl: state.url ?? "",
        }}
        formatMessage={browserLabel}
        onAddressChange={(value) => {
          editing.current = true;
          setUrl(value);
        }}
        onAddressFocus={() => {
          editing.current = true;
          setAddressFocused(true);
        }}
        onAddressBlur={() => { if (url === state.url) editing.current = false; setAddressFocused(false); }}
        onAddressEscape={() => {
          setUrl(state.url || "");
          editing.current = false;
        }}
        onGoBack={() => void request("back")}
        onGoForward={() => void request("forward")}
        onOpenExternal={() => void request("external")}
        onOpenDevTools={() => void request("devtools")}
        onReload={() => void request(state.loading ? "stop" : "reload")}
        onToggleResponsiveMode={() => setResponsive(!responsive)}
        isResponsiveMode={responsive}
        onSubmit={(event) => {
          event.preventDefault();
          editing.current = false;
          void request("navigate", { url });
        }}
      />
      {browserEnabled && state.url && <div className="preview-viewport-toolbar" role="group" aria-label="共享浏览器控制">
        <span>{state.browser?.control === 'agent' ? 'Agent 可观察当前页'
          : state.browser?.control === 'transferring' ? '正在释放 Agent 输入，暂不能操作页面'
            : '你控制当前页；人工期间的内容不会补发给 Agent，此前已交付的内容不会撤回'}</span>
        {state.browser?.control === 'transferring' ? <>
          <Button type="button" size="sm" onClick={() => void request('stop')}>停止加载</Button>
          <Button type="button" size="sm" onClick={() => void request('release')}>关闭页面</Button>
          {state.browser.transferError && <span role="alert">{state.browser.transferError}</span>}
        </> : state.browser?.control === 'agent'
          ? <Button type="button" size="sm" onClick={() => void request('takeover')}>接管页面</Button>
          : <>
            {uninspectedUnknown && <span role="status">原浏览器动作结果 UNKNOWN。请先到聊天记录核查并确认；交还不会重试该动作。</span>}
            <Button type="button" size="sm" disabled={claiming || uninspectedUnknown || !!state.loading || !!state.error}
            onClick={() => {
              setClaiming(true);
              void (async () => {
                try {
                  const next = await services.preview({ operation: 'claim', projectId, threadId });
                  if (mounted.current && current.current === owner) setState(next);
                  await call(services, 'send', { projectId, threadId, text: '请使用 browser_v1 检查我刚授权的当前页面，先 describe，再 observe，并报告页面实际内容。' });
                } catch (e) { if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e)); }
                finally { if (mounted.current && current.current === owner) setClaiming(false); }
              })();
            }}>交还并让 Agent 检查当前页</Button>
          </>}
      </div>}
      {!browserEnabled && browserAvailable && state.url && <div className="preview-viewport-toolbar">
        <Button type="button" size="sm" disabled={claiming} onClick={() => {
          setClaiming(true);
          void call(services, 'attachBrowser', { projectId, threadId, expectedToolsetRevision: toolsetRevision })
            .catch((e) => { if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (mounted.current && current.current === owner) setClaiming(false); });
        }}>在当前聊天启用浏览器</Button>
      </div>}
      {thread && <BrowserVerificationCard thread={thread} projectId={projectId} action={action} onReview={onReview} onTool={onTool} />}
      {responsive && (
        <div className="preview-viewport-toolbar">
          <label>
            宽度{" "}
            <input
              aria-label="预览宽度"
              type="number"
              min={240}
              max={2560}
              value={width}
              onChange={(e) =>
                setWidth(Math.min(2560, Math.max(240, Number(e.target.value) || 240)))
              }
            />{" "}
            px
          </label>
          <Button variant="ghost" size="sm" onClick={() => setResponsive(false)}>
            自适应
          </Button>
        </div>
      )}
      <div className="preview-stage">
        <div
          ref={box}
          className="preview-webview"
          style={responsive ? { width: `min(100%, ${width}px)`, flex: "none" } : undefined}
        />
        {failure ? (
          <BrowserLoadErrorState
              errorMessage={failure}
              isCertificateError={false}
              formatMessage={browserLabel}
              onRetry={() => void request("navigate", { url })}
            />
        ) : !state.url ? (
          <BrowserEmptyState
            browserState={{
              isReady: true,
              canGoBack: false,
              canGoForward: false,
              isLoading: false,
              currentUrl: "",
            }}
            isGuestStarting={false}
            formatMessage={browserLabel}
          />
        ) : null}
      </div>
    </div>
  );
}

function browserLabel({ id }: { id: string }): string {
  return (
    (
      {
        "browser.back": "后退",
        "browser.forward": "前进",
        "browser.reload": "刷新预览",
        "browser.stop": "停止加载",
        "browser.addressPlaceholder": "输入网址，按 Enter 打开",
        "browser.responsive.enter": "响应式预览",
        "browser.responsive.exit": "退出响应式预览",
        "browser.more": "浏览器更多操作",
        "browser.openExternal": "在默认浏览器打开",
        "browser.devtools": "开发者工具",
        "browser.title": "浏览器",
        "browser.empty": "粘贴或输入网址，按 Enter 打开页面。",
        "browser.loadError.title": "无法打开网页",
        "browser.loadError.retry": "重试",
      } as Record<string, string>
    )[id] ?? id
  );
}
