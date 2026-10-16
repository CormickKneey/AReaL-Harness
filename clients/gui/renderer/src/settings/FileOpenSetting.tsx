import { useEffect, useRef, useState } from "react";
import { SettingsRow, SettingsSelect } from "./SettingsPageParts.js";
import type { PlatformServices, FileOpenTargets } from "../services.js";

export function FileOpenSetting({ service, preferred, connected }: {
  service?: PlatformServices["fileOpen"]; preferred?: string; connected: boolean;
}) {
  const [catalog, setCatalog] = useState<FileOpenTargets>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), saving = useRef(false);
  useEffect(() => {
    let current = true;
    if (service) void service({ operation: "targets" }).then(value => { if (current) { setCatalog(value as FileOpenTargets); setError(""); } }).catch(cause => { if (current) setError(cause.message); });
    return () => { current = false; };
  }, [service, preferred, connected]);
  const save = async (target: string) => {
    if (!service || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try { await service({ operation: "setDefault", target }); }
    catch (cause) { setError((cause as Error).message); }
    finally { saving.current = false; setBusy(false); }
  };
  return <SettingsRow label="默认文件打开位置"
    detail={error && <span role="alert" className="text-destructive">{error}</span>}
    control={catalog ? <SettingsSelect aria-label="默认文件打开位置" value={catalog.preferred} disabled={!service || !connected || busy}
      onValueChange={target => void save(target)}>{catalog.targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}</SettingsSelect>
      : <span className="text-foreground-subtle">读取中…</span>} />;
}
