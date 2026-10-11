import { useRef, useState } from 'react';
import { Button } from './components/ui/button.js';
import './BrowserRegionAnnotation.css';

export interface RegionDraft {
  capture: {
    captureId: string;
    projectId: string;
    threadId: string;
    pageId: string;
    coreInstanceId: string;
    pageGeneration: number;
    documentEpoch: number;
    controlEpoch: number;
    viewportRevision: number;
    capturedAt: string;
    url: string;
    imageBase64: string;
    frameEvidence?: { id: string; loaderId: string; origin: string }[];
    viewport: { width: number; height: number; scrollX: number; scrollY: number; pageZoom: number;
      guiZoom: number; deviceScaleFactor: number; nativeBounds: { x: number; y: number; width: number; height: number };
      bitmapWidth: number; bitmapHeight: number };
  };
  comment: string;
  region: { x: number; y: number; width: number; height: number } | null;
  mode?: 'region' | 'element';
  element?: { elementId: string; evidenceRef: string; role: string; name: string;
    bounds: { x: number; y: number; width: number; height: number };
    pageGeneration: number; documentEpoch: number; controlEpoch: number; frameId: string; sourceMapping: string };
  unavailableReason?: string;
}

export function BrowserRegionAnnotation({ draft, busy, onChange, onCancel, onStage }: {
  draft: RegionDraft;
  busy: boolean;
  onChange: (draft: RegionDraft) => void;
  onCancel: () => void;
  onStage: (draft: RegionDraft) => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const point = (clientX: number, clientY: number) => {
    const bounds = image.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return null;
    // Browser screenshot pixels are the authority. DOM/CSS scale is applied once;
    // devicePixelRatio and page zoom are already represented by bitmap dimensions.
    return {
      x: Math.round(Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * draft.capture.viewport.bitmapWidth),
      y: Math.round(Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)) * draft.capture.viewport.bitmapHeight),
    };
  };
  const move = (clientX: number, clientY: number) => {
    if (!start.current) return;
    const end = point(clientX, clientY);
    if (!end) return;
    const x = Math.min(start.current.x, end.x), y = Math.min(start.current.y, end.y);
    onChange({ ...draft, region: { x, y, width: Math.abs(end.x - start.current.x), height: Math.abs(end.y - start.current.y) } });
  };
  const region = draft.region;
  const bitmapWidth = draft.capture.viewport.bitmapWidth;
  const bitmapHeight = draft.capture.viewport.bitmapHeight;
  const setCoordinate = (name: 'x' | 'y' | 'width' | 'height', raw: number) => {
    const next = { ...(region ?? { x: 0, y: 0, width: bitmapWidth, height: bitmapHeight }), [name]: Math.max(0, Math.round(raw) || 0) };
    next.x = Math.min(next.x, bitmapWidth - 1);
    next.y = Math.min(next.y, bitmapHeight - 1);
    next.width = Math.min(next.width, bitmapWidth - next.x);
    next.height = Math.min(next.height, bitmapHeight - next.y);
    onChange({ ...draft, region: next, mode: 'region', element: undefined });
  };
  return <div className="browser-region-annotation" role="region" aria-label="冻结截图区域标注"
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onCancel(); }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && draft.region?.width && draft.region.height && draft.comment.trim()) {
        event.preventDefault(); onStage(draft);
      }
    }}>
    <div role="status">冻结截图 · {draft.capture.url} · {new Date(draft.capture.capturedAt).toLocaleString()}。实时页面可能已变化。仅选中区域的裁图会加入聊天草稿。</div>
    {draft.unavailableReason && <div role="status">{draft.unavailableReason}</div>}
    {draft.element && <div role="status">所选元素：{draft.element.role} · {draft.element.name || '无名称'}。这是选择时的页面事实，发送前会再次检查。</div>}
    <div className="browser-region-image-wrap">
      <img ref={image} alt="用于选择区域的冻结页面截图" draggable={false}
        src={`data:image/png;base64,${draft.capture.imageBase64}`}
        onPointerDown={event => {
          if (busy) return;
          const origin = point(event.clientX, event.clientY);
          if (!origin) return;
          if (draft.mode === 'element') return;
          start.current = origin; setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          onChange({ ...draft, region: null });
        }}
        onPointerMove={event => { if (dragging && draft.mode !== 'element') move(event.clientX, event.clientY); }}
        onPointerUp={event => { if (draft.mode !== 'element') move(event.clientX, event.clientY); start.current = null; setDragging(false); }}
        onPointerCancel={() => { start.current = null; setDragging(false); }} />
      {region && <div className="browser-region-selection" aria-hidden="true" style={{
        left: `${100 * region.x / bitmapWidth}%`, top: `${100 * region.y / bitmapHeight}%`,
        width: `${100 * region.width / bitmapWidth}%`, height: `${100 * region.height / bitmapHeight}%`,
      }} />}
    </div>
    <fieldset className="browser-region-coordinates"><legend>区域位置（截图像素，可用键盘调整）</legend>
      {(['x', 'y', 'width', 'height'] as const).map(name => <label key={name}>{name}
        <input type="number" min={0} max={name === 'x' || name === 'width' ? bitmapWidth : bitmapHeight}
          value={region?.[name] ?? ''} onChange={event => setCoordinate(name, Number(event.target.value))} />
      </label>)}
    </fieldset>
    <label>标注意见<textarea value={draft.comment} onChange={event => onChange({ ...draft, comment: event.target.value })}
      placeholder="描述这一区域需要修改或检查的内容" /></label>
    <div className="browser-region-actions">
      {draft.mode === 'element' && <Button type="button" size="sm" disabled={busy} onClick={() => onChange({ ...draft, mode: 'region', element: undefined, region: null })}>改用区域标注</Button>}
      <Button type="button" size="sm" disabled={!region || busy} onClick={() => onChange({ ...draft, region: null, mode: 'region', element: undefined })}>撤销区域</Button>
      <Button type="button" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
      <Button type="button" size="sm" disabled={busy || !region?.width || !region.height || !draft.comment.trim()}
        onClick={() => onStage(draft)}>加入聊天草稿</Button>
    </div>
  </div>;
}
