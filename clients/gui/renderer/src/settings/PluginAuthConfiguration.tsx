import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback } from "./common.js";
import type { Data } from "../services.js";

export function PluginAuthConfiguration({ pluginId, server, digest, disabled, command, onSaved }: {
  pluginId: string; server: Data; digest: string; disabled: boolean;
  command: (operation: string, values: Data) => Promise<Data>; onSaved: () => void;
}) {
  const requirements = server.config?.authenticationRequirements ?? {};
  const [clientSecret, setClientSecret] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [privateKeyId, setPrivateKeyId] = useState("");
  const [clientMetadataUrl, setClientMetadataUrl] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState<string>();
  const blocked = disabled || busy || !!pendingId;
  const save = async () => {
    if (blocked) return;
    const requestId = crypto.randomUUID();
    const credentials = {
      ...(clientSecret ? { clientSecret } : {}), ...(privateKeyPem ? { privateKeyPem } : {}), ...(apiKey ? { apiKey } : {}),
    };
    // Clear transient values before IPC; saved secrets are never read back into renderer state.
    setClientSecret(""); setPrivateKeyPem(""); setApiKey(""); setBusy(true); setError(""); setMessage("");
    try {
      await command("pluginAuthCredential", {
        id: pluginId, server: server.serverId, expectedDigest: digest, requestId, credentials,
        configuration: {
          ...(privateKeyId.trim() ? {privateKeyId: privateKeyId.trim()} : {}),
          ...(clientMetadataUrl.trim() ? {clientMetadataUrl: clientMetadataUrl.trim()} : {}),
          ...(callbackUrl.trim() ? {callbackUrl: callbackUrl.trim()} : {}),
        },
      });
      setMessage("认证配置已保存。启用认证后核对状态，再连接插件。"); onSaved();
    } catch (cause) {
      const failure = cause as {message?: string; submissionUnknown?: boolean};
      setError(failure.message ?? "认证配置未完成");
      if (failure.submissionUnknown) setPendingId(requestId);
    } finally { setBusy(false); }
  };
  const recover = async () => {
    if (!pendingId || busy) return;
    setBusy(true); setError("");
    try {
      const receipt = await command("pluginSubmission", {mutation:"pluginAuthConfigure",requestId:pendingId});
      if (!receipt.confirmed) {setMessage("结果仍待核对，请稍后查询。");return;}
      setPendingId(undefined);
      if (!receipt.accepted) setError(receipt.error?.message ?? "认证配置未被接受");
      else {setMessage("认证配置已确认保存。");onSaved();}
    } catch (cause) {setError((cause as Error).message);} finally {setBusy(false);}
  };
  return <details>
    <summary>认证配置</summary>
    <p>先断开插件。凭据通过系统安全存储保存，插件只收到认证所需的请求凭据。</p>
    {requirements.clientSecret && <label>OAuth 客户端秘密<Input type="password" autoComplete="new-password" value={clientSecret} disabled={blocked} onChange={event=>setClientSecret(event.target.value)} /></label>}
    {requirements.privateKey && <>
      <label>OAuth 签名私钥（PEM）<textarea autoComplete="off" value={privateKeyPem} disabled={blocked} onChange={event=>setPrivateKeyPem(event.target.value)} /></label>
      <label>签名密钥 ID<Input value={privateKeyId} disabled={blocked} onChange={event=>setPrivateKeyId(event.target.value)} /></label>
    </>}
    {requirements.apiKey && <label>{requirements.headerScheme === "basic" ? "API 凭据（用户名:密码）" : "API 凭据"}<Input type="password" autoComplete="new-password" value={apiKey} disabled={blocked} onChange={event=>setApiKey(event.target.value)} /></label>}
    {!requirements.apiKey && <>
      <label>CIMD 客户端元数据 URL（可选）<Input type="url" value={clientMetadataUrl} disabled={blocked} onChange={event=>setClientMetadataUrl(event.target.value)} placeholder="https://example.com/oauth/client.json" /></label>
      <label>已登记的 loopback 回调 URL（可选）<Input type="url" value={callbackUrl} disabled={blocked} onChange={event=>setCallbackUrl(event.target.value)} placeholder="http://127.0.0.1:PORT/callback" /></label>
    </>}
    <Feedback error={error} message={message} />
    <Button variant="outline" disabled={blocked || (requirements.clientSecret && !clientSecret) || (requirements.privateKey && !privateKeyPem) || (requirements.apiKey && !apiKey)} onClick={()=>void save()}>保存认证配置</Button>
    {pendingId && <Button variant="outline" disabled={busy} onClick={()=>void recover()}>核对认证配置提交</Button>}
  </details>;
}
