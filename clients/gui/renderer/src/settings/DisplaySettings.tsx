import { ActionButton } from "../components/ui/action-button.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Input } from "../components/ui/input.js";
import { CODE_PREVIEW_THEME_OPTIONS } from "../lib/codePreviewPreferences.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./SettingsPageParts.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { useCodePreferences, setCodePreferences } from "./preferences.js";
import {
  useApplicationPreferences,
  setApplicationPreferences,
} from "./applicationPreferences.js";
import {
  DEFAULT_PALETTES,
  UI_FONTS,
  CODE_FONTS,
  validColor,
  type Palette,
} from "./applicationSettings.js";
import { ThemeSharing } from "./ThemeSharing.js";
import { getResolvedOrResolveTheme } from "@pierre/diffs";
import "../lib/diffsHighlighterEngine.js";
import { NotificationSettings } from "./NotificationSettings.js";
import { MenuBarSetting } from "./MenuBarSetting.js";
import { ProjectlessDirectorySetting } from "./ProjectlessDirectorySetting.js";
import { FileOpenSetting } from "./FileOpenSetting.js";
import type { Action, Data, Snapshot, PlatformServices } from "../services.js";
import type { CodePreviewTheme } from "@/lib/codePreviewSettings.js";

const THEME_DIFF = {
  remove: [
    "const themePreview: ThemeConfig = {",
    '  surface: "sidebar",',
    '  accent: "#2563eb",',
    "  contrast: 42,",
    "};",
  ],
  add: [
    "const themePreview: ThemeConfig = {",
    '  surface: "sidebar-elevated",',
    '  accent: "#0ea5e9",',
    "  contrast: 68,",
    "};",
  ],
} as const;

function highlightThemeLine(line: string) {
  return line.split(/(\bconst\b|"[^"]*"|\b\d+\b|[A-Za-z_]\w*|[{}:=,])/g).filter(Boolean).map((part, index) => {
    const kind = part === "const" ? "keyword"
      : part === "ThemeConfig" ? "type"
      : part === "=" ? "operator"
      : part.startsWith('"') ? "string"
      : /^\d+$/.test(part) ? "number"
      : /^[A-Za-z_]/.test(part) ? "ident"
      : "punct";
    return <span key={`${part}-${index}`} className={`tok-${kind}`}>{part}</span>;
  });
}

