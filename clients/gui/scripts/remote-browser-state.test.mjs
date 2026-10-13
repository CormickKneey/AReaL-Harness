import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserState } from "../renderer/remote-web/browser-state.mjs";

test("guest identity remains page memory and late identity generation cannot survive forget", async () => {
  let complete;
  const state = new BrowserState({
    createIdentity: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    identityId: (key) => `peer-${key}`,
    indexedDB: undefined,
    channel: null,
  });
  const opening = state.guest();
  await state.forget();
  complete("private");
  await assert.rejects(opening, /失效/);
  assert.equal(state.current(), null);
});

import { IDBFactory } from "fake-indexeddb";
function fixture(indexedDB = new IDBFactory(), extra = {}) {
  return new BrowserState({
    createIdentity: async () => "private",
    identityId: (key) => `peer-${key}`,
    indexedDB,
    channel: null,
    ...extra,
  });
}
test("remember requires opt-in and successful pin commit; reload derives and verifies peer identity", async () => {
  const db = new IDBFactory();
  const page = fixture(db);
  const guest = await page.guest();
  await assert.rejects(page.remember(guest, "host"), /记住/);
  assert.equal(await fixture(db).restore(), null);
  const opted = await page.prepareRemember(guest);
  assert.equal(await fixture(db).restore(), null);
  const remembered = await page.remember(opted, "host");
  assert.equal(remembered.mode, "remembered");
  const reload = await fixture(db).restore();
  assert.equal(reload.identity, "private");
  assert.equal(reload.peerId, "peer-private");
  assert.equal(reload.hostId, "host");
  await assert.rejects(fixture(db, { identityId: () => "wrong-peer" }).restore(), /损坏/);
});

async function paired(db = new IDBFactory(), extra = {}) {
  const page = fixture(db, extra);
  const token = await page.remember(await page.prepareRemember(await page.guest()), "host");
  return { page, token, db };
}
test("remembered commands survive reload only as unknown locators without text or authority", async () => {
  const { page, token, db } = await paired();
  await page.persistLocator(token, {
    hostId: "host",
    projectId: "project",
    commandId: "send-1",
    method: "session.send",
    params: {
      threadId: "thread",
      text: "SECRET TEXT",
      expectedConfigRevision: 99,
      invitation: "SECRET INVITE",
    },
    grantRevision: 22,
  });
  const reload = fixture(db);
  const restored = await reload.restore();
  assert.deepEqual(await reload.locators(restored), [
    {
      hostId: "host",
      projectId: "project",
      commandId: "send-1",
      method: "session.send",
      params: { threadId: "thread" },
      admissionState: "unknown",
      submissionUnknown: true,
    },
  ]);
  for (const admission of ["pending", "unknown", "notFound"]) {
    await reload.settleLocator(restored, "send-1", admission);
    assert.equal((await reload.locators(restored)).length, 1);
  }
  await reload.settleLocator(restored, "send-1", "accepted");
  assert.deepEqual(await reload.locators(restored), []);
});

test("forget tombstone prevents stale tabs and queued opt-in from resurrecting old credentials or locators", async () => {
  const { page, token, db } = await paired();
  const other = fixture(db);
  const otherToken = await other.restore();
  await page.forget();
  assert.equal(page.current(), null);
  await assert.rejects(
    other.persistLocator(otherToken, {
      hostId: "host",
      projectId: "p",
      commandId: "late",
      method: "session.create",
    }),
    /失效/,
  );
  assert.equal(await fixture(db).restore(), null);
  const pending = fixture(db);
  const choice = await pending.prepareRemember(await pending.guest());
  await page.forget();
  await assert.rejects(pending.remember(choice, "host"), /失效/);
  const replacement = await paired(db);
  await assert.rejects(other.forget(), /失效/);
  assert.equal((await fixture(db).restore()).instance, replacement.token.instance);
});

test("foreground revalidation invalidates stale in-memory identity", async () => {
  const { page, db } = await paired();
  const other = fixture(db);
  const token = await other.restore();
  await page.forget();
  await assert.rejects(other.revalidate(token), /失效/);
  assert.equal(other.current(), null);
});

function tabStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
test("drafts require separate opt-in, survive same-tab reload, and disappear on forget or a new tab", async () => {
  const sessionStorage = tabStorage();
  const { page, token, db } = await paired(undefined, { sessionStorage });
  assert.throws(() => page.saveDraft(token, "project", "thread", "draft"), /草稿/);
  page.setDraftPersistence(token, true);
  page.saveDraft(token, "project", "thread", "draft");
  const reload = fixture(db, { sessionStorage });
  const restored = await reload.restore();
  assert.deepEqual(reload.drafts(restored), {
    enabled: true,
    values: [{ projectId: "project", threadId: "thread", text: "draft" }],
  });
  const newTab = fixture(db, { sessionStorage: tabStorage() });
  assert.deepEqual(newTab.drafts(await newTab.restore()), { enabled: false, values: [] });
  await reload.forget();
  assert.deepEqual(page.drafts(token), { enabled: false, values: [] });
});

