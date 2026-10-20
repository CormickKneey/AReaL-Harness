import { ProjectionReader } from '@areal/workbench/state-projection';
import type { PlatformServices, Snapshot } from './services.js';

type ProjectionMessage = { requestId?: number; frame: unknown };
export type DesktopBridge = Omit<PlatformServices, 'onState'> & {
  onProjection(listener: (message: ProjectionMessage) => void): () => void;
  requestProjection(requestId: number): void;
};

export function createDesktopServices(bridge: DesktopBridge): PlatformServices {
  let reader = new ProjectionReader(), nextRequest = 0, recovering = false;
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const pending = new Map<number, { resolve(value: Snapshot): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  function snapshot(): Promise<Snapshot> {
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop snapshot timed out')); }, 15000);
      pending.set(id, { resolve, reject, timer });
      bridge.requestProjection(id);
    });
  }
  const unsubscribe = bridge.onProjection(message => {
    let value: Snapshot;
    try {
      value = reader.read(message.frame) as Snapshot;
    } catch (error) {
      if (recovering) return;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
      recovering = true;
      reader = new ProjectionReader();
      void snapshot().finally(() => { recovering = false; }).catch(() => {});
      return;
    }
    const request = pending.get(message.requestId ?? 0);
    if (request) { pending.delete(message.requestId!); clearTimeout(request.timer); request.resolve(value); }
    for (const listener of listeners) listener(value);
  });
  window.addEventListener('pagehide', () => {
    unsubscribe();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Desktop document closed')); }
    pending.clear(); listeners.clear();
  }, { once: true });
  return { ...bridge, snapshot, onState(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
