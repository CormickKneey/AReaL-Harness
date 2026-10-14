// Disposable display state, scoped to one observed Session. Never persisted or
// used to acknowledge an operation. Core and the active grant own every read.
export class SessionBodyReader {
  constructor({ pause = () => new Promise((resolve) => setTimeout(resolve, 80)) } = {}) {
    this.pause = pause;
    this.cache = new Map();
    this.epoch = 0;
    this.running = false;
  }
  clear() {
    this.epoch++;
    this.identity = null;
    this.target = null;
    this.cache.clear();
    this.error = "";
  }
  update(detail, turns, request, onChange) {
    const identity =
      detail &&
      JSON.stringify(
        ["projectId", "connectionId", "gatewayGeneration", "serviceGeneration", "subscriptionId"]
          .map((k) => detail[k])
          .concat(detail.snapshot.threadId),
      );
    if (identity !== this.identity) {
      this.clear();
      this.identity = identity;
    }
    this.target = detail && { detail, turns, request, onChange };
    const ids = new Set((turns ?? []).flatMap((t) => t.items.map((i) => `${t.id}/${i.id}`)));
    for (const key of this.cache.keys()) if (!ids.has(key)) this.cache.delete(key);
    if (this.target && !this.running) void this.pump();
  }
  retry() {
    for (const [key, value] of this.cache) if (value.error) this.cache.delete(key);
    this.error = "";
    if (this.target && !this.running) void this.pump();
  }
  get loading() {
    return (this.target?.turns ?? []).some((t) =>
      t.items.some(
        (i) =>
          i.bodyDetail?.state === "available" &&
          this.cache.get(`${t.id}/${i.id}`)?.revision !== i.bodyDetail.revision,
      ),
    );
  }
  decorate(turns = []) {
    return turns.map((t) => ({
      ...t,
      items: t.items.map((i) => {
        const cached = this.cache.get(`${t.id}/${i.id}`);
        const body =
          cached?.body && (cached.revision === i.bodyDetail?.revision || t.status === "inProgress")
            ? cached.body
            : i.body;
        return body ? { ...i, body } : i;
      }),
    }));
  }
  async pump() {
    this.running = true;
    try {
      while (this.target) {
        const target = this.target,
          epoch = this.epoch;
        let selected;
        for (const turn of target.turns ?? [])
          for (const item of turn.items) {
            if (item.bodyDetail?.state !== "available") continue;
            const key = `${turn.id}/${item.id}`,
              cached = this.cache.get(key);
            if (cached?.revision !== item.bodyDetail.revision) {
              selected = { turn, item, key };
              break;
            }
          }
        if (!selected) break;
        const { turn, item, key } = selected,
          revision = item.bodyDetail.revision;
        try {
          let encoded = "",
            cursor,
            version,
            totalBytes;
          do {
            await this.pause();
            if (epoch !== this.epoch) break;
            const page = await target.request({
              method: "session.body",
              context: { projectId: target.detail.projectId },
              params: {
                threadId: target.detail.snapshot.threadId,
                turnId: turn.id,
                itemId: item.id,
                ...(cursor ? { cursor } : {}),
              },
            });
            if (epoch !== this.epoch) break;
            const keys = [
              "projectId",
              "connectionId",
              "gatewayGeneration",
              "serviceGeneration",
              "subscriptionId",
            ];
            if (
              keys.some((k) => page[k] !== target.detail[k]) ||
              page.threadId !== target.detail.snapshot.threadId ||
              page.turnId !== turn.id ||
              page.itemId !== item.id ||
              typeof page.body?.chunk !== "string" ||
              new TextEncoder().encode(page.body.chunk).length > 32768 ||
              !Number.isSafeInteger(page.body.totalBytes) ||
              page.body.totalBytes < 1 ||
              page.body.totalBytes > 4 * 1024 * 1024 ||
              page.body.offset !== new TextEncoder().encode(encoded).length ||
              (version && page.body.version !== version) ||
              (totalBytes && page.body.totalBytes !== totalBytes)
            )
              throw Error("正文分页身份或版本不匹配，请重试");
            version = page.body.version;
            totalBytes = page.body.totalBytes;
            encoded += page.body.chunk;
            const length = new TextEncoder().encode(encoded).length;
            if (
              length > totalBytes ||
              (page.nextCursor && (!page.body.chunk || page.nextCursor === cursor)) ||
              (!page.nextCursor && length !== totalBytes)
            )
              throw Error("正文尚未完整读取，请重试");
            cursor = page.nextCursor;
          } while (cursor);
          if (epoch !== this.epoch) continue;
          const body = JSON.parse(encoded);
          if (body.id !== item.id || body.type !== item.type)
            throw Error("正文所属消息不匹配，请重试");
          this.cache.set(key, { revision, body });
          this.error = "";
          target.onChange();
        } catch (error) {
          if (epoch !== this.epoch) continue;
          this.cache.set(key, { revision, error: true });
          this.error = error.message ?? "正文读取失败，请重试";
          target.onChange();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
