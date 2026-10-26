// @ts-check
import { record } from "./subscription-contract.js";

const messages = {
  temporarily_unavailable: "ChatGPT 暂时不可用，请检查网络后重试；登录凭据已保留。",
  reauth_required: "ChatGPT 授权已终止，请重新登录。",
  permission_denied: "ChatGPT 权限或客户端配置不允许此操作，请检查授权和服务限制。",
  quota_exceeded: "ChatGPT 使用额度受限，请在 ChatGPT 设置中检查应用用量。",
  storage_locked: "系统安全存储不可用，请解锁后重试；不会因此退出登录。",
};
const terminal = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);
const known = new Set([
  ...terminal,
  "invalid_client",
  "invalid_token",
  "storage_locked",
  "storage_write_failed",
  "credential_missing",
  "credential_invalid",
  "account_changed",
  "cancelled",
  "network_error",
  "http_error",
  "invalid_response",
  "permission_missing",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
  "subscription_sharing_user_unavailable",
]);
export class ProviderError extends Error {
  /** @param {string} code @param {{phase?:string,httpStatus?:number|null,requestId?:string|null,state?:keyof typeof messages}} [options] */
  constructor(code, { phase = "transport", httpStatus = null, requestId = null, state } = {}) {
    code = known.has(code) ? code : "http_error";
    state ??=
      (phase === "refresh" && terminal.has(code)) ||
      code === "credential_missing" ||
      code === "credential_invalid"
        ? "reauth_required"
        : code === "storage_locked" || code === "storage_write_failed"
          ? "storage_locked"
          : httpStatus === 429
            ? "quota_exceeded"
            : httpStatus === 403 || code === "invalid_client" || code === "permission_missing"
              ? "permission_denied"
              : "temporarily_unavailable";
    super(messages[state]);
    this.code = code;
    this.state = state;
    this.phase = phase;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
  diagnostic() {
    return {
      code: this.code,
      state: this.state,
      phase: this.phase,
      httpStatus: this.httpStatus,
      requestId: this.requestId,
    };
  }
}
/** @param {unknown} error */
export function providerError(error, phase = "transport") {
  if (error instanceof ProviderError) return error;
  const value = record(error) ? error : {};
  return new ProviderError(
    value.name === "AbortError"
      ? "cancelled"
      : typeof value.code === "string" && known.has(value.code)
        ? value.code
        : phase === "storage"
          ? "storage_locked"
          : "network_error",
    { phase },
  );
}
// 只保留固定错误码与经过过滤的 request ID，不透传供应商消息或 token 响应。
/** @param {Response} response @param {string} phase @param {(string|null|undefined)[]} [secrets] */
export async function responseError(response, phase, secrets = []) {
  /** @type {unknown} */ let data = null;
  let size = 0;
  const chunks = [];
  try {
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 16384) break;
        chunks.push(chunk);
      }
    if (size <= 16384) data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
  } finally {
    await response.body?.cancel().catch(() => {});
  }
  const raw = record(data)
    ? typeof data.error === "string"
      ? data.error
      : record(data.error)
        ? data.error.code
        : undefined
    : undefined;
  const id = response.headers.get("x-request-id");
  const requestId =
    typeof id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
    !secrets.some((secret) => secret && id.includes(secret))
      ? id
      : null;
  const failure = new ProviderError(
    typeof raw === "string" && known.has(raw) ? raw : "http_error",
    {
      phase,
      httpStatus: response.status,
      requestId,
    },
  );
  return failure;
}
/** @param {ProviderError} error */
export function safeRefresh(error) {
  return (
    error.phase === "catalog" &&
    error.httpStatus === 401 &&
    ["invalid_token", "token_expired"].includes(error.code)
  );
}
