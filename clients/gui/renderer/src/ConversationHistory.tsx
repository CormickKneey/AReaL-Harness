import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import type { Action, Data } from "./services.js";
import { useI18n } from "./i18n/IntlProvider.js";

/** 阅读视图只持有显示缓存；关闭或切换不发送停止、继续或任何任务写入。 */
export function useConversationHistory(projectId: string, thread: Data, action: Action) {
  const { t } = useI18n();
  const [viewId] = useState(() => crypto.randomUUID());
  const owner = `${projectId}:${thread.id}`;
  const current = useRef(owner);
  current.current = owner;
  const supported = thread.displayHistory?.supported === true;
  const [failure, setFailure] = useState<{ owner: string; itemId?: string; message: string }>();
  useEffect(() => {
    if (!supported) return;
    let released = false;
    const request = { projectId, threadId: thread.id, viewId };
    void action("history", { ...request, operation: "acquire" }).catch((error: Error) => {
      if (!released) setFailure({ owner, message: error.message });
    });
    return () => { released = true; void action("history", { ...request, operation: "release" }).catch(() => {}); };
  }, [action, owner, projectId, supported, thread.id, thread.displayHistory?.viewGeneration, viewId]);
  const load = useCallback(async (itemId?: string) => {
    setFailure(undefined);
    try {
      await action("history", { projectId, threadId: thread.id, viewId,
        operation: itemId ? "loadItem" : "loadOlder", ...(itemId ? { itemId } : {}) });
    } catch (error) {
      if (current.current === owner) setFailure({ owner, itemId, message: error instanceof Error ? error.message : t("chat.history.loadFailed") });
    }
  }, [action, owner, projectId, thread.id, viewId, t]);
  return { load, failure: failure?.owner === owner ? failure : undefined };
}

export function DeferredHistoryItem({ item, loading, error, onLoad }: {
  item: Data; loading?: { bytes: number; totalBytes: number }; error?: string; onLoad: () => void;
}) {
  const { t } = useI18n();
  return <div className="notice" data-history-item-id={item.id}>
    <p role="status">{loading ? t("chat.history.loadingFull", { progress: Math.floor(loading.bytes / loading.totalBytes * 100) })
      : t("chat.history.deferred", { kind: item.originalType, size: Math.ceil(item.totalBytes / 1048576) })}</p>
    {error && <p role="alert">{error}</p>}
    <Button type="button" variant="ghost" size="sm" disabled={!!loading} onClick={onLoad}>{t("chat.history.loadFull")}</Button>
  </div>;
}