function ThemeDiffPreview() {
  const { diffMarkers } = useApplicationPreferences();
  return (
    <div className="theme-diff" data-diff-markers={diffMarkers} aria-hidden="true">
      {(["remove", "add"] as const).map((tone) => (
        <div key={tone} className={`theme-diff-pane theme-diff-${tone}`}>
          <div className="theme-diff-gutter">
            {THEME_DIFF[tone].map((_, index) => (
              <span key={index} data-changed={index > 0 && index < 4 ? "true" : undefined}>
                {index + 1}
                {diffMarkers === "signs" && index > 0 && index < 4 && <span className="theme-diff-marker">{tone === "add" ? "+" : "−"}</span>}
              </span>
            ))}
          </div>
          <div className="theme-diff-code">
            {THEME_DIFF[tone].map((line, index) => (
              <span key={line} className="theme-diff-line" data-changed={index > 0 && index < 4 ? "true" : undefined}>
                {highlightThemeLine(line)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Derived decoration only; late theme loads cannot replace a newer selection. */
function CodeThemeSample({ theme }: { theme: CodePreviewTheme }) {
  const [sample, setSample] = useState<{ theme: CodePreviewTheme; style?: CSSProperties }>();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const resolved = await getResolvedOrResolveTheme(theme);
        if (active) setSample({ theme, style: { backgroundColor: resolved.bg, color: resolved.fg, borderColor: `color-mix(in srgb, ${resolved.fg} 16%, transparent)` } });
      } catch {
        if (active) setSample({ theme });
      }
    };
    void load();
    return () => { active = false; };
  }, [theme]);
  const current = sample?.theme === theme ? sample : undefined;
  return <span className="appearance-aa" aria-hidden="true"
    data-code-theme={current?.style ? theme : undefined}
    style={current?.style} title={current && !current.style ? "预览暂不可用" : undefined}>Aa</span>;
}

export function GeneralSettings({ settings = {}, power, menuBar, projectlessDirectory, chooseProjectlessDirectory, fileOpen, action, connected = false }: { settings?: Data; power?: Snapshot["power"]; menuBar?: Snapshot["menuBar"]; projectlessDirectory?: string; chooseProjectlessDirectory?: PlatformServices["chooseProjectlessDirectory"]; fileOpen?: PlatformServices["fileOpen"]; action?: Action; connected?: boolean }) {
  const prefs = useApplicationPreferences();
  const [powerSaving, setPowerSaving] = useState(false), [powerError, setPowerError] = useState("");
  const powerSavePending = useRef(false);
  const savePower = async (value: boolean) => {
    if (!connected || !action || powerSavePending.current) return;
    powerSavePending.current = true; setPowerSaving(true); setPowerError("");
    try { await action("library", { operation: "settings", key: "preventSleep", value }); }
    catch (error) { setPowerError(error instanceof Error ? error.message : "休眠设置保存失败"); }
    finally { powerSavePending.current = false; setPowerSaving(false); }
  };
  return (
    <div className="settings-sections">
      <SettingsSection title="文件与打开">
        <SettingsGroupCard>
          <ProjectlessDirectorySetting directory={projectlessDirectory} choose={chooseProjectlessDirectory} connected={connected} />
          <FileOpenSetting service={fileOpen} preferred={settings.fileOpenTarget} connected={connected} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title="窗口与终端">
        <SettingsGroupCard>
          <MenuBarSetting enabled={settings.showInMenuBar !== false} state={menuBar} action={action} connected={connected} />
          <SettingsRow
            label="底部面板"
            description="在应用标题栏中显示底部面板控件"
            control={<SettingsSwitch aria-label="底部面板" checked={prefs.showBottomPanelControl} onCheckedChange={(showBottomPanelControl) => setApplicationPreferences({ showBottomPanelControl })} />}
          />
          <SettingsRow
            label="默认终端位置"
            description="新终端标签页的默认位置"
            control={<SettingsSegmentedTabs ariaLabel="默认终端位置" value={prefs.terminalLocation}
              items={[{ label: "底部", value: "bottom" }, { label: "右侧", value: "right" }]}
              onValueChange={(terminalLocation) => setApplicationPreferences({ terminalLocation })} />}
          />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title="电源">
        <SettingsGroupCard>
          <SettingsRow
            label="运行时防止系统休眠"
            description="任务运行时保持唤醒；仍可手动睡眠或合盖。"
            control={<SettingsSwitch aria-label="运行时防止系统休眠" checked={settings.preventSleep !== false}
              disabled={!connected || !action || powerSaving} onCheckedChange={value => void savePower(value)} />}
          />
          {(powerError || power?.error) && <p role="alert" className="px-4 py-2 text-destructive">{powerError || power?.error}</p>}
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title="编辑器">
        <SettingsGroupCard>
          <SettingsRow
            label="发送快捷键"
            description="Shift+Enter 始终换行。"
            control={
              <SettingsSelect aria-label="发送快捷键" value={prefs.sendShortcut} onValueChange={selectedValue => setApplicationPreferences({
                    sendShortcut: selectedValue as "enter" | "modifier",
                  })}>
                <option value="enter">Enter 发送</option>
                <option value="modifier">⌘/Ctrl+Enter 发送</option>
              </SettingsSelect>
            }
          />
          <SettingsRow
            label="跟进处理方式"
            description="运行中发送新消息的方式；⌘/Ctrl+点击可临时反转。"
            control={
              <SettingsSegmentedTabs
                ariaLabel="跟进处理方式"
                items={[
                  { label: "加入队列", value: "queue" },
                  { label: "调整方向", value: "steer" },
                ]}
                value={prefs.followUp}
                onValueChange={(val) =>
                  setApplicationPreferences({
                    followUp: val as "queue" | "steer",
                  })
                }
              />
            }
          />
        </SettingsGroupCard>
      </SettingsSection>
      <NotificationSettings settings={settings} action={action} connected={connected} />
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="theme-color-field">
      <input
        type="color"
        aria-label={`${label}色板`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        aria-label={label}
        value={draft}
        maxLength={7}
        aria-invalid={!validColor(draft)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (validColor(e.target.value)) onChange(e.target.value);
        }}
      />
      <span className="sr-only" role="status">
        {!validColor(draft)
          ? "请输入六位十六进制颜色；当前仍使用上一次有效颜色。"
          : ""}
      </span>
    </div>
  );
}

export function AppearanceSettings({
  theme,
  setTheme,
  fontSize,
  setFontSize,
}: {
  theme: string;
  setTheme: (value: string) => void;
  fontSize: number;
  setFontSize: (value: number) => void;
}) {
  const prefs = useApplicationPreferences(),
    code = useCodePreferences();
  const fontSelect = (
    mode: "light" | "dark",
    name: "uiFont" | "contentFont" | "codeFont",
    label: string,
  ) => (
    <SettingsSelect aria-label={label} value={prefs[mode].fonts[name]} onValueChange={selectedValue => setApplicationPreferences({ [mode]: { ...prefs[mode], fonts: { ...prefs[mode].fonts, [name]: selectedValue } } })}>
      {name === "contentFont" && <option value="inherit">与界面字体相同</option>}
      {Object.keys(name === "codeFont" ? CODE_FONTS : UI_FONTS).map((font) => (
        <option key={font} value={font}>
          {(
            {
              system: "系统默认",
              PingFang: "苹方",
              Courier: "Courier New",
            } as Record<string, string>
          )[font] ?? font}
        </option>
      ))}
    </SettingsSelect>
  );
  const sizeInput = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (n: number) => void,
  ) => (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        value={value}
        className="w-16 text-center"
        onChange={(e) => {
          const n = Number(e.target.value);
          if (n >= min && n <= max) onChange(n);
        }}
      />
      <span className="text-ui-sm text-foreground-subtle">px</span>
    </div>
  );
  const codeTheme = (mode: "light" | "dark") => (
    <SettingsSelect aria-label={`${mode === "light" ? "浅色" : "深色"}代码主题`} value={code[`${mode}Theme`]} onValueChange={selectedValue => setCodePreferences({
          [`${mode}Theme`]: selectedValue as CodePreviewTheme,
        })}>
      {CODE_PREVIEW_THEME_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SettingsSelect>
  );
  // Palette editing is independent of the active application appearance.
  const activeMode = theme === "data-dense" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  const [mode, setMode] = useState<"light" | "dark">(activeMode);
  const palette = prefs[mode];
  const label = mode === "light" ? "浅色" : "深色";
  const update = (patch: Partial<Palette>) => setApplicationPreferences({ [mode]: { ...palette, ...patch } });
  return (
    <div className="settings-sections">
      <SettingsSection title="界面">
        <SettingsGroupCard>
          <SettingsRow label="界面主题" control={
            <SettingsSelect aria-label="界面主题" value={theme} onValueChange={value => {
              setTheme(value); if (value !== "system") setMode(value === "data-dense" ? "dark" : "light");
            }}>
              <option value="system">跟随系统</option><option value="soft-glass">浅色</option><option value="data-dense">深色</option>
            </SettingsSelect>
          } />
          <SettingsRow label="界面字体" control={fontSelect(activeMode, "uiFont", "界面字体")} />
          <SettingsRow label="界面字号" description="调整导航、设置和控件的基础字号" control={sizeInput("界面字号", fontSize, 12, 18, setFontSize)} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title="交互与动效">
        <SettingsGroupCard>
          <SettingsRow label="减少动态效果" description="减少动画效果，或跟随系统偏好" control={
            <SettingsSelect aria-label="减少动态效果" value={prefs.reducedMotion}
              onValueChange={reducedMotion => setApplicationPreferences({ reducedMotion: reducedMotion as "system" | "on" | "off" })}>
              <option value="system">跟随系统</option><option value="on">开启</option><option value="off">关闭</option>
            </SettingsSelect>
          } />
          <SettingsRow label="使用指针光标" description="悬停交互元素时切换为指针光标" control={<SettingsSwitch aria-label="使用指针光标" checked={prefs.pointerCursor} onCheckedChange={pointerCursor => setApplicationPreferences({ pointerCursor })} />} />
          <SettingsRow label="字体平滑" description="使用 macOS 原生字体抗锯齿" control={<SettingsSwitch aria-label="字体平滑" checked={prefs.fontSmoothing} onCheckedChange={fontSmoothing => setApplicationPreferences({ fontSmoothing })} />} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection>
        <SettingsDisclosure title="阅读与代码">
          <div className="appearance-theme-content">
            <SettingsGroupCard>
              <SettingsRow label="内容字体" control={fontSelect(activeMode, "contentFont", "内容字体")} />
              <SettingsRow label="内容字体大小" description="调整正文使用的基础字号" control={sizeInput("内容字号", prefs.contentSize, 12, 24, n => setApplicationPreferences({ contentSize: n }))} />
              <SettingsRow label="代码字体" control={fontSelect(activeMode, "codeFont", "代码字体")} />
              <SettingsRow label="代码字体大小" description="聊天和差异视图中的代码字号" control={sizeInput("代码字号", code.fontSizePx, 10, 24, n => setCodePreferences({ fontSizePx: n }))} />
              <SettingsRow label="显示行号" control={<SettingsSwitch aria-label="显示行号" checked={code.showLineNumbers} onCheckedChange={showLineNumbers => setCodePreferences({ showLineNumbers })} />} />
              <SettingsRow label="长行自动换行" description="超出宽度的代码行软换行显示" control={<SettingsSwitch aria-label="长行自动换行" checked={code.wrapLongLines} onCheckedChange={wrapLongLines => setCodePreferences({ wrapLongLines })} />} />
              <SettingsRow label="差异标记" description="使用颜色或 +/− 标记显示更改" control={
                <SettingsSegmentedTabs ariaLabel="差异标记" value={prefs.diffMarkers} items={[{ label: "颜色", value: "color" }, { label: "+/-", value: "signs" }]}
                  onValueChange={diffMarkers => setApplicationPreferences({ diffMarkers })} />
              } />
            </SettingsGroupCard>
            <ThemeDiffPreview />
          </div>
        </SettingsDisclosure>
      </SettingsSection>
      <SettingsSection>
        <SettingsDisclosure title="配色微调">
          <div className="appearance-theme-content">
            <div className="settings-section-action">
              <SettingsSegmentedTabs ariaLabel="编辑配色" value={mode} onValueChange={setMode}
                items={[{ label: "浅色配色", value: "light" }, { label: "深色配色", value: "dark" }]} />
              <ThemeSharing mode={mode} />
              <ActionButton aria-label={`恢复${label}默认`} onClick={() => setApplicationPreferences({ [mode]: DEFAULT_PALETTES[mode] })}>{`重置${label}配色`}</ActionButton>
            </div>
            <SettingsGroupCard density="compact">
              <SettingsRow label="代码主题" control={<div className="appearance-theme-tools"><CodeThemeSample theme={code[`${mode}Theme`]} />{codeTheme(mode)}</div>} />
              <SettingsRow label="界面字体" control={fontSelect(mode, "uiFont", `${label}界面字体`)} />
              <SettingsRow label="内容字体" control={fontSelect(mode, "contentFont", `${label}内容字体`)} />
              <SettingsRow label="代码字体" control={fontSelect(mode, "codeFont", `${label}代码字体`)} />
              <SettingsRow label="强调色" control={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <ColorField label={`${label}强调色`} value={palette.accent} onChange={accent => update({ accent })} />
                  <ActionButton disabled={palette.accent.toLowerCase() === DEFAULT_PALETTES[mode].accent} onClick={() => update({ accent: DEFAULT_PALETTES[mode].accent })}>重置</ActionButton>
                </div>
              } />
              <SettingsRow label="背景" control={<ColorField label={`${label}背景颜色`} value={palette.background} onChange={background => update({ background })} />} />
              <SettingsRow label="前景" control={<ColorField label={`${label}墨迹颜色`} value={palette.foreground} onChange={foreground => update({ foreground })} />} />
              <SettingsRow label="半透明侧边栏" control={<SettingsSwitch aria-label={`${label}半透明侧边栏`} checked={palette.translucentSidebar} onCheckedChange={translucentSidebar => update({ translucentSidebar })} />} />
              <SettingsRow label="对比度" control={
                <div className="flex items-center gap-3"><input aria-label={`${label}对比度`} type="range" min="0" max="100" value={palette.contrast} onChange={e => update({ contrast: Number(e.target.value) })} /><output>{palette.contrast}</output></div>
              } />
            </SettingsGroupCard>
          </div>
        </SettingsDisclosure>
      </SettingsSection>
    </div>
  );
}
