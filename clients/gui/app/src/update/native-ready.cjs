// @ts-check
"use strict";

// 原生准备超时也必须保留 Core；所有终态均释放本轮监听器。
/** @param {import("electron").AutoUpdater} nativeUpdater @returns {Promise<void>} */
function prepareNativeInstall(nativeUpdater, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      nativeUpdater.removeListener("update-downloaded", ready);
      nativeUpdater.removeListener("error", failed);
      nativeUpdater.removeListener("update-not-available", unavailable);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    /** @param {unknown} error */
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const unavailable = () => failed(new Error("原生更新器未找到可安装的更新，请重试。"));
    const timer = setTimeout(
      () => failed(new Error("原生更新校验超时，后台未停止，请重试。")),
      timeoutMs,
    );
    nativeUpdater.once("update-downloaded", ready);
    nativeUpdater.once("error", failed);
    nativeUpdater.once("update-not-available", unavailable);
    try {
      nativeUpdater.checkForUpdates();
    } catch (error) {
      failed(error);
    }
  });
}

module.exports = { prepareNativeInstall };
