// 生产 Remote viewer 的 DOM/解码边界 fixture；不是实际浏览器解码验收。
import assert from "node:assert/strict";
import { ResultReviewView } from "../renderer/remote-web/result-review.mjs";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.listeners = new Map();
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  addEventListener(event, callback) {
    this.listeners.set(event, callback);
  }
  set innerHTML(value) {
    throw Error("untrusted HTML must not execute");
  }
}
const previous = {
  document: globalThis.document,
  createImageBitmap: globalThis.createImageBitmap,
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};
globalThis.document = { createElement: (tag) => new Element(tag) };
let created = [],
  revoked = [],
  decodeCount = 0;
URL.createObjectURL = () => {
  const url = `blob:fixture-${created.length}`;
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => revoked.push(url);
globalThis.createImageBitmap = async () => {
  decodeCount++;
  return { width: 1, height: 1, close() {} };
};
const target = {
  projectId: "p",
  threadId: "t",
  turnId: "turn",
  connectionId: "c",
  gatewayGeneration: "g",
  serviceGeneration: "s",
};
const artifact = { itemId: "image", artifactRef: "opaque", mime: "image/png", size: png.length };
const content = {
  threadId: "t",
  turnId: "turn",
  turnStatus: "failed",
  partial: true,
  taskRunStatus: null,
  notice: "text availability is not success",
  error: { message: "failed" },
  result: [
    { type: "agentMessage", itemId: "text", text: "<script src='https://evil/'>x</script>" },
  ],
  diff: { state: "unavailable", notice: "no historical proof" },
  artifactNotice: "original native media",
};
let current = true,
  override,
  afterChunk;
const call = async (req) => {
  if (req.method === "review.read") {
    const body = JSON.stringify(content);
    return {
      ...target,
      review: {
        encoding: "json-utf8",
        offset: 0,
        totalBytes: Buffer.byteLength(body),
        chunk: body,
      },
      nextCursor: null,
      artifacts: [artifact, { ...artifact, itemId: "image-b", artifactRef: "opaque-b" }],
    };
  }
  assert.equal(req.method, "artifact.read");
  await afterChunk?.();
  return {
    ...target,
    artifactRef: req.params.artifactRef,
    itemId: req.params.artifactRef === "opaque-b" ? "image-b" : artifact.itemId,
    offset: 0,
    totalBytes: png.length,
    nextOffset: null,
    base64: png.toString("base64"),
    raster: { mime: "image/png", width: 1, height: 1 },
    ...override,
  };
};
const all = (node) => [node, ...node.children.flatMap(all)];
const fixture = () => {
  const panel = new Element("section"),
    view = new ResultReviewView(panel, call, target, () => current);
  return { panel, view };
};
try {
  const { panel, view } = fixture();
  await view.load();
  assert.ok(all(panel).some((n) => n.tag === "pre" && n.textContent === content.result[0].text));
  assert.ok(all(panel).some((n) => n.textContent?.includes("failed · 部分输出")));
  assert.ok(all(panel).some((n) => n.textContent?.includes("此结果未提供")));
  assert.ok(!all(panel).some((n) => ["script", "iframe", "img"].includes(n.tag)));
  const block = new Element("section");
  await view.image(artifact, block);
  assert.equal(created.length, 1);
  assert.equal(decodeCount, 1);
  assert.equal(block.children[0].src, created[0]);
  const second = new Element("section");
  await view.image(artifact, second);
  assert.ok(
    revoked.includes(created[0]),
    "switching media releases the previous decode/URL budget",
  );
  view.close();
  assert.ok(revoked.includes(created.at(-1)));
  assert.equal(panel.children.length, 0);
  console.log(
    "PASS literal output, independent Task state, raster validation and ephemeral URL release",
  );
  const { panel: choices, view: selectable } = fixture();
  await selectable.load();
  const selectors = () =>
    all(choices).filter((node) => node.tag === "button" && node.textContent.startsWith("查看图片"));
  const click = async (button) => {
    assert.equal(Boolean(button.disabled), false);
    button.listeners.get("click")();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await click(selectors()[0]);
  await click(selectors().find((node) => node.textContent.includes("image-b")));
  assert.equal(selectors().length, 2, "switching B must preserve A selector");
  await click(selectors()[0]);
  assert.equal(all(choices).filter((node) => node.tag === "img").length, 1);
  assert.ok(
    all(choices)
      .find((node) => node.tag === "img")
      .alt.endsWith("Item image"),
  );
  override = { base64: "<html>" };
  await click(selectors()[1]);
  assert.equal(selectors().length, 2, "failed load preserves retry selector");
  override = undefined;
  await click(selectors()[1]);
  assert.ok(
    all(choices)
      .find((node) => node.tag === "img")
      .alt.endsWith("Item image-b"),
  );
  selectable.close();
  console.log("PASS persistent artifact selectors support A to B to A and failed-load retry");
  const before = created.length;
  for (const invalid of [
    { totalBytes: 16 * 1024 * 1024 + 1 },
    { offset: 1 },
    { artifactRef: "another" },
    { turnId: "another" },
    { serviceGeneration: "stale" },
    { base64: "<svg>" },
    { raster: { mime: "image/png", width: 999999, height: 1 } },
    { nextOffset: 1 },
    { base64: "A".repeat(65540) },
  ]) {
    override = invalid;
    const { view } = fixture(),
      block = new Element("section");
    await view.image(artifact, block);
    assert.equal(created.length, before);
    view.close();
  }
  override = undefined;
  const { view: closed } = fixture();
  afterChunk = () => closed.close();
  await closed.image(artifact, new Element("section"));
  assert.equal(created.length, before);
  afterChunk = () => {
    current = false;
  };
  const { view: stale } = fixture();
  await stale.image(artifact, new Element("section"));
  assert.equal(created.length, before);
  stale.close();
  current = true;
  afterChunk = undefined;
  const { view: decodeStale } = fixture();
  globalThis.createImageBitmap = async () => {
    decodeStale.close();
    return { width: 1, height: 1, close() {} };
  };
  await decodeStale.image(artifact, new Element("section"));
  assert.equal(created.length, before);
  globalThis.createImageBitmap = async () => {
    throw Error("invalid raster decode");
  };
  const { view: badDecode } = fixture();
  await badDecode.image(artifact, new Element("section"));
  assert.equal(created.length, before);
  badDecode.close();
  const malformed = { ...artifact, mime: "image/svg+xml" };
  const { view: badMime } = fixture();
  await badMime.image(malformed, new Element("section"));
  assert.equal(created.length, before);
  badMime.close();
  console.log(
    "PASS browser independent totals, base64/raster budgets, stale service, close/revoke during fetch/decode and unsupported active media",
  );
} finally {
  globalThis.document = previous.document;
  globalThis.createImageBitmap = previous.createImageBitmap;
  URL.createObjectURL = previous.create;
  URL.revokeObjectURL = previous.revoke;
}
