const DATABASE = "areal-remote-browser-v1";
const stale = () => new Error("浏览器身份已失效，请重新连接");
const empty = () => ({ schema: 1, revision: null, credential: null, locators: [] });
const validRoom = (room) =>
  room === null || (typeof room === "string" && /^[a-f0-9]{64}$/.test(room));
function validate(record) {
  if (
    !record ||
    record.schema !== 1 ||
    !(record.revision === null || typeof record.revision === "string") ||
    !Array.isArray(record.locators) ||
    record.locators.length > 128 ||
    (record.credential !== null &&
      (!record.credential ||
        ["instance", "identity", "peerId", "hostId"].some(
          (key) => typeof record.credential[key] !== "string" || !record.credential[key],
        ) ||
        (record.credential.relayRoom !== undefined && !validRoom(record.credential.relayRoom))))
  )
    throw new Error("浏览器存储损坏或版本不支持，请清除此设备后重新配对");
  return record;
}

const TARGET_FIELDS = Object.freeze({
  "session.create": [],
  "session.send": ["threadId"],
  "session.control": ["threadId", "operation"],
  "turn.stop": ["threadId", "expectedTurnId"],
  "interaction.respond": ["threadId", "turnId", "interactionId"],
  "task.pause": ["taskId", "expectedRunId"],
  "task.question.reply": ["taskId", "runId", "questionId"],
});
function locator(command) {
  const fields = TARGET_FIELDS[command.method];
  if (
    !fields ||
    ["hostId", "projectId", "commandId"].some(
      (key) => typeof command[key] !== "string" || !command[key] || command[key].length > 512,
    )
  )
    throw new Error("无法保存原命令定位信息");
  const params = {};
  for (const key of fields) {
    const value = command.params?.[key];
    if (typeof value !== "string" || !value || value.length > 512)
      throw new Error("原命令缺少目标身份");
    params[key] = value;
  }
  if (command.method === "interaction.respond" && command.params?.argumentsDigest !== undefined) {
    if (
      typeof command.params.argumentsDigest !== "string" ||
      command.params.argumentsDigest.length > 512
    )
      throw new Error("原审批摘要无效");
    params.argumentsDigest = command.params.argumentsDigest;
  }
  return {
    hostId: command.hostId,
    projectId: command.projectId,
    commandId: command.commandId,
    method: command.method,
    params,
    admissionState: "unknown",
    submissionUnknown: true,
  };
}

function locatorScope(command) {
  return JSON.stringify([
    command.hostId,
    command.projectId,
    command.method,
    ...TARGET_FIELDS[command.method].map((key) => command.params?.[key]),
  ]);
}

