import { rasterInfo, RASTER_MAX_BYTES } from "../../packages/remote/src/raster.mjs";
const encoder = new TextEncoder();
const text = (tag, value) => {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
};
// 页面仅持有当前审查的短期内容；关闭或连接身份变化立即丢弃并撤销 URL。
export class ResultReviewView {
  constructor(container, call, target, current) {
    container.className = "result-review";
    this.container = container;
    this.call = call;
    this.target = target;
    this.current = current;
    this.epoch = 0;
    this.imageEpoch = 0;
    this.urls = new Set();
    this.body = "";
    this.artifacts = [];
    this.closed = false;
  }
  valid(epoch) {
    return !this.closed && this.epoch === epoch && this.current();
  }
  clearImage() {
    this.imageEpoch++;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    if (this.imageButton) this.imageButton.disabled = false;
    this.imageButton = null;
    this.imageBlock?.replaceChildren();
    this.imageBlock = null;
  }
  close() {
    this.clearImage();
    this.closed = true;
    this.epoch++;
    this.body = "";
    this.artifacts = [];
    this.container.replaceChildren();
  }
  fail(error) {
    this.close();
    this.container.append(text("p", error?.message || "原结果不可用，请在桌面查看"));
  }
  same(page) {
    for (const key of [
      "projectId",
      "threadId",
      "turnId",
      "connectionId",
      "gatewayGeneration",
      "serviceGeneration",
    ])
      if (page[key] !== this.target[key]) throw Error("结果所属连接或原 Turn 已变化");
  }
  async load(cursor) {
    const epoch = this.epoch;
    try {
      const page = await this.call({
        method: "review.read",
        context: { projectId: this.target.projectId },
        params: {
          threadId: this.target.threadId,
          turnId: this.target.turnId,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!this.valid(epoch)) return;
      this.same(page);
      if (
        page.review?.encoding !== "json-utf8" ||
        typeof page.review.chunk !== "string" ||
        !Number.isSafeInteger(page.review.totalBytes) ||
        page.review.totalBytes < 1 ||
        page.review.totalBytes > 4 * 1024 * 1024 ||
        page.review.offset !== encoder.encode(this.body).length ||
        encoder.encode(page.review.chunk).length > 16 * 1024 ||
        (this.total !== undefined && this.total !== page.review.totalBytes)
      )
        throw Error("结果分页超出预算或已变化");
      this.total = page.review.totalBytes;
      if (!cursor) {
        if (!Array.isArray(page.artifacts) || page.artifacts.length > 16)
          throw Error("制品列表无效");
        this.artifacts = page.artifacts;
      }
      this.body += page.review.chunk;
      const bytes = encoder.encode(this.body).length;
      if (
        bytes > this.total ||
        (!page.nextCursor && bytes !== this.total) ||
        (page.nextCursor && bytes >= this.total)
      )
        throw Error("结果分页不完整");
      this.container.replaceChildren();
      const close = text("button", "关闭结果审查");
      close.addEventListener("click", () => this.close());
      this.container.append(close);
      if (page.nextCursor) {
        this.container.append(text("p", `原结果已读取 ${bytes} / ${this.total} 字节；尚未完整。`));
        const more = text("button", "继续读取原结果");
        more.addEventListener("click", () => {
          more.disabled = true;
          void this.load(page.nextCursor);
        });
        this.container.append(more);
        return;
      }
      const result = JSON.parse(this.body);
      if (result.threadId !== this.target.threadId || result.turnId !== this.target.turnId)
        throw Error("原结果身份不匹配");
      this.container.append(
        text(
          "h3",
          `原 Turn ${result.turnId} · ${result.turnStatus}${result.partial ? " · 部分输出" : ""}`,
        ),
        text("p", result.notice),
        text("p", `Task Run 状态：${result.taskRunStatus ?? "此结果未提供；请单独查看 Task Run"}`),
      );
      if (result.error) this.container.append(text("pre", JSON.stringify(result.error, null, 2)));
      for (const item of result.result)
        this.container.append(
          text("small", `${item.type} · ${item.itemId}${item.phase ? " · " + item.phase : ""}`),
          text("pre", item.text),
        );
      this.container.append(text("p", result.diff.notice));
      if (result.diff.state === "available")
        for (const file of result.diff.files) {
          this.container.append(text("h4", file.path));
          for (const hunk of file.hunks)
            this.container.append(
              text(
                "pre",
                `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n` +
                  hunk.lines
                    .map(
                      (line) =>
                        `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`,
                    )
                    .join("\n"),
              ),
            );
        }
      this.container.append(text("p", result.artifactNotice));
      for (const artifact of this.artifacts) {
        const block = text("section", "");
        const button = text(
          "button",
          `查看图片 · ${artifact.itemId} · ${artifact.mime} · ${artifact.size} 字节`,
        );
        // 选择入口独立于短期预览，切换或加载失败后仍可重新选择。
        const preview = text("div", "");
        button.addEventListener("click", () => {
          void this.image(artifact, preview, button);
        });
        block.append(button, preview);
        this.container.append(block);
      }
    } catch (error) {
      if (this.valid(epoch)) this.fail(error);
    }
  }
  async image(artifact, block, button) {
    this.clearImage();
    this.imageButton = button;
    if (button) button.disabled = true;
    this.imageBlock = block;
    const epoch = this.epoch,
      imageEpoch = this.imageEpoch;
    const valid = () => this.valid(epoch) && this.imageEpoch === imageEpoch;
    try {
      if (
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 1 ||
        artifact.size > RASTER_MAX_BYTES ||
        typeof artifact.artifactRef !== "string" ||
        artifact.artifactRef.length > 2048
      )
        throw Error("制品超过接收预算");
      const bytes = new Uint8Array(artifact.size);
      let offset = 0,
        declared;
      while (offset < bytes.length) {
        const chunk = await this.call({
          method: "artifact.read",
          context: { projectId: this.target.projectId },
          params: { artifactRef: artifact.artifactRef, offset, length: 48 * 1024 },
        });
        if (!valid()) return;
        this.same(chunk);
        if (
          chunk.itemId !== artifact.itemId ||
          chunk.artifactRef !== artifact.artifactRef ||
          chunk.offset !== offset ||
          chunk.totalBytes !== bytes.length ||
          typeof chunk.base64 !== "string" ||
          chunk.base64.length > 65536 ||
          !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.base64)
        )
          throw Error("制品块或归属无效");
        const raw = Uint8Array.from(atob(chunk.base64), (c) => c.charCodeAt(0));
        if (
          !raw.length ||
          raw.length > 48 * 1024 ||
          offset + raw.length > bytes.length ||
          chunk.nextOffset !== (offset + raw.length < bytes.length ? offset + raw.length : null)
        )
          throw Error("制品大小不匹配");
        if (declared && JSON.stringify(declared) !== JSON.stringify(chunk.raster))
          throw Error("图片元信息已变化");
        declared = chunk.raster;
        bytes.set(raw, offset);
        offset += raw.length;
        block.replaceChildren(text("p", `图片已读取 ${offset} / ${bytes.length} 字节`));
        if (offset < bytes.length) {
          await new Promise((resolve) => setTimeout(resolve, 75));
          if (!valid()) return;
        }
      }
      const info = rasterInfo(bytes, artifact.mime);
      if (
        !declared ||
        info.mime !== declared.mime ||
        info.width !== declared.width ||
        info.height !== declared.height
      )
        throw Error("图片尺寸与传输声明不一致");
      const blob = new Blob([bytes], { type: info.mime });
      const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
      try {
        if (bitmap.width !== info.width || bitmap.height !== info.height)
          throw Error("图片解码尺寸不一致");
      } finally {
        bitmap.close();
      }
      if (!valid()) return;
      const url = URL.createObjectURL(blob);
      this.urls.add(url);
      const image = document.createElement("img");
      image.alt = `原 Turn ${this.target.turnId} / Item ${artifact.itemId}`;
      image.style.maxWidth = "100%";
      image.src = url;
      block.replaceChildren(image);
    } catch (error) {
      if (valid()) block.replaceChildren(text("p", error.message || "图片不可用，请在桌面查看"));
    } finally {
      if (valid() && button) button.disabled = false;
    }
  }
}
