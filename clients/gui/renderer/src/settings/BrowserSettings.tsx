import {
  SettingsGroupCard,
  SettingsSection,
  SettingsRow,
  SettingsSwitch,
  SettingsSelect,
} from "./SettingsPageParts.js";
import { useRef, useState } from "react";
import type { Action, Data } from "../services.js";

/** Only settings wired to the current native preview are editable. */
export function BrowserSettings({ settings = {}, action, connected = false }: { settings?: Data; action?: Action; connected?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  const save = async (key: string, value: string | boolean) => {
    if (!action || !connected || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action('library', { operation: 'settings', key, value }); }
    catch (cause) { setError((cause as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  const destination = (label: string, key: string, fallback: string) => <SettingsSelect aria-label={label}
    value={settings[key] ?? fallback} disabled={!action || !connected || busy} onValueChange={value => void save(key, value)}>
    <option value="internal">应用内</option><option value="external">默认浏览器</option>
  </SettingsSelect>;
  return (
    <div className="settings-sections">
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <SettingsSection title="常规">
      <SettingsGroupCard>
        <SettingsRow
          label="网页 URL 和链接打开位置"
          control={destination('网页 URL 和链接打开位置', 'browserLinkTarget', 'external')}
        />
        <SettingsRow
          label="本地 URL 打开位置"
          description="用于本地开发站点"
          control={destination('本地 URL 打开位置', 'browserLocalTarget', 'internal')}
        />
        <SettingsRow
          label="显示完整网址"
          description="在地址栏中显示路径、查询参数和片段"
          control={<SettingsSwitch aria-label="显示完整网址" checked={settings.browserFullAddress === true} disabled={!action || !connected || busy} onCheckedChange={value => void save('browserFullAddress', value)} />}
        />
      </SettingsGroupCard>
      </SettingsSection>
    </div>
  );
}
