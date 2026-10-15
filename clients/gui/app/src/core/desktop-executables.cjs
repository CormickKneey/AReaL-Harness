"use strict";

const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const serviceName = "AReaL Harness Service";

function desktopExecutables({
    packaged,
    platform = process.platform,
    executable = process.execPath,
    resourcesPath = process.resourcesPath,
} = {}) {
    if (!packaged || platform !== "darwin") return { gui: executable, service: executable };
    // 后台资源链接回主包；规范路径使通知和后台启动都指向同一安装，且保留原安全存储身份。
    const contents = dirname(realpathSync(resourcesPath));
    return {
        gui: join(contents, "MacOS", "AReaL Harness GUI"),
        service: join(
            contents,
            "Frameworks",
            `${serviceName}.app`,
            "Contents",
            "MacOS",
            serviceName,
        ),
    };
}

module.exports = { desktopExecutables, serviceName };
