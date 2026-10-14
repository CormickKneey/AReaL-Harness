import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionBodyReader } from "../renderer/remote-web/session-bodies.mjs";
const detail = {
  projectId: "p",
  connectionId: "c",
  gatewayGeneration: "gw",
  serviceGeneration: "g",
  subscriptionId: "s",
  snapshot: { threadId: "t" },
};
const turns = [
  {
    id: "turn",
    items: [
      {
        id: "answer",
        type: "agentMessage",
        preview: "short",
        bodyDetail: { state: "available", revision: "v1" },
      },
    ],
  },
];
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn) {
  for (let n = 0; n < 100; n++) {
    if (fn()) return;
    await tick();
  }
  assert.ok(fn());
}
const page = (body, chunk, nextCursor = null, offset = 0) => ({
  ...detail,
  threadId: "t",
  turnId: "turn",
  itemId: "answer",
  body: { version: "frozen", offset, totalBytes: new TextEncoder().encode(body).length, chunk },
  nextCursor,
});
test("full multipart Unicode text reaches shared GUI item shape without truncation", async () => {
  const body = JSON.stringify({
    id: "answer",
    type: "agentMessage",
    text: "正文".repeat(20000) + "END",
  });
  let reads = 0;
  const reader = new SessionBodyReader({ pause: async () => {} });
  reader.update(
    detail,
    turns,
    async (req) => {
      reads++;
      const start = Number(req.params.cursor ?? 0),
        end = Math.min(body.length, start + 9000);
      return page(
        body,
        body.slice(start, end),
        end < body.length ? String(end) : null,
        new TextEncoder().encode(body.slice(0, start)).length,
      );
    },
    () => {},
  );
  await until(() => reader.decorate(turns)[0].items[0].body?.text.endsWith("END"));
  assert.equal(reads, Math.ceil(body.length / 9000));
  assert.equal(reader.decorate(turns)[0].items[0].body.text, "正文".repeat(20000) + "END");
  reader.clear();
});
test("late body cannot fill a different session or falsely claim complete", async () => {
  let resolve;
  const pending = new Promise((r) => (resolve = r));
  const reader = new SessionBodyReader({ pause: async () => {} });
  reader.update(
    detail,
    turns,
    () => pending,
    () => {},
  );
  await tick();
  reader.clear();
  const body = JSON.stringify({ id: "answer", type: "agentMessage", text: "OLD" });
  resolve(page(body, body));
  await tick();
  assert.equal(reader.decorate(turns)[0].items[0].body, undefined);
});
test("incomplete/mismatched pages show an error and only explicit retry reads again", async () => {
  const reader = new SessionBodyReader({ pause: async () => {} });
  let calls = 0;
  reader.update(
    detail,
    turns,
    async () => {
      calls++;
      return { ...page("{}", "{}"), itemId: "other" };
    },
    () => {},
  );
  await until(() => reader.error);
  assert.equal(calls, 1);
  assert.equal(reader.decorate(turns)[0].items[0].body, undefined);
  reader.update(
    detail,
    turns,
    async () => {
      calls++;
    },
    () => {},
  );
  await tick();
  assert.equal(calls, 1);
  reader.clear();
});
test("new completed content supersedes a late streaming version", async () => {
  let resolve;
  const pending = new Promise((r) => (resolve = r));
  const reader = new SessionBodyReader({ pause: async () => {} });
  const old = [{ id: "turn", status: "inProgress", items: turns[0].items }];
  reader.update(
    detail,
    old,
    () => pending,
    () => {},
  );
  await tick();
  const final = [
    {
      id: "turn",
      status: "completed",
      items: [{ ...turns[0].items[0], bodyDetail: { state: "available", revision: "v2" } }],
    },
  ];
  const complete = JSON.stringify({ id: "answer", type: "agentMessage", text: "FINAL_END" });
  reader.update(
    detail,
    final,
    async () => page(complete, complete),
    () => {},
  );
  const stale = JSON.stringify({ id: "answer", type: "agentMessage", text: "STALE" });
  resolve(page(stale, stale));
  await until(() => reader.decorate(final)[0].items[0].body?.text === "FINAL_END");
  reader.clear();
});