// 只在 IndexedDB 外部 API 注入提交故障，业务模块仍使用原事务接口。
function faultableDatabase() {
  const indexedDB = new IDBFactory();
  const open = indexedDB.open.bind(indexedDB);
  let abortNext = false,
    observePut = () => {};
  indexedDB.open = (...args) => {
    const request = open(...args);
    request.addEventListener("success", () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (...args) => {
        const tx = transaction(...args);
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const store = objectStore(name);
          const put = store.put.bind(store);
          store.put = (...args) => {
            const result = put(...args);
            result.addEventListener("success", () => {
              observePut();
              if (abortNext) {
                abortNext = false;
                tx.abort();
              }
            });
            return result;
          };
          return store;
        };
        return tx;
      };
    });
    return request;
  };
  return {
    indexedDB,
    abort: () => {
      abortNext = true;
    },
    observe: (fn) => {
      observePut = fn;
    },
  };
}
test("request success is not a committed identity or permission to send", async () => {
  const disk = faultableDatabase();
  const page = fixture(disk.indexedDB);
  const choice = await page.prepareRemember(await page.guest());
  disk.abort();
  await assert.rejects(page.remember(choice, "host"), /abort|中止/i);
  assert.equal(page.current().mode, "remembering");
  assert.equal(await fixture(disk.indexedDB).restore(), null);
  const token = await page.remember(choice, "host");
  let sent = false;
  disk.observe(() => {
    assert.equal(sent, false);
  });
  disk.abort();
  await assert.rejects(
    page
      .persistLocator(token, {
        hostId: "host",
        projectId: "p",
        commandId: "c",
        method: "session.create",
      })
      .then(() => {
        sent = true;
      }),
    /abort|中止/i,
  );
  assert.equal(sent, false);
  assert.deepEqual(await page.locators(token), []);
  disk.abort();
  await assert.rejects(page.forget(), /abort|中止/i);
  assert.equal(page.current(), null);
  assert.equal((await fixture(disk.indexedDB).restore()).instance, token.instance);
});

test("broadcast invalidation disables another live tab without sharing credentials in messages", async () => {
  const channels = new Set();
  const channel = () => {
    const value = {
      onmessage: null,
      postMessage: (data) => {
        assert.deepEqual(data, { changed: true });
        for (const peer of channels)
          if (peer !== value) queueMicrotask(() => peer.onmessage?.({ data }));
      },
      close: () => channels.delete(value),
    };
    channels.add(value);
    return value;
  };
  const { page, db } = await paired(undefined, { channel: channel() });
  let invalidate;
  const invalidated = new Promise((resolve) => {
    invalidate = resolve;
  });
  const other = fixture(db, { channel: channel(), onInvalidate: invalidate });
  await other.restore();
  await page.forget();
  await invalidated;
  assert.equal(other.current(), null);
});

test("storage denial is explicit and does not prevent memory-only guest use", async () => {
  const indexedDB = {
    open() {
      throw new DOMException("storage denied", "SecurityError");
    },
  };
  const page = fixture(indexedDB);
  const guest = await page.guest();
  await assert.rejects(page.prepareRemember(guest), /storage denied/);
  assert.equal(page.current().mode, "guest");
});

