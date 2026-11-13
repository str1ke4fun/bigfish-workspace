/**
 * context-service.js —— `fishCore.context`：易失上下文 provider 注册表
 *
 * 屏幕陪伴把“他此刻在做什么”发布成一个内存 provider；`fish:owner` 渲染时
 * 按 section / surface / TTL 取。约束：
 *   - 纯内存，不写盘、不写事件；
 *   - get() 同步、永不抛；抛错只跳过该 provider；
 *   - at 统一用 epoch 毫秒（ISO 也接受，内部 Date.parse）；
 *   - 总长 400 字，按 order 排序，超预算截后面的。
 */

const MAX_CHARS = 400

export function createContextService({ now = Date.now } = {}) {
  const providers = new Map()

  function provide(id, { order = 0, surfaces = ['web', 'wx'], ttlMs = 120_000, get, section = 'owner' } = {}) {
    const key = String(id ?? '')
    if (!key || typeof get !== 'function') return () => {}
    if (!Array.isArray(surfaces) || surfaces.length === 0) return () => {}
    const entry = { id: key, order: Number(order) || 0, surfaces: [...surfaces], ttlMs: Number(ttlMs) || 0, get, section: String(section || 'owner') }
    providers.set(key, entry)
    return () => { if (providers.get(key) === entry) providers.delete(key) }
  }

  function remove(id) {
    providers.delete(String(id ?? ''))
  }

  function render({ agent, surface = '', section = 'owner', now: at = now() } = {}) {
    const parts = []
    const sorted = [...providers.values()].sort((a, b) => a.order - b.order)
    for (const p of sorted) {
      if (p.section !== section) continue
      if (!p.surfaces.includes(surface)) continue
      let value = null
      try { value = p.get({ agent, surface }) } catch { continue }
      if (!value || !value.text) continue
      const t = typeof value.at === 'number' ? value.at : Date.parse(String(value.at ?? ''))
      if (!Number.isFinite(t)) continue
      if (p.ttlMs > 0 && at - t >= p.ttlMs) continue
      parts.push(String(value.text))
    }
    return parts.join('\n\n').slice(0, MAX_CHARS)
  }

  return { provide, remove, render }
}
