import { realpathSync } from "node:fs";

// 后台服务的 Resources 链接回主应用；跳过物理文件的全部别名，避免二次签名使清单失效。
export function preserveSignedPaths(paths) {
  const protectedPaths = new Set(paths.map((path) => realpathSync(path)));
  return (path) => {
    try {
      return protectedPaths.has(realpathSync(path));
    } catch {
      return false;
    }
  };
}
