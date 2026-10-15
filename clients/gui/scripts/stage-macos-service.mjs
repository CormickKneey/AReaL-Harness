import { copyFile, cp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { serviceName } = require("../app/src/core/desktop-executables.cjs");

export async function stageMacOSService(app) {
  const contents = join(app, "Contents");
  const frameworks = join(contents, "Frameworks");
  const shared = await readdir(frameworks);
  const service = join(frameworks, `${serviceName}.app`, "Contents");
  const info = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(contents, "Info.plist")], {
      encoding: "utf8",
    }),
  );
  await mkdir(join(service, "MacOS"), { recursive: true });
  await mkdir(join(service, "Frameworks"));
  await copyFile(
    join(contents, "MacOS", info.CFBundleExecutable),
    join(service, "MacOS", serviceName),
  );
  const serviceInfo = {
    CFBundleIdentifier: `${info.CFBundleIdentifier}.service`,
    CFBundleExecutable: serviceName,
    CFBundleName: info.CFBundleName,
    CFBundleDisplayName: serviceName,
    CFBundlePackageType: "APPL",
    CFBundleVersion: info.CFBundleVersion,
    CFBundleShortVersionString: info.CFBundleShortVersionString,
    LSMinimumSystemVersion: info.LSMinimumSystemVersion,
    LSBackgroundOnly: true,
    NSPrincipalClass: info.NSPrincipalClass,
    ElectronMainProcess: true,
    ElectronAsarIntegrity: info.ElectronAsarIntegrity,
  };
  const plist = join(service, "Info.plist");
  await writeFile(plist, JSON.stringify(serviceInfo));
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", plist]);
  // Electron 子进程要求完整、独立的 bundle 布局，避免沙箱沿框架别名解析到另一应用身份。
  // 仅应用资源链接回主包，不复制 Core、凭据或历史。
  for (const name of shared) {
    const link = join(service, "Frameworks", name);
    await cp(join(frameworks, name), link, { recursive: true, verbatimSymlinks: true });
    if (name.endsWith(".app")) {
      const childPlist = join(link, "Contents", "Info.plist");
      const child = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", childPlist], {
          encoding: "utf8",
        }),
      );
      child.CFBundleIdentifier = child.CFBundleIdentifier.replace(
        info.CFBundleIdentifier,
        serviceInfo.CFBundleIdentifier,
      );
      await writeFile(childPlist, JSON.stringify(child));
      execFileSync("/usr/bin/plutil", ["-convert", "xml1", childPlist]);
    }
  }
  const resources = join(service, "Resources");
  await symlink(relative(dirname(resources), join(contents, "Resources")), resources);
  return {
    executable: join(service, "MacOS", serviceName),
    bundleId: serviceInfo.CFBundleIdentifier,
  };
}
