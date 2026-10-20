/** @typedef {{ client: 'gui' | 'tui', channel: 'stable' | 'preview', platform: 'macos-arm64' | 'linux-x64' }} Selection */
export const platforms = { gui: ["macos-arm64"], tui: ["macos-arm64", "linux-x64"] };
export const officialRepository = "https://github.com/areal-project/AReaL-Harness";
export const translations = {
  en: {
    title: "AReaL-Harness | A modular framework for tool execution and multi-agent collaboration",
    description:
      "A modular framework for tool execution and multi-agent collaboration. Composable Core · Independent Runtime · Persistent sessions.",
    skip: "Skip to content",
    navigation: "Main navigation",
    overview: "Overview",
    downloads: "Downloads",
    docs: "Docs",
    github: "GitHub",
    githubLabel: "AReaL-Harness on GitHub",
    language: "Language",
    enLabel: "Switch to English",
    zhLabel: "切换到中文",
    eyebrow: "Open source · Built with Rust",
    headline: "A modular framework for tool execution ",
    headlineAccent: "and multi-agent collaboration",
    intro: "Composable Core · Independent Runtime · Persistent sessions",
    introSecond: "On your desktop and in your terminal.",
    downloadPrimary: "Download AReaL-Harness",
    readDocs: "Read the docs",
    downloadHeading: "Choose your download",
    clientGroup: "Client",
    channelGroup: "Release channel",
    gui: "GUI client",
    tui: "TUI client",
    stable: "Stable",
    preview: "Preview",
    platformLabel: "Platform",
    platformNames: { "macos-arm64": "macOS · Apple Silicon", "linux-x64": "Linux · x86_64" },
    guiDescription: "Desktop application · ARM64",
    tuiDescription: "Complete terminal package + Runtime",
    guiRequirements: "macOS 15+ · Xcode Command Line Tools",
    tuiMacRequirements: "macOS · Apple Silicon / ARM64",
    tuiLinuxRequirements: "Linux x86_64 · glibc 2.35+",
    download: "Download",
    downloadCommand: "Download command",
    downloadUrl: "Direct download URL",
    downloadOnly: "Downloads the selected archive. See the installation guide for setup.",
    copy: "Copy",
    copied: "Copied",
    copying: "Copying…",
    copyFailed: "Could not copy. Select and copy the text manually.",
    unavailable: "Unavailable",
    notes: "Release notes",
    checksums: "SHA256 checksums",
    installer: "Installer script",
    installation: "Installation guide",
    allReleases: "All releases",
    previewWarning:
      "Preview releases are for early testing and may be unstable. macOS preview builds are not notarized.",
    notarized: "Stable GUI · Developer ID signed and Apple notarized",
    noRelease: "No release is available for this client and channel yet.",
    noPlatform:
      "The latest release has no complete package for this platform. Check the release notes for availability.",
    alsoAvailable: "Also available",
    tuiPlatforms: "TUI for macOS ARM64 and Linux x86_64",
    snapshot: "Release snapshot",
    actionEyebrow: "See it in action",
    actionTitle: "In your terminal",
    imageAlt: "AReaL-Harness TUI showing a conversation, a session plan and the message composer.",
    imageCaption: "Terminal TUI for interactive, long-running agent sessions.",
    fullScreenshot: "View full screenshot",
    capabilities: "Built for work that continues",
    feature1Title: "Multi-agent collaboration",
    feature1Body:
      "Split tasks across agents, coordinate their work, and collect results in one session.",
    feature2Title: "Persistent sessions",
    feature2Body:
      "Keep context, history, and state across long-running work. Pick up where you left off.",
    feature3Title: "Independent runtime",
    feature3Body:
      "A Rust Core with a separate tool runtime. Work in a desktop GUI or terminal TUI with a modular, open design.",
    footerText: "Open source under Apache-2.0.",
    limitations: "Capabilities & limitations",
    source: "Source",
  },
  zh: {
    title: "AReaL-Harness | 面向工具执行与多 Agent 协作的模块化框架",
    description:
      "面向工具执行与多 Agent 协作的模块化框架。可组合 Core · 独立 Runtime · 持久会话。",
    skip: "跳转到正文",
    navigation: "主导航",
    overview: "概览",
    downloads: "下载",
    docs: "文档",
    github: "GitHub",
    githubLabel: "在 GitHub 查看 AReaL-Harness",
    language: "语言",
    enLabel: "Switch to English",
    zhLabel: "切换到中文",
    eyebrow: "开源 · 使用 Rust 构建",
    headline: "面向工具执行与",
    headlineAccent: "多 Agent 协作的模块化框架",
    intro: "可组合 Core · 独立 Runtime · 持久会话",
    introSecond: "在桌面上，也在终端中。",
    downloadPrimary: "下载 AReaL-Harness",
    readDocs: "阅读文档",
    downloadHeading: "选择下载版本",
    clientGroup: "客户端",
    channelGroup: "发布渠道",
    gui: "图形客户端",
    tui: "终端客户端",
    stable: "稳定版",
    preview: "预览版",
    platformLabel: "运行平台",
    platformNames: { "macos-arm64": "macOS · Apple 芯片", "linux-x64": "Linux · x86_64" },
    guiDescription: "桌面应用 · ARM64",
    tuiDescription: "完整终端安装包 + Runtime",
    guiRequirements: "macOS 15+ · Xcode 命令行工具",
    tuiMacRequirements: "macOS · Apple 芯片 / ARM64",
    tuiLinuxRequirements: "Linux x86_64 · glibc 2.35+",
    download: "下载",
    downloadCommand: "下载命令",
    downloadUrl: "直接下载地址",
    downloadOnly: "下载所选归档包，后续步骤见安装指南。",
    copy: "复制",
    copied: "已复制",
    copying: "复制中…",
    copyFailed: "复制失败，请手动选中并复制文本。",
    unavailable: "暂不可用",
    notes: "发布说明",
    checksums: "SHA256 校验和",
    installer: "安装脚本",
    installation: "安装指南",
    allReleases: "所有版本",
    previewWarning: "预览版用于早期测试，可能不稳定。macOS 预览构建未经 Apple 公证。",
    notarized: "稳定版 GUI · Developer ID 签名并经 Apple 公证",
    noRelease: "此客户端和渠道暂未发布版本。",
    noPlatform: "最新版本暂未提供此平台的完整安装包。请在发布说明中查看可用情况。",
    alsoAvailable: "也可选择",
    tuiPlatforms: "适用于 macOS ARM64 与 Linux x86_64 的 TUI",
    snapshot: "版本快照",
    actionEyebrow: "看看实际运行",
    actionTitle: "在终端中工作",
    imageAlt: "AReaL-Harness TUI，展示对话、会话计划和消息输入区域。",
    imageCaption: "终端 TUI，支持交互式、长时间运行的智能体会话。",
    fullScreenshot: "查看完整截图",
    capabilities: "为持续推进的工作而构建",
    feature1Title: "多智能体协作",
    feature1Body: "将任务分配给多个智能体，协调各自的工作，并在同一会话中收集结果。",
    feature2Title: "持久化会话",
    feature2Body: "在长期任务中保留上下文、历史与状态。随时接续此前的工作。",
    feature3Title: "独立运行时",
    feature3Body: "Rust Core 搭配独立的工具运行时。通过桌面 GUI 或终端 TUI，使用模块化的开放架构。",
    footerText: "以 Apache-2.0 协议开源。",
    limitations: "能力与限制",
    source: "源码",
  },
};

