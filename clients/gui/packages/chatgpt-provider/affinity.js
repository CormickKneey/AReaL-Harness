// 路由状态只属于同账号、模型和 Turn，不进入提示词、历史或持久存储。
export class ResponseAffinity {
  constructor({ now = Date.now, maxEntries = 128, idleMs = 30 * 60_000 } = {}) {
    this.now = now
    this.maxEntries = maxEntries
    this.idleMs = idleMs
    this.entries = new Map()
  }
  clear() { this.entries.clear() }
  begin(headers, model, accountScope) {
    const get = key => headers?.get ? headers.get(key) : headers?.[key]
    const thread = get('x-areal-thread-id'), turn = get('x-areal-turn-id')
    const purpose = get('x-areal-model-purpose') ?? 'solve'
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    if (!valid(thread) || !valid(turn) || !['solve', 'summary', 'permissionReview'].includes(purpose)) return null
    const time = this.now(), key = JSON.stringify([accountScope, model, thread, turn, purpose])
    for (const [id, entry] of this.entries) if (time - entry.touched >= this.idleMs) this.entries.delete(id)
    const entry = this.entries.get(key) ?? { state: null }
    entry.touched = time
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value)
    return {
      headers: { 'session-id': thread, 'thread-id': thread, ...(entry.state ? { 'x-codex-turn-state': entry.state } : {}) },
      capture: response => {
        // 旧账号或被回收请求的迟到响应不得恢复状态；同 Turn 只接受第一个值。
        if (!response.ok || this.entries.get(key) !== entry || entry.state !== null) return
        const value = response.headers.get('x-codex-turn-state')
        if (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 8192 && !/[\r\n\0]/.test(value)) entry.state = value
      },
    }
  }
}