test("schema version change closes old handles and invalidates the live consumer", async () => {
  const db = new IDBFactory();
  let invalidated = false;
  const { page } = await paired(db, {
    onInvalidate: () => {
      invalidated = true;
    },
  });
  const names = await db.databases();
  await new Promise((resolve, reject) => {
    const request = db.open(names[0].name, 2);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  assert.equal(invalidated, true);
  assert.equal(page.current(), null);
  await assert.rejects(fixture(db).restore(), /version/i);
});

test("interaction recovery stores only original target and two tabs cannot overwrite one unresolved scope", async () => {
  const { page, token, db } = await paired();
  await page.persistLocator(token, {
    hostId: "host",
    projectId: "p",
    commandId: "answer",
    method: "interaction.respond",
    params: {
      threadId: "t",
      turnId: "turn",
      interactionId: "question",
      argumentsDigest: "digest",
      answers: { private: "body" },
      decision: "allowOnce",
      reviewToken: "private-proof",
    },
  });
  const other = fixture(db),
    otherToken = await other.restore();
  assert.deepEqual((await other.locators(otherToken))[0].params, {
    threadId: "t",
    turnId: "turn",
    interactionId: "question",
    argumentsDigest: "digest",
  });
  await assert.rejects(
    other.persistLocator(otherToken, {
      hostId: "host",
      projectId: "p",
      commandId: "duplicate",
      method: "interaction.respond",
      params: { threadId: "t", turnId: "turn", interactionId: "question" },
    }),
    (error) => error.code === "BROWSER_COMMAND_PENDING" && error.locator.commandId === "answer",
  );
  assert.equal((await page.locators(token)).length, 1);
});

test("denied browser storage getters still permit guest construction", async () => {
  const originals = new Map(
    ["indexedDB", "sessionStorage", "BroadcastChannel"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  try {
    for (const key of originals.keys())
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    const page = new BrowserState({
      createIdentity: async () => "guest",
      identityId: (key) => key,
    });
    assert.equal((await page.guest()).mode, "guest");
    await assert.rejects(page.prepareRemember(page.current()), /IndexedDB/);
    page.close();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("failed storage recovery cannot falsely confirm a later forget", async () => {
  const page = fixture({
    open() {
      throw new DOMException("storage denied", "SecurityError");
    },
  });
  await assert.rejects(page.restore(), /storage denied/);
  await page.guest();
  await assert.rejects(page.forget(), /storage denied/);
  assert.equal(page.current(), null);
});

test("Task reply persists only immutable Task Run question locators and restores unknown", async () => {
  const { page, token, db } = await paired();
  await page.persistLocator(token, {
    hostId: "host",
    projectId: "project",
    commandId: "task-reply",
    method: "task.question.reply",
    params: { taskId: "task", runId: "run", questionId: "question", answers: { color: "SECRET" } },
  });
  const reload = fixture(db),
    restored = await reload.restore();
  assert.deepEqual((await reload.locators(restored))[0], {
    hostId: "host",
    projectId: "project",
    commandId: "task-reply",
    method: "task.question.reply",
    params: { taskId: "task", runId: "run", questionId: "question" },
    admissionState: "unknown",
    submissionUnknown: true,
  });
});

test("remembered Relay room is validated and committed with its Host identity; old Direct records remain valid", async () => {
  const db = new IDBFactory(),
    room = "a".repeat(64);
  const state = fixture(db),
    choice = await state.prepareRemember(await state.guest());
  for (const invalid of ["https://relay.example", "A".repeat(64), "invite-secret", { room }])
    await assert.rejects(state.remember(choice, "host", invalid), /房间/);
  assert.equal(await fixture(db).restore(), null);
  const saved = await state.remember(choice, "host", room);
  const other = fixture(db),
    restored = await other.restore();
  assert.equal(saved.relayRoom, room);
  assert.equal(restored.relayRoom, room);
  assert.equal(restored.hostId, "host");
  const record = await state.transaction(false, (record) => record);
  assert.deepEqual(Object.keys(record.credential).sort(), [
    "hostId",
    "identity",
    "instance",
    "peerId",
    "relayRoom",
  ]);
  await state.forget();
  await assert.rejects(other.revalidate(restored), /失效/);
  assert.equal(await fixture(db).restore(), null);
  const oldDirect = await paired(db);
  assert.equal((await fixture(db).restore()).relayRoom, null);
  assert.equal(
    (await oldDirect.page.transaction(false, (record) => record)).credential.relayRoom,
    undefined,
  );
});

test("failed Relay remember transaction and stale opt-in never persist routing metadata", async () => {
  const faults = faultableDatabase(),
    room = "b".repeat(64);
  const state = fixture(faults.indexedDB),
    choice = await state.prepareRemember(await state.guest());
  faults.abort();
  await assert.rejects(state.remember(choice, "host", room), /abort|中止/i);
  assert.equal(await fixture(faults.indexedDB).restore(), null);
  const other = fixture(faults.indexedDB);
  await other.restore();
  await other.forget();
  await assert.rejects(state.remember(choice, "host", room), /失效/);
  assert.equal(await fixture(faults.indexedDB).restore(), null);
});

test("malformed stored Relay room cannot be restored or bypassed by a remembered identity", async () => {
  const { page, db } = await paired();
  await page.transaction(true, (record) => {
    record.credential.relayRoom = "https://foreign.example/#invite=secret";
  });
  await assert.rejects(fixture(db).restore(), /损坏/);
});

test("guest Relay use does not open a persistence database", async () => {
  let opens = 0;
  const page = fixture({
    open() {
      opens++;
      throw new Error("guest must not open IDB");
    },
  });
  const token = await page.guest();
  await page.revalidate(token);
  await assert.rejects(page.remember(token, "host", "a".repeat(64)), /记住/);
  assert.equal(opens, 0);
});

test("same pinned Host may atomically refresh its public room while abort and cross-tab revision keep the old binding", async () => {
  const faults = faultableDatabase(),
    roomA = "a".repeat(64),
    roomB = "b".repeat(64);
  const page = fixture(faults.indexedDB);
  const first = await page.remember(await page.prepareRemember(await page.guest()), "host", roomA);
  const other = fixture(faults.indexedDB),
    old = await other.restore();
  await assert.rejects(page.remember(first, "other-host", roomB), /绑定/);
  faults.abort();
  await assert.rejects(page.remember(first, "host", roomB), /abort|中止/i);
  assert.equal((await fixture(faults.indexedDB).restore()).relayRoom, roomA);
  const refreshed = await page.remember(first, "host", roomB);
  assert.equal(refreshed.identity, first.identity);
  assert.equal(refreshed.instance, first.instance);
  assert.notEqual(refreshed.revision, first.revision);
  assert.equal((await fixture(faults.indexedDB).restore()).relayRoom, roomB);
  await assert.rejects(other.remember(old, "host", roomA), /失效/);
  await page.forget();
  assert.equal(await fixture(faults.indexedDB).restore(), null);
});
