import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { runOAuth } from './oauth.js'
import { ProviderError, providerError } from './errors.js'

// 账号记录键由此适配器拥有；保留已有格式而不引入其他执行后端。
export const ACCOUNT_KEY = 'areal-chatgpt/subscription'
export function loginUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Untrusted ChatGPT login URL')
  }
  return url.href
}
function credential(record) {
  const value = record?.kind === 'grant' ? record.payload : undefined
  if (!value) return undefined
  if (value.type !== 'oauth' || typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh || !Number.isFinite(value.expires)) {
    throw new ProviderError('credential_invalid', { phase: 'storage' })
  }
  return value
}
function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) } catch { return {} }
}
export class ChatGPTAccount extends EventEmitter {
  constructor(store, { oauth = runOAuth, loginTimeoutMs = 10 * 60 * 1000 } = {}) {
    super()
    this.store = store
    this.oauth = oauth
    this.loginTimeoutMs = loginTimeoutMs
    this.revision = 0
    this.login = null
    this.error = null
    this.busy = false
    this.lifetime = new AbortController()
    this.active = new Set()
    this.models = async () => []
  }
  changed() { this.revision++; this.emit('changed') }
  check() { this.lifetime.signal.throwIfAborted() }
  track(promise) {
    this.active.add(promise)
    promise.then(() => this.active.delete(promise), () => this.active.delete(promise))
    return promise
  }
  async begin() {
    this.check()
    if (this.attempt) return this.attempt.ready
    if (this.busy) throw new Error('账号操作进行中，请稍后重试。')
    this.error = null
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const attempt = { controller, loginId: randomUUID() }
    attempt.ready = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject })
    this.attempt = attempt
    attempt.timer = setTimeout(() => {
      this.error = '登录已超时，请重试。'
      controller.abort(new Error('Login timed out'))
    }, this.loginTimeoutMs)
    attempt.timer.unref?.()
    attempt.done = this.track((async () => {
      try {
        const value = await this.oauth('login', { signal, onAuth: url => {
          signal.throwIfAborted()
          this.login = { loginId: attempt.loginId, authUrl: loginUrl(url) }
          attempt.resolve(this.login)
        } })
        signal.throwIfAborted()
        credential({ kind: 'grant', payload: value })
        await this.store.modifyRecord(ACCOUNT_KEY, async () => {
          signal.throwIfAborted()
          return { kind: 'grant', payload: value }
        })
        this.failure = null
        this.pendingRotation = null
        this.terminalFailure = null
        this.changed()
      } catch {
        if (!signal.aborted) this.error = 'ChatGPT 授权未完成或已失败，请重试。'
        attempt.reject(new Error(this.error || 'ChatGPT 登录已取消。'))
      } finally {
        clearTimeout(attempt.timer)
        if (this.attempt === attempt) { this.attempt = null; this.login = null }
        // Also settle a failed flow that never supplied an authorization URL.
        attempt.reject(new Error('ChatGPT 登录已结束。'))
      }
    })())
    return attempt.ready
  }
  async cancel() {
    const attempt = this.attempt
    attempt?.controller.abort(new Error('Login cancelled'))
    await attempt?.done
    this.error = null
  }
  async logout() {
    this.check()
    if (this.busy) throw new Error('账号操作进行中，请稍后重试。')
    this.busy = true
    this.changed()
    try {
      await this.cancel()
      await this.store.deleteRecord(ACCOUNT_KEY)
      this.error = null
      this.failure = null
      this.pendingRotation = null
      this.terminalFailure = null
    } finally { this.busy = false; this.changed() }
  }
  async read() {
    this.check()
    const value = credential(await this.store.readRecord(ACCOUNT_KEY))
    if (!value) return null
    const payload = claims(value.access)
    // JWT claims are display hints only; the provider validates the credential.
    return { type: 'chatgpt', email: payload.email ?? payload['https://api.openai.com/profile']?.email ?? null,
      planType: payload['https://api.openai.com/auth']?.chatgpt_plan_type ?? null }
  }
  fail(error, phase) {
    const failure = providerError(error, phase)
    if (failure.code !== 'cancelled' && failure.code !== 'account_changed') this.failure = failure
    return failure
  }
  async accessToken(signal, { force = false, rejectedToken } = {}) {
    this.check()
    signal?.throwIfAborted()
    if (this.busy) throw new ProviderError('account_changed', { phase: 'account' })
    const revision = this.revision
    // 同一 Host 只有该账户实例进入安全存储；共享 promise 包括失败，避免并发重复刷新。
    if (!this.refreshing) {
      this.refreshing = this.track(this.rotate({ force, rejectedToken }).finally(() => { this.refreshing = null }))
    }
    let abort
    const cancelled = signal && new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    let record
    try { record = await (cancelled ? Promise.race([this.refreshing, cancelled]) : this.refreshing) }
    finally { if (abort) signal.removeEventListener('abort', abort) }
    signal?.throwIfAborted()
    this.check()
    if (revision !== this.revision || this.busy) throw new ProviderError('account_changed', { phase: 'account' })
    if (record?.kind !== 'grant') throw this.failure ?? new ProviderError('credential_missing', { phase: 'account' })
    return credential(record).access
  }
  async rotate({ force, rejectedToken }) {
    try {
      const record = await this.store.modifyRecord(ACCOUNT_KEY, async current => {
        this.check()
        const value = credential(current)
        if (!value) throw new ProviderError('credential_missing', { phase: 'account' })
        if (this.pendingRotation) {
          if (this.pendingRotation.previousRefresh !== value.refresh) throw new ProviderError('account_changed', { phase: 'account' })
          return this.pendingRotation.record
        }
        if (value.expires > Date.now() + 60_000 && (!force || rejectedToken && rejectedToken !== value.access)) return undefined
        let next
        try { next = await this.oauth('refresh', { credential: value, signal: this.lifetime.signal }) }
        catch (error) {
          const failure = this.fail(error, 'refresh')
          if (failure.state !== 'reauth_required') throw failure
          // 终止错误仅清 token，保留注册、host 和经验证的账户映射用于重新授权。
          const { access, refresh, idToken, expires, ...registration } = value
          this.terminalFailure = failure
          this.pendingRotation = { previousRefresh: value.refresh, record: { kind: 'registration', payload: { ...registration, reauthRequired: true } } }
          return this.pendingRotation.record
        }
        credential({ kind: 'grant', payload: next })
        if (next.accountId !== value.accountId) throw new ProviderError('account_changed', { phase: 'refresh' })
        // 轮换结果保留到写入确认；原 Turn 取消不取消刷新及落盘。
        this.pendingRotation = { previousRefresh: value.refresh, record: { kind: 'grant', payload: next } }
        return this.pendingRotation.record
      })
      this.pendingRotation = null
      if (record?.kind === 'registration' && record.payload?.reauthRequired) this.failure = this.terminalFailure ?? new ProviderError('credential_missing', { phase: 'account' })
      else if (record?.kind === 'grant' && this.failure?.phase !== 'admission') this.failure = null
      return record
    } catch (error) { throw this.fail(error, this.pendingRotation ? 'storage' : error?.phase ?? 'storage') }
  }
  async status() {
    let account = null, models = [], modelError = null
    try { account = await this.read() }
    catch (error) { this.fail(error, 'storage') }
    if (account && !this.refreshing && this.failure?.state !== 'reauth_required') {
      try {
        models = await this.models()
        if (this.failure?.phase === 'catalog') this.failure = null
      }
      catch (error) { modelError = this.fail(error, error?.phase ?? 'catalog').message }
    }
    let state = this.failure?.state ?? (account ? 'ready' : 'signed_out')
    if (!account && !this.failure) {
      try { if ((await this.store.readRecord(ACCOUNT_KEY))?.payload?.reauthRequired) state = 'reauth_required' }
      catch (error) { state = this.fail(error, 'storage').state }
    }
    if (this.refreshing && state !== 'storage_locked') state = 'refreshing'
    return {
      authenticated: !!account, email: account?.email ?? null, planType: account?.planType ?? null,
      state, diagnostic: this.failure?.diagnostic() ?? null,
      login: this.login, error: this.error, modelError, models,
    }
  }
  async close() {
    if (this.lifetime.signal.aborted) return
    this.changed()
    this.lifetime.abort(new Error('ChatGPT provider closed'))
    await Promise.allSettled([...this.active])
  }
}
