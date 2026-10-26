// @ts-check
"use strict";

const { basename } = require("node:path");
const { serviceName } = require("./core/desktop-executables.cjs");

// 只装配当前桌面客户端；不提供旧 GUI 或其他后端回退入口。
require(
  process.argv.some((value) => value.startsWith("--areal-core-service")) ||
    (process.platform === "darwin" && basename(process.execPath) === serviceName)
    ? "./core/service-main.cjs"
    : "./core/main.cjs",
);