// 浏览器策略可让存储 getter 抛错；拒绝持久化仍须允许仅本次使用。
function optionalBrowserResource(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

export class BrowserState {
  constructor({
    createIdentity,
    identityId,
    indexedDB = optionalBrowserResource(() => globalThis.indexedDB),
    channel = optionalBrowserResource(() => new BroadcastChannel(DATABASE)),
    onInvalidate = () => {},
    sessionStorage = optionalBrowserResource(() => globalThis.sessionStorage),
  }) {
    this.createIdentity = createIdentity;
    this.identityId = identityId;
    this.indexedDB = indexedDB;
    this.channel = channel;
    this.onInvalidate = onInvalidate;
    this.sessionStorage = sessionStorage;
    if (channel)
      channel.onmessage = () => {
        const token = this.state;
        if (token && token.mode !== "guest") void this.revalidate(token).catch(() => {});
      };
    this.epoch = 0;
    this.state = null;
    this.dbPromise = null;
    this.storageAccessed = false;
  }
  current() {
    return this.state;
  }
  assertCurrent(token) {
    if (!token || token !== this.state) throw new Error("浏览器身份已失效，请重新连接");
  }
  async guest() {
    const epoch = ++this.epoch;
    this.state = null;
    const identity = await this.createIdentity();
    if (epoch !== this.epoch) throw new Error("浏览器身份已失效，请重新连接");
    return (this.state = Object.freeze({
      epoch,
      identity,
      peerId: this.identityId(identity),
      instance: crypto.randomUUID(),
      mode: "guest",
    }));
  }
  async open() {
    this.storageAccessed = true;
    if (!this.indexedDB) throw new Error("此浏览器无法记住设备：IndexedDB 不可用");
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        let failed = false;
        const request = this.indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("state");
        request.onblocked = () => {
          failed = true;
          reject(new Error("浏览器存储升级被其他标签阻塞，请关闭其他 Remote 标签"));
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (failed) {
            db.close();
            return;
          }
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
            this.invalidate(new Error("浏览器存储版本已变化，请重新打开页面"));
          };
          resolve(db);
        };
      }).catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }
  async transaction(write, action, reset = false) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", write ? "readwrite" : "readonly");
      const store = tx.objectStore("state");
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("浏览器存储事务中止"));
      tx.onerror = () => {};
      const request = store.get("current");
      request.onsuccess = () => {
        try {
          const record = reset ? (request.result ?? empty()) : validate(request.result ?? empty());
          result = action(record);
          if (write) store.put(record, "current");
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }
  invalidate(reason) {
    this.epoch++;
    this.state = null;
    if (reason) this.onInvalidate(reason);
  }
  async restore() {
    this.invalidate();
    const epoch = this.epoch;
    const record = await this.transaction(false, (record) => record);
    if (epoch !== this.epoch) throw stale();
    if (!record.credential) return null;
    const credential = record.credential;
    let peerId;
    try {
      peerId = this.identityId(credential.identity);
    } catch {
      throw new Error("浏览器身份存储损坏");
    }
    if (peerId !== credential.peerId) throw new Error("浏览器身份存储损坏");
    return (this.state = Object.freeze({
      ...credential,
      relayRoom: credential.relayRoom ?? null,
      epoch,
      revision: record.revision,
      mode: "remembered",
    }));
  }
  async prepareRemember(token) {
    this.assertCurrent(token);
    if (token.mode !== "guest") throw new Error("请先选择本次使用的设备身份");
    const record = await this.transaction(false, (record) => record);
    this.assertCurrent(token);
    if (record.credential) throw new Error("本站已有记住的设备，请先恢复或清除");
    return (this.state = Object.freeze({
      ...token,
      revision: record.revision,
      mode: "remembering",
    }));
  }
  async remember(token, hostId, relayRoom = null) {
    this.assertCurrent(token);
    if (!["remembering", "remembered"].includes(token.mode))
      throw new Error("请明确选择记住此设备");
    if (token.mode === "remembered" && token.hostId !== hostId)
      throw new Error("Host 身份绑定不匹配");
    if (typeof hostId !== "string" || !hostId) throw new Error("缺少已验证的 Host 身份");
    if (!validRoom(relayRoom)) throw new Error("Relay 房间无效");
    const revision = crypto.randomUUID();
    await this.transaction(true, (record) => {
      this.assertCurrent(token);
      if (token.mode === "remembered") this.matching(record, token);
      else if (record.revision !== token.revision || record.credential) throw stale();
      record.revision = revision;
      record.credential = {
        instance: token.instance,
        identity: token.identity,
        peerId: token.peerId,
        hostId,
        ...(relayRoom === null ? {} : { relayRoom }),
      };
    });
    this.assertCurrent(token);
    this.state = Object.freeze({ ...token, revision, hostId, relayRoom, mode: "remembered" });
    this.channel?.postMessage({ changed: true });
    return this.state;
  }
  matching(record, token) {
    this.assertCurrent(token);
    if (record.revision !== token.revision || record.credential?.instance !== token.instance)
      throw stale();
  }
  async locators(token) {
    this.assertCurrent(token);
    if (token.mode === "guest") return [];
    const result = await this.transaction(false, (record) => {
      this.matching(record, token);
      const values = record.locators.map((value) => locator(value));
      if (
        values.some((value) => value.hostId !== token.hostId) ||
        new Set(values.map(locatorScope)).size !== values.length
      )
        throw new Error("原命令存储目标冲突，请清除此站点数据后重新配对");
      return values;
    });
    this.assertCurrent(token);
    return result;
  }
  async persistLocator(token, command) {
    this.assertCurrent(token);
    if (token.mode === "guest") return;
    if (token.mode !== "remembered") throw new Error("记住设备尚未完成，不能发送");
    const value = locator(command);
    if (value.hostId !== token.hostId) throw new Error("命令 Host 与设备绑定不匹配");
    await this.transaction(true, (record) => {
      this.matching(record, token);
      const existing = record.locators.find((item) => item.commandId === value.commandId);
      if (existing) {
        if (JSON.stringify(locator(existing)) !== JSON.stringify(value))
          throw new Error("原命令目标不可更改");
      } else {
        const pending = record.locators.find((item) => locatorScope(item) === locatorScope(value));
        if (pending)
          throw Object.assign(new Error("原提交尚未确认，请先查询"), {
            code: "BROWSER_COMMAND_PENDING",
            locator: locator(pending),
          });
        if (record.locators.length >= 128) throw new Error("未确认命令已达上限，请先查询");
        record.locators.push(value);
      }
    });
    this.assertCurrent(token);
  }
  async settleLocator(token, commandId, admissionState) {
    this.assertCurrent(token);
    if (token.mode === "guest" || !["accepted", "rejected"].includes(admissionState)) return;
    await this.transaction(true, (record) => {
      this.matching(record, token);
      record.locators = record.locators.filter((item) => item.commandId !== commandId);
    });
    this.assertCurrent(token);
  }
  draftStorageKey(token) {
    return `${DATABASE}:draft:${token.instance}`;
  }
  drafts(token) {
    this.assertCurrent(token);
    if (token.mode !== "remembered") return { enabled: false, values: [] };
    const raw = this.sessionStorage?.getItem(this.draftStorageKey(token));
    if (!raw) return { enabled: false, values: [] };
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("本标签草稿存储损坏");
    }
    if (
      raw.length > 256 * 1024 ||
      value.schema !== 1 ||
      value.hostId !== token.hostId ||
      !Array.isArray(value.values) ||
      value.values.length > 128 ||
      value.values.some(
        (item) =>
          !item || ["projectId", "threadId", "text"].some((key) => typeof item[key] !== "string"),
      )
    )
      throw new Error("本标签草稿存储损坏");
    return { enabled: true, values: value.values };
  }
  setDraftPersistence(token, enabled) {
    this.assertCurrent(token);
    if (token.mode !== "remembered" || !this.sessionStorage)
      throw new Error("仅记住的设备可以选择恢复本标签草稿");
    if (!enabled) {
      this.sessionStorage.removeItem(this.draftStorageKey(token));
      return;
    }
    if (!this.drafts(token).enabled)
      this.sessionStorage.setItem(
        this.draftStorageKey(token),
        JSON.stringify({ schema: 1, hostId: token.hostId, values: [] }),
      );
  }
  saveDraft(token, projectId, threadId, text) {
    const current = this.drafts(token);
    if (!current.enabled) throw new Error("请先选择恢复本标签草稿");
    if (
      [projectId, threadId, text].some((value) => typeof value !== "string") ||
      !projectId ||
      !threadId
    )
      throw new Error("草稿目标无效");
    const values = current.values.filter(
      (item) => item.projectId !== projectId || item.threadId !== threadId,
    );
    if (text) values.push({ projectId, threadId, text });
    const raw = JSON.stringify({ schema: 1, hostId: token.hostId, values });
    if (values.length > 128 || raw.length > 256 * 1024) throw new Error("本标签草稿已达保存上限");
    this.sessionStorage.setItem(this.draftStorageKey(token), raw);
  }
  async revalidate(token) {
    this.assertCurrent(token);
    if (token.mode === "guest") return token;
    try {
      await this.transaction(false, (record) => {
        if (token.mode === "remembered") this.matching(record, token);
        else if (record.revision !== token.revision || record.credential) throw stale();
      });
      this.assertCurrent(token);
      return token;
    } catch (error) {
      if (this.state === token) {
        try {
          this.sessionStorage?.removeItem(this.draftStorageKey(token));
        } finally {
          this.invalidate(error);
        }
      }
      throw error;
    }
  }
  async forget() {
    const token = this.state;
    this.invalidate();
    let draftError;
    if (token) {
      try {
        this.sessionStorage?.removeItem(this.draftStorageKey(token));
      } catch (error) {
        draftError = error;
      }
    }
    if (!this.storageAccessed && token?.mode !== "remembered" && token?.mode !== "remembering")
      return;
    await this.transaction(
      true,
      (record) => {
        if (
          token?.mode === "remembered" &&
          (record.revision !== token.revision || record.credential?.instance !== token.instance)
        )
          throw stale();
        if (
          token?.mode === "remembering" &&
          record.revision !== token.revision &&
          record.credential?.instance !== token.instance
        )
          throw stale();
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, empty(), { revision: crypto.randomUUID() });
      },
      true,
    );
    this.channel?.postMessage({ changed: true });
    if (draftError) throw draftError;
  }
  close() {
    this.invalidate();
    this.channel?.close();
    this.dbPromise?.then((db) => db.close()).catch(() => {});
    this.dbPromise = null;
  }
}
