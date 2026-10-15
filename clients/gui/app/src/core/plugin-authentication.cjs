"use strict";
// Values stay inside the existing encrypted credential owner and trusted launch inputs.
const fields = ["clientSecretRef","privateKeyRef","privateKeyId","clientMetadataUrl","apiKeyRef","callbackUrl"];
async function configurePluginAuthentication(backend, project, request) {
  if (backend.providerUpdating || backend.resourcesUpdating || backend.starting.size || backend.hasWork()) throw Error("请等待任务和操作完成后保存认证配置");
  const current = await project.client.request("areal/plugin/mcp/list", {});
  const row = current.data?.find(item => item.pluginId === request.id);
  if (!row || row.installedDigest !== request.expectedDigest || !row.servers?.some(server => server.serverId === request.server)) throw Error("插件服务器或已安装摘要已变化");
  if (row.state === "connected" || row.state === "partial") throw Error("请先断开插件，再更改认证配置");
  const configuration = Object.fromEntries(fields.filter(key => request.configuration?.[key] !== undefined).map(key => [key,request.configuration[key]]));
  const values = request.credentials ?? {};
  if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).some(key => !["clientSecret","privateKeyPem","apiKey"].includes(key))) throw Error("认证凭据字段无效");
  backend.providerUpdating = true;
  try {
    let changed = false;
    for (const [field,ref,privateKey] of [["clientSecret","clientSecretRef",false],["privateKeyPem","privateKeyRef",true],["apiKey","apiKeyRef",false]]) {
      if (values[field] === undefined || values[field] === "") continue;
      const reference = await backend.providers.config.credential(values[field], {privateKey});
      configuration[ref] = reference.replace(/^AREAL_CREDENTIAL_/, "");
      changed = true;
    }
    if (changed) {
      const drained = await project.client.request("areal/server/drain", {strategy:"ifIdle",timeoutMs:30000},{timeoutMs:35000});
      if (!drained.restartSafe) throw Error("后台尚未结算，请等待后重试");
      await backend.restartProject(project);
    }
    return await backend.submit(project,"areal/plugin/auth/configure",{id:request.id,server:request.server,expectedDigest:request.expectedDigest,configuration},{requestId:request.requestId});
  } finally { backend.providerUpdating = false; backend.onChange(); }
}
module.exports = {configurePluginAuthentication};