export function resolveSelection(catalog, selection) {
  const release = catalog.clients[selection.client][selection.channel];
  if (release.status === "no-release") return { status: "no-release" };
  const asset = release.assets[selection.platform];
  if (!asset || !release.checksumUrl || (selection.client === "tui" && !release.installerUrl))
    return { status: "no-platform-package", release };
  return {
    status: "ready",
    release,
    asset,
    ...(selection.client === "tui"
      ? { downloadCommand: `curl -fL '${asset.url}' -o '${asset.name}'` }
      : {}),
  };
}

export function changeClient(selection, client) {
  return {
    ...selection,
    client,
    platform: platforms[client].includes(selection.platform)
      ? selection.platform
      : platforms[client][0],
  };
}

export function readSelection(search) {
  const query = new URLSearchParams(search);
  const client = query.get("client") === "tui" ? "tui" : "gui";
  return {
    client,
    channel: query.get("channel") === "preview" ? "preview" : "stable",
    platform: platforms[client].includes(query.get("platform"))
      ? query.get("platform")
      : platforms[client][0],
  };
}

export function readLocale(search, stored) {
  const requested = new URLSearchParams(search).get("lang");
  return ["en", "zh"].includes(requested)
    ? requested
    : ["en", "zh"].includes(stored)
      ? stored
      : "en";
}

export function localeUrl(current, locale) {
  const url = new URL(current);
  url.searchParams.set("lang", locale);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function docsUrl(locale, page = "docs/README") {
  return `${officialRepository}/blob/main/${page}${locale === "en" ? ".en" : ""}.md`;
}
