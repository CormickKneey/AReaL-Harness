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
import { BrowserRegionAnnotation, type RegionDraft } from "./BrowserRegionAnnotation.js";
import { attachmentDrafts, sending, stageThreadDraft } from "./Composer.js";
import { BrowserVerificationCard } from "./BrowserVerificationCard.js";
import "./BrowserFileHandoff.css";
import { BrowserStyleTrial, type StyleTrialDraft } from './BrowserStyleTrial.js';
import type { Action } from "./services.js";
import type { PreviewRequest, OwnedPreviewOperation } from '@areal/workbench/desktop-contract';
const locations = new Map<string, { url: string; link?: string }>();
const regionDrafts = new Map<string, RegionDraft>();
const styleTrialDrafts = new Map<string, StyleTrialDraft>();
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
  const [annotationState, setAnnotationState] = useState<{ owner: string; draft: RegionDraft | null }>(() => ({ owner, draft: regionDrafts.get(owner) ?? null }));
  const annotating = annotationState.owner === owner ? annotationState.draft : regionDrafts.get(owner) ?? null;
  const [annotationBusyOwner, setAnnotationBusyOwner] = useState<string | null>(null);
  const annotationBusy = annotationBusyOwner === owner;
  const annotationControl = useRef<HTMLButtonElement>(null);
  const [styleTrialState, setStyleTrialState] = useState<{ owner: string; draft: StyleTrialDraft | null }>(() =>
    ({ owner, draft: styleTrialDrafts.get(owner) ?? null }));
  const styleTrial = styleTrialState.owner === owner ? styleTrialState.draft : styleTrialDrafts.get(owner) ?? null;
  const [styleBusyOwner, setStyleBusyOwner] = useState<string | null>(null);
  const styleBusy = styleBusyOwner === owner;
  const styleTrialRef = useRef(styleTrial);
  styleTrialRef.current = styleTrial;
  const annotatingRef = useRef(annotating);
  annotatingRef.current = annotating;
  const box = useRef<HTMLDivElement>(null);
  const editing = useRef(false);
  const current = useRef(owner);
  current.current = owner;
  const mounted = useRef(false);
  const sequence = useRef(0);
  const workspaceCursor = useRef({ id: '', sequence: 0 });
  const subscriptionRequest = useRef(0);
  const refreshSubscription = useRef<() => void>(() => {});
  const request = async (operation: OwnedPreviewOperation, extra: Data = {}) => {
    if (["navigate", "back", "forward", "reload", "selectPage", "newPage", "release"].includes(operation)) editing.current = false;
    const seq = ++sequence.current;
    try {
      const value = await services.preview({
        operation,
        projectId,
        threadId,
        ...(stateRef.current.browser?.pageId && !['state', 'subscribe', 'unsubscribe', 'newPage'].includes(operation)
          ? { pageId: stateRef.current.browser.pageId } : {}),
        ...extra,
      });
      if (!mounted.current || current.current !== owner || seq !== sequence.current) return;
      const workspaceChanged = !!value.workspace?.workspaceId && value.workspace.workspaceId !== workspaceCursor.current.id;
      const selectedPageChanged = !!value.workspace && value.workspace.selectedPageId !== stateRef.current.workspace?.selectedPageId;
      if (workspaceChanged) locations.delete(owner);
      if (workspaceChanged)
        refreshSubscription.current();
      if (value.url || workspaceChanged || selectedPageChanged || ['selectPage', 'newPage', 'release'].includes(operation)) {
        if (!editing.current) setUrl(value.url ?? '');
        if (value.url || selectedPageChanged) locations.set(owner, { ...locations.get(owner), url: value.url ?? '' });
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
    const install = async () => {
      const token = ++subscriptionRequest.current;
      try {
        const snapshot = await services.preview({ operation: 'subscribe', projectId, threadId });
        if (!mounted.current || token !== subscriptionRequest.current) return;
        workspaceCursor.current = { id: snapshot.workspaceId,
          sequence: workspaceCursor.current.id === snapshot.workspaceId
            ? Math.max(workspaceCursor.current.sequence, snapshot.sequence) : snapshot.sequence };
        void request('state');
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    };
    refreshSubscription.current = () => { void install(); };
    const unsubscribeEvents = services.onPreviewEvent?.(event => {
      if (!mounted.current || event.workspaceId !== workspaceCursor.current.id) return;
      if (event.sequence <= workspaceCursor.current.sequence) return;
      if (event.sequence !== workspaceCursor.current.sequence + 1) {
        void install();
      } else {
        workspaceCursor.current.sequence = event.sequence;
        void request('state');
      }
    });
    void install();
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
        ...(value.browser?.pageId ? { pageId: value.browser.pageId } : {}),
        visible: !!value.url && !value.error && !errorRef.current && !overlay && !annotatingRef.current
          && !styleTrialRef.current?.after && height > 0 &&
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
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
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
      subscriptionRequest.current++;
      sequence.current++;
      clearInterval(timer);
      unsubscribeEvents?.();
      void services.preview({ operation: 'unsubscribe', projectId, threadId }).catch(() => {});
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      void services.preview({ operation: "hide", projectId, threadId, pageId: stateRef.current.browser?.pageId }).catch(() => {});
      void services.preview({ operation: 'cancelElementSelection', projectId, threadId,
        pageId: stateRef.current.browser?.pageId }).catch(() => {});
    };
  }, [services, projectId, threadId]);
  const updateAnnotation = (draft: RegionDraft | null) => {
    annotatingRef.current = draft;
    if (draft) regionDrafts.set(owner, draft);
    else regionDrafts.delete(owner);
    setAnnotationState({ owner, draft });
  };
  const updateStyleTrial = (draft: StyleTrialDraft | null) => {
    styleTrialRef.current = draft;
    if (draft) styleTrialDrafts.set(owner, draft); else styleTrialDrafts.delete(owner);
    setStyleTrialState({ owner, draft });
  };
  const startStyleTrial = async () => {
    if (styleBusy || styleTrial || annotating || annotationBusy) return;
    setStyleBusyOwner(owner); setError('');
    let capture: RegionDraft['capture'] | null = null;
    try {
      const pageId = stateRef.current.browser?.pageId;
      if (!pageId) throw new Error('请选择当前页面');
      if (stateRef.current.browser?.control === 'agent')
        await services.preview({ operation: 'takeover', projectId, threadId, pageId });
      const selected = await services.preview({ operation: 'captureElement', projectId, threadId, pageId });
      capture = selected.capture as RegionDraft['capture'];
      if (!selected.element?.available) throw new Error(selected.element?.reason || '此元素不支持页面试改');
      const begun = await services.preview({ operation: 'beginStyleTrial', projectId, threadId,
        pageId, captureId: capture.captureId, elementId: selected.element.elementId });
      if (!mounted.current || current.current !== owner) {
        await services.preview({ operation: 'clearStyleTrial', projectId, threadId, pageId, trialId: begun.trialId });
        return;
      }
      updateStyleTrial({ trialId: begun.trialId, before: capture, element: selected.element,
        edits: [], canUndo: false, canRedo: false, stale: false, intent: '' });
    } catch (e) {
      if (capture) void services.preview({ operation: 'endRegion', projectId, threadId,
        pageId: capture.pageId, captureId: capture.captureId }).catch(() => {});
      if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e));
    } finally { setStyleBusyOwner(value => value === owner ? null : value); }
  };
  const changeStyleTrial = async (operation: 'applyStyleTrial' | 'undoStyleTrial' | 'redoStyleTrial', property?: string, value?: string) => {
    const draft = styleTrialRef.current;
    if (!draft || styleBusy) return;
    setStyleBusyOwner(owner); setError('');
    try {
      const next = await services.preview({ operation, projectId, threadId, pageId: draft.before.pageId,
        trialId: draft.trialId, ...(property ? { property } : {}), ...(value !== undefined ? { value } : {}) });
      if (mounted.current && current.current === owner && styleTrialRef.current === draft)
        updateStyleTrial({ ...draft, edits: next.edits, canUndo: next.canUndo, canRedo: next.canRedo, stale: next.stale });
    } catch (e) {
      if (mounted.current && current.current === owner) {
        setError(e instanceof Error ? e.message : String(e));
        const latest = styleTrialRef.current;
        if (latest?.trialId === draft.trialId && /失效|已修改|已替换/.test(String(e)))
          updateStyleTrial({ ...latest, stale: true });
      }
    } finally { setStyleBusyOwner(value => value === owner ? null : value); }
  };
  const cancelStyleTrial = async () => {
    const draft = styleTrialRef.current;
    if (!draft || styleBusy) return;
    setStyleBusyOwner(owner); setError('');
    try {
      if (!draft.cleared) {
        try {
          const cleared = await services.preview({ operation: 'clearStyleTrial', projectId, threadId,
            pageId: draft.before.pageId, trialId: draft.trialId });
          if (!cleared.cleared) throw new Error('试改目标已变化，请刷新页面清除残留效果');
        } catch (error) {
          const currentPage = await services.preview({ operation: 'state', projectId, threadId, pageId: draft.before.pageId });
          if (currentPage.browser?.trialActive) throw error;
          // A navigation or page closure already discarded the old document.
        }
      }
      if (draft.after) await services.preview({ operation: 'endRegion', projectId, threadId,
        pageId: draft.before.pageId, captureId: draft.after.capture.captureId });
      if (mounted.current && current.current === owner) updateStyleTrial(null);
    } catch (e) {
      if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e));
    } finally { setStyleBusyOwner(value => value === owner ? null : value); }
  };
  const cropStyleEvidence = async (capture: RegionDraft['capture'], bounds: NonNullable<RegionDraft['region']>) => {
    const image = new Image(); image.src = `data:image/png;base64,${capture.imageBase64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = bounds.width; canvas.height = bounds.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法生成页面试改证据');
    context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
      : reject(new Error('无法生成页面试改证据')), 'image/png'));
  };
  const stageStyleTrial = async () => {
    const original = styleTrialRef.current;
    if (!original || styleBusy || !original.intent.trim() || !original.edits.length) return;
    setStyleBusyOwner(owner); setError('');
    try {
      let draft = original;
      if (!draft.after) {
        const after = await services.preview({ operation: 'captureStyleTrialAfter', projectId, threadId,
          pageId: draft.before.pageId, trialId: draft.trialId });
        if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
          throw new Error('试改所属聊天已变化');
        await services.preview({ operation: 'hide', projectId, threadId, pageId: draft.before.pageId });
        if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
          throw new Error('试改所属聊天已变化');
        draft = { ...draft, after: { capture: after.capture, element: after.element } };
        updateStyleTrial(draft);
      }
      const beforeBlob = await cropStyleEvidence(draft.before, draft.element.bounds);
      const afterBlob = await cropStyleEvidence(draft.after!.capture, draft.after!.element.bounds);
      if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
        throw new Error('试改所属聊天已变化');
      if (!draft.cleared) {
        const cleared = await services.preview({ operation: 'clearStyleTrial', projectId, threadId,
          pageId: draft.before.pageId, trialId: draft.trialId });
        if (!cleared.cleared) throw new Error('试改目标已变化，请刷新页面后重新核查');
        if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
          throw new Error('试改所属聊天已变化');
        draft = { ...draft, cleared: true };
        updateStyleTrial(draft);
      }
      if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
        throw new Error('试改所属聊天已变化');
      const capture = draft.before;
      const description = `页面试改意图（已清除临时效果，未写入代码）\nURL: ${capture.url}\n截图时间: ${capture.capturedAt}\nCore: ${capture.coreInstanceId}; Page: ${capture.pageId}; pageGeneration: ${capture.pageGeneration}; documentEpoch: ${capture.documentEpoch}; controlEpoch: ${capture.controlEpoch}; viewportRevision: ${capture.viewportRevision}\n选择时元素: role=${JSON.stringify(draft.element.role)}; name=${JSON.stringify(draft.element.name)}; historicalRef=${draft.element.evidenceRef}; sourceMapping=${draft.element.sourceMapping}; React 源码位置未知。Agent 必须重新 observe 并取得新 Ref。\n属性值: ${JSON.stringify(draft.edits)}\n前后证据: browser-style-before-${capture.captureId}.png; browser-style-after-${draft.after!.capture.captureId}.png\n用户意图: ${draft.intent.trim()}\n最终验证必须在清除试改后基于真实页面执行。`;
      const draftKey = `areal-gui:draft:${projectId}:${threadId}`;
      if (sending.has(draftKey) || localStorage.getItem(`${draftKey}:pending`))
        throw new Error('当前聊天有结果待核对的发送；请先确认结果，再加入试改意图');
      const files = [...(attachmentDrafts.get(draftKey) ?? []),
        new File([beforeBlob], `browser-style-before-${capture.captureId}.png`, { type: 'image/png' }),
        new File([afterBlob], `browser-style-after-${draft.after!.capture.captureId}.png`, { type: 'image/png' })];
      const existing = localStorage.getItem(draftKey) ?? '';
      const key = stageThreadDraft(projectId, threadId, [existing, description].filter(Boolean).join('\n\n'), files);
      window.dispatchEvent(new CustomEvent('areal-draft-change', { detail: key }));
      updateStyleTrial(null);
      await services.preview({ operation: 'endRegion', projectId, threadId,
        pageId: capture.pageId, captureId: draft.after!.capture.captureId });
    } catch (e) { if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e)); }
    finally { setStyleBusyOwner(value => value === owner ? null : value); }
  };
  const cancelAnnotation = async () => {
    if (!annotating || annotationBusy) return;
    setAnnotationBusyOwner(owner); setError("");
    try {
      await services.preview({ operation: 'endRegion', projectId, threadId,
        pageId: annotating.capture.pageId, captureId: annotating.capture.captureId });
      updateAnnotation(null);
      if (mounted.current && current.current === owner) annotationControl.current?.focus();
    } catch (e) { if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e)); }
    finally { setAnnotationBusyOwner(value => value === owner ? null : value); }
  };
  const startAnnotation = async (mode: 'region' | 'element' = 'region') => {
    if (annotationBusy || annotating) return;
    setAnnotationBusyOwner(owner); setError("");
    let captured: RegionDraft['capture'] | null = null;
    try {
      const pageId = stateRef.current.browser?.pageId;
      if (!pageId) throw new Error("请选择当前页面");
      if (stateRef.current.browser?.control === 'agent') {
        await services.preview({ operation: 'takeover', projectId, threadId, pageId });
      }
      const selected = mode === 'element'
        ? await services.preview({ operation: 'captureElement', projectId, threadId, pageId }) : null;
      const capture = selected ? selected.capture : await services.preview({ operation: 'captureRegion', projectId, threadId, pageId });
      if (capture.projectId !== projectId || capture.threadId !== threadId || capture.pageId !== pageId
        || typeof capture.imageBase64 !== 'string' || !Number.isInteger(capture.viewportRevision)
        || !Number.isFinite(capture.viewport?.bitmapWidth)
        || !Number.isFinite(capture.viewport?.bitmapHeight)) throw new Error('截图所属页面已变化');
      captured = capture as RegionDraft['capture'];
      if (!mounted.current || current.current !== owner) {
        await services.preview({ operation: 'endRegion', projectId, threadId, pageId, captureId: captured.captureId });
        return;
      }
      await services.preview({ operation: 'hide', projectId, threadId, pageId });
      if (!mounted.current || current.current !== owner) {
        await services.preview({ operation: 'endRegion', projectId, threadId, pageId, captureId: captured.captureId });
        return;
      }
      const element = selected?.element?.available === true ? selected.element as RegionDraft['element'] : undefined;
      updateAnnotation({ capture: captured, comment: '', region: element?.bounds ?? null,
        mode: element ? 'element' : 'region', element,
        unavailableReason: selected?.element?.available === false ? String(selected.element.reason) : undefined });
    } catch (e) {
      if (captured) void services.preview({ operation: 'endRegion', projectId, threadId,
        pageId: captured.pageId, captureId: captured.captureId }).catch(() => {});
      if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e));
    } finally { setAnnotationBusyOwner(value => value === owner ? null : value); }
  };
  const stageAnnotation = async (draft: RegionDraft) => {
    if (annotationBusy) return;
    setAnnotationBusyOwner(owner); setError("");
    try {
      const image = new Image();
      image.src = `data:image/png;base64,${draft.capture.imageBase64}`;
      await image.decode();
      const { x, y, width, height } = draft.region!;
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法生成标注缩略图');
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成标注缩略图')), 'image/png'));
      const capture = draft.capture;
      const scaleX = capture.viewport.width / capture.viewport.bitmapWidth;
      const scaleY = capture.viewport.height / capture.viewport.bitmapHeight;
      const elementCheck = draft.element && draft.mode === 'element'
        ? await services.preview({ operation: 'checkElement', projectId, threadId, pageId: capture.pageId,
          captureId: capture.captureId, elementId: draft.element.elementId }).catch(() => ({ stale: true })) : null;
      if (!mounted.current || current.current !== owner || annotatingRef.current !== draft)
        throw new Error('标注所属聊天已变化');
      const elementDescription = draft.element && draft.mode === 'element'
        ? `\n选择时元素: role=${JSON.stringify(draft.element.role)}; name=${JSON.stringify(draft.element.name)}; bounds bitmap(px)=${x},${y},${width},${height}; frame=${draft.element.frameId}; historicalRef=${draft.element.evidenceRef}; sourceMapping=${draft.element.sourceMapping}; ${elementCheck?.stale ? 'stale: 页面元素已变化，保留原证据。' : '发送时仍命中同一节点；页面之后仍可能变化。'} Agent 必须重新 observe 并取得新 Ref，禁止用 historicalRef 动作。React 源码位置未知。` : '';
      const description = `页面${draft.element && draft.mode === 'element' ? '元素' : '区域'}标注（冻结截图，页面之后可能变化；仅分享选中区域）\nURL: ${capture.url}\n截图时间: ${capture.capturedAt}\nCore: ${capture.coreInstanceId}; Page: ${capture.pageId}; pageGeneration: ${capture.pageGeneration}; documentEpoch: ${capture.documentEpoch}; controlEpoch: ${capture.controlEpoch}; viewportRevision: ${capture.viewportRevision}; captureId: ${capture.captureId}\n原截图 bitmap(px): ${capture.viewport.bitmapWidth}×${capture.viewport.bitmapHeight}; CSS viewport(px): ${capture.viewport.width}×${capture.viewport.height}; scroll(px): ${capture.viewport.scrollX},${capture.viewport.scrollY}; pageZoom: ${capture.viewport.pageZoom}; GUI zoom: ${capture.viewport.guiZoom}; DPR: ${capture.viewport.deviceScaleFactor}; native DIP bounds: ${JSON.stringify(capture.viewport.nativeBounds)}\n选区 bitmap(px): ${x},${y},${width},${height}; viewport CSS(px): ${(x * scaleX).toFixed(1)},${(y * scaleY).toFixed(1)},${(width * scaleX).toFixed(1)},${(height * scaleY).toFixed(1)}${elementDescription}\n裁图: browser-region-${capture.captureId}.png\n意见: ${draft.comment.trim()}`;
      const draftKey = `areal-gui:draft:${projectId}:${threadId}`;
      if (sending.has(draftKey) || localStorage.getItem(`${draftKey}:pending`))
        throw new Error('当前聊天有结果待核对的发送；请先确认结果，再加入标注草稿');
      // No await between reading the target draft and staging it. A chat switch
      // or concurrent Composer edit cannot make an earlier snapshot overwrite it.
      const existing = localStorage.getItem(draftKey) ?? '';
      const files = [...(attachmentDrafts.get(draftKey) ?? []), new File([blob], `browser-region-${capture.captureId}.png`, { type: 'image/png' })];
      const key = stageThreadDraft(projectId, threadId, [existing, description].filter(Boolean).join('\n\n'), files);
      window.dispatchEvent(new CustomEvent('areal-draft-change', { detail: key }));
      updateAnnotation(null);
      await services.preview({ operation: 'endRegion', projectId, threadId,
        pageId: capture.pageId, captureId: capture.captureId });
    } catch (e) { if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e)); }
    finally { setAnnotationBusyOwner(value => value === owner ? null : value); }
  };
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
  const batch = state.workspace?.pages?.find((page: Data) => page.pageId === state.browser?.pageId)?.operation;
  let address = url;
  if (!fullAddress && !addressFocused && !editing.current) {
    try { address = new URL(url).host; } catch { /* Keep a not-yet-valid user draft. */ }
  }
  return (
    <div className="preview-panel">
      <div className="preview-viewport-toolbar" role="tablist" aria-label="浏览页面">
        {(state.workspace?.pages ?? []).map((page: Data, index: number) => (
          <Button key={page.pageId} type="button" size="sm" role="tab"
            aria-selected={state.workspace?.selectedPageId === page.pageId} disabled={!!annotating}
            onClick={() => void request('selectPage', { pageId: page.pageId })}>
            {page.title || page.url || `页面 ${index + 1}`}{page.resource === 'suspended' ? ' · 已暂停' : ''}
          </Button>
        ))}
        <Button type="button" size="sm" aria-label="新建浏览页面" disabled={!!annotating} onClick={() => void request('newPage')}>＋</Button>
        {!!state.browser?.pageId && <Button type="button" size="sm" aria-label="关闭当前浏览页面" disabled={!!annotating}
          onClick={() => void request('release', { userIntent: true })}>关闭</Button>}
      </div>
      {state.browser?.stateLoss && <div className="preview-viewport-toolbar" role="status">
        {state.browser.stateLoss}
      </div>}
      {batch && <div className="preview-viewport-toolbar" role="status">
        浏览步骤 {batch.completed}/{batch.total} · {batch.status === 'running' ? '进行中'
          : batch.status === 'confirmed' ? '已确认输入，仍需检查页面结果'
            : batch.status === 'unknown' ? '结果未知，请检查聊天记录'
              : '已停止，剩余步骤未执行'}
      </div>}
      {browserEnabled && <div className="preview-viewport-toolbar" role="note">
        临时登录只在当前浏览工作区使用；关闭工作区或重启后可能需要重新登录。
      </div>}
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
          <Button type="button" size="sm" onClick={() => void request('release', { userIntent: true })}>关闭页面</Button>
          {state.browser.transferError && <span role="alert">{state.browser.transferError}</span>}
        </> : state.browser?.control === 'agent'
          ? <Button type="button" size="sm" onClick={() => void request('takeover')}>接管页面</Button>
          : <>
            {uninspectedUnknown && <span role="status">原浏览器动作结果 UNKNOWN。请先到聊天记录核查并确认；交还不会重试该动作。</span>}
            <Button type="button" size="sm" disabled={claiming || uninspectedUnknown || !!state.loading || !!state.error
              || !!styleTrial
              || !!state.browser?.downloadIntentExpiresAt || (state.workspace?.fileReceipts ?? []).some((receipt: Data) =>
                receipt.pageId === state.browser?.pageId && ['choosing', 'downloading', 'interrupted'].includes(receipt.status))}
            onClick={() => {
              setClaiming(true);
              void (async () => {
                try {
                  const next = await services.preview({ operation: 'claim', projectId, threadId,
                    pageId: stateRef.current.browser?.pageId });
                  if (mounted.current && current.current === owner) setState(next);
                  await call(services, 'send', { projectId, threadId, text: '请使用 browser_v1 检查我刚授权的当前页面，先 describe，再 observe，并报告页面实际内容。' });
                } catch (e) { if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e)); }
                finally { if (mounted.current && current.current === owner) setClaiming(false); }
              })();
            }}>交还并让 Agent 检查当前页</Button>
          </>}
      </div>}
      {browserEnabled && state.url && <div className="preview-viewport-toolbar" role="group" aria-label="网页文件交接">
        {state.browser?.control === 'human' ? <>
          <Button type="button" size="sm" disabled={!!state.browser?.downloadIntentExpiresAt || !!annotating || !!styleTrial}
            onClick={() => void request('allowNextDownload', { userIntent: true })}>允许下一次下载</Button>
          {state.browser?.downloadIntentExpiresAt && <>
            <span role="status">30 秒内在当前网页触发一次下载，随后选择保存位置。</span>
            <Button type="button" size="sm" onClick={() => void request('cancelFileHandoff')}>取消下载许可</Button>
          </>}
          <span>上传请在网页中使用文件选择控件；系统选择器取消后可继续操作。</span>
        </> : <span>文件选择需要先接管页面。</span>}
      </div>}
      {browserEnabled && (state.workspace?.fileReceipts ?? []).length > 0 &&
        <div className="preview-viewport-toolbar preview-file-status" role="list" aria-label="网页下载状态">
          {(state.workspace.fileReceipts as Data[]).map((receipt: Data) => <div role="listitem" key={receipt.id}>
            {receipt.name || '未命名下载'} · 页面 {receipt.pageOrigin || '未知'} · 发起者 {receipt.initiator === 'unknown' ? '未知' : receipt.initiator}
            {' · '}{receipt.source || '来源网址未知'}
            {' · '}{receipt.sizeBytes == null ? '大小未知' : `${receipt.sizeBytes} B`}
            {' · '}{({ choosing: '选择保存位置', downloading: '下载中', completed: '已完成', cancelled: '已取消', interrupted: '已中断', unknown: '结果待核对' } as Record<string, string>)[receipt.status] ?? '状态未知'}
            {receipt.target ? ` · 保存为 ${receipt.target}` : ''}
            {['choosing', 'downloading', 'interrupted'].includes(receipt.status) && receipt.pageId === state.browser?.pageId
              && state.browser?.control === 'human' && <Button type="button" size="sm"
                onClick={() => void request('cancelDownload', { downloadId: receipt.id, userIntent: true })}>取消下载</Button>}
          </div>)}
        </div>}
      {browserEnabled && state.url && <div className="preview-viewport-toolbar" role="group" aria-label="页面标注">
        <Button ref={annotationControl} type="button" size="sm" disabled={annotationBusy || styleBusy || !!styleTrial || !!annotating || state.browser?.control === 'transferring'}
          onClick={() => void startAnnotation()}>截取区域并标注</Button>
        <Button type="button" size="sm" disabled={annotationBusy || styleBusy || !!styleTrial || !!annotating || state.browser?.control === 'transferring'}
          onClick={() => void startAnnotation('element')}>选择元素并标注</Button>
        <Button type="button" size="sm" disabled={annotationBusy || styleBusy || !!styleTrial || !!annotating || state.browser?.control === 'transferring'}
          onClick={() => void startStyleTrial()}>选择元素并试改</Button>
        {annotationBusy && !annotating && <span role="status">在页面中点击要标注的元素；按 Esc 取消。</span>}
      </div>}
      {styleTrial && <BrowserStyleTrial draft={styleTrial} busy={styleBusy}
        onApply={(property, value) => void changeStyleTrial('applyStyleTrial', property, value)}
        onUndo={() => void changeStyleTrial('undoStyleTrial')}
        onRedo={() => void changeStyleTrial('redoStyleTrial')}
        onIntent={value => updateStyleTrial({ ...styleTrial, intent: value })}
        onStage={() => void stageStyleTrial()} onCancel={() => void cancelStyleTrial()} />}
      {!browserEnabled && browserAvailable && state.url && <div className="preview-viewport-toolbar">
        <Button type="button" size="sm" disabled={claiming} onClick={() => {
          setClaiming(true);
          void call(services, 'attachBrowser', { projectId, threadId, expectedToolsetRevision: toolsetRevision })
            .catch((e) => { if (mounted.current && current.current === owner) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (mounted.current && current.current === owner) setClaiming(false); });
        }}>在当前聊天启用浏览器</Button>
      </div>}
      {thread && <BrowserVerificationCard thread={thread} projectId={projectId} action={action} onReview={onReview} onTool={onTool}
        trialActive={!!styleTrial && !styleTrial.cleared || !!state.browser?.trialActive} />}
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
        {annotating && <BrowserRegionAnnotation draft={annotating} busy={annotationBusy}
          onChange={updateAnnotation} onCancel={() => void cancelAnnotation()} onStage={draft => void stageAnnotation(draft)} />}
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
