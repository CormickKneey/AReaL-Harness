# AReaL-Harness 官网

**中文** | [English](README.en.md)

双语宣传与下载官网是独立的 React/Vite 应用。页面沿用选定的深色设计、既有品牌资产与真实 TUI 截图。截图保留原始比例，并提供完整截图链接，因此比选定视觉方案中的示意截图更高。

## 本地开发

使用 Node.js 22，在 `website/` 中执行。

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

默认语言为英语。EN / 中文开关翻译页面、文档元数据、无障碍标签与文档目标。查询参数 `lang=en` 或 `lang=zh` 优先于已保存的语言。URL 同时保留客户端、渠道、平台与章节选择。本地存储不可用时，当前页面仍可切换语言。

```sh
npm run build
npm run check
npm run test:sites
```

静态站点位于 `dist/client/`。资源 URL 使用相对路径，兼容 GitHub Pages 项目路径及 fork 仓库路径。Sites 打包文件还会生成 `dist/server/` 与 `dist/.openai/`。Pages 只上传 `dist/client/`。

`check` 校验版本排序、渠道隔离、缺包行为、附件 URL 信任边界、上传完整状态、翻译键一致性、刷新失败时的原子写入与构建后的相对资源。外观、交互和响应式布局仍需要浏览器验收。

## 发布目录

访客读取随站点构建的 `src/generated/releases.json` 快照。普通开发与构建使用已提交的快照，不请求 GitHub API。Pages 部署在构建前刷新目录。无论官网托管在哪个仓库，下载来源始终是官方 `areal-project/AReaL-Harness`。

```sh
npm run refresh:releases
npm run refresh:releases -- --input saved-github-releases.json
```

可选环境变量 `GH_TOKEN` 仅供构建脚本认证，不进入浏览器代码。保存的输入必须是完整 GitHub Release 数组，包含附件的 `state`、`size` 和 `browser_download_url`。脚本校验选中的版本后原子写入目录。刷新失败时返回错误并保留原快照。

GUI 使用 `gui-v<version>` 标签，TUI 使用 `v<version>` 标签。草稿与元数据标签不参与选择。每个客户端与渠道先按数字 SemVer 选择最高版本，再检查安装包。稳定版必须同时满足正式版本号与 `prerelease=false`，其他可识别的已发布版本归入预览版。缺包时不回退到旧版本或其他渠道。

GUI 仅支持 macOS Apple 芯片，优先下载 Release 中的 DMG，其次为 ZIP。TUI 支持 macOS ARM64 与 Linux x86_64，Linux 需要 glibc 2.35+。TUI 下载使用完整归档包，并提供同一版本的安装脚本与校验和。可复制所选归档包的下载命令和直接下载地址。命令只下载归档包，安装步骤见既有安装指南。官网链接既有安装指南，不执行安装程序。

预览版用于早期测试，可能不稳定。macOS 预览构建未经公证。稳定版 GUI 的签名说明仅适用于该发行包，不代表 TUI 或所有 Runtime 二进制都经过公证。

## GitHub Pages

`../.github/workflows/website.yml` 在 PR 与 `main` 推送涉及官网时构建并校验。手动运行默认也只做校验。

在实际托管仓库的默认分支加入此工作流，并启用 Actions。管理员先将 Pages 来源设置为 **GitHub Actions**，并允许 `github-pages` 环境从默认分支部署。若环境要求人工审批，自动部署也会等待审批。工作流只配置已经启用的 Pages 站点，不会自动启用 Pages。

在托管仓库设置非秘密仓库变量 `WEBSITE_AUTO_DEPLOY=true`，即可启用自动发布，无须新增 secret。官网托管在官方仓库时，`release.published` 事件立即排队转发到默认分支部署，覆盖正式版与从草稿发布的预览版。转发成功只表示部署请求已受理。创建草稿不会触发部署。

每小时第 17 分钟的定时任务读取官方 Release，覆盖 fork 托管、`GITHUB_TOKEN` 发布不产生后续事件，以及旧标签不含转发工作流的情况。每次定时任务都会构建并部署，因此每天有 24 次基线部署尝试。合入默认分支的网站源码也会在下一次定时任务部署。GitHub 调度可能延迟或丢弃任务，公共仓库 60 天无活动后会停用定时任务，所以这不是严格的一小时同步 SLA。

手动部署时，从默认分支运行 **Website**，并将 **deploy** 设置为 `true`。手动部署不要求设置自动发布变量。其他分支不能部署。PR、推送与手动校验不会直接部署。

每次部署都检出默认分支，刷新完整的 GUI stable、GUI preview、TUI stable 与 TUI preview 目录，再构建、校验、上传 `dist/client/` 并部署。现有 TUI 下载命令与直接 URL 仍来自同一目录。只有部署 job 具有 Pages 与身份令牌写权限。所有部署共用并发组，不取消正在进行的部署。刷新、构建或校验失败会保留上次成功的网站。刷新只更新 runner 工作区，不提交快照。更新普通离线快照时，显式执行刷新命令并提交生成目录。
