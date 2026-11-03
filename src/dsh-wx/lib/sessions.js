/**
 * sessions.js —— 多会话并行的「谁处理哪个群」
 *
 * 微信只有一个窗口、一只手，所以 GUI 仍然单写者；能并行的是**模型侧**：
 * 一个群一个宿主会话，各自领自己的任务，互不堵住对方的思考时间。
 *
 * 约束：
 *   - 主会话（~/.dsh-wx/session.json 里那条）始终保留，处理第一个群；
 *   - 其余群按 chatId 分配 worker，最多 maxSessions - 1 个；
 *   - 超过上限就回落到主会话排队，不丢任务；
 *   - 映射只追加/覆盖，落盘 0600；坏了当没有，下次重新分配。
 *
 * 这里不创建会话、不投递；只记「chatId ↔ sessionId」。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SESSIONS_VERSION = 1
export const DEFAULT_SESSIONS_FILE = '/home/str1k3/.dsh-wx/sessions.json'
export const DEFAULT_MAX_SESSIONS = 2

const str = (v) => String(v ?? '').trim()
const timeOf = (v) => {
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : 0
}

const empty = () => ({ v: SESSIONS_VERSION, mainChatId: '', mainChatName: '', mainSessionId: '', workers: {} })

/**
 * @param {object} [opts]
 * @param {string} [opts.file]
 * @param {number} [opts.maxSessions] 含主会话；最小 1，默认 2
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createSessionPool({
  file = DEFAULT_SESSIONS_FILE, maxSessions = DEFAULT_MAX_SESSIONS, now = Date.now, log,
} = {}) {
  const limit = Math.max(1, Math.floor(Number(maxSessions) || DEFAULT_MAX_SESSIONS))
  let data = load()

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const workers = {}
      for (const [chatId, w] of Object.entries(raw?.workers ?? {})) {
        if (!w || !str(w.sessionId)) continue
        workers[str(chatId)] = {
          sessionId: str(w.sessionId),
          chatName: str(w.chatName),
          lastAt: str(w.lastAt) || new Date(0).toISOString(),
        }
      }
      return {
        v: SESSIONS_VERSION,
        mainChatId: str(raw?.mainChatId),
        mainChatName: str(raw?.mainChatName),
        mainSessionId: str(raw?.mainSessionId),
        workers,
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') log?.('会话池读不出来，按空池处理：' + String(err?.message ?? err).slice(0, 120))
      return empty()
    }
  }

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      return { ok: true }
    } catch (err) {
      log?.('会话池写不进去：' + String(err?.message ?? err).slice(0, 160))
      return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
    }
  }

  const maxWorkers = Math.max(0, limit - 1)

  function sessionFor(chatId) {
    const id = str(chatId)
    if (!id) return ''
    if (data.mainChatId === id && data.mainSessionId) return data.mainSessionId
    return str(data.workers[id]?.sessionId)
  }

  function chatOf(sessionId) {
    const sid = str(sessionId)
    if (!sid) return ''
    if (data.mainSessionId && sid === data.mainSessionId) return data.mainChatId
    const hit = Object.entries(data.workers).find(([, w]) => w.sessionId === sid)
    return hit ? hit[0] : ''
  }

  /** 主会话认领第一个群。已经认领过别的群就不换（一个会话同时只代表一个群）。 */
  function assignMain(chatId, sessionId, chatName = '') {
    const id = str(chatId)
    const sid = str(sessionId)
    if (!id || !sid) return { ok: false, why: 'chatId / sessionId 为空' }
    data.mainChatId = id
    data.mainChatName = str(chatName) || data.mainChatName
    data.mainSessionId = sid
    save()
    return { ok: true, chatId: id, sessionId: sid, main: true }
  }

  /** 给一个群分配 worker；超过上限返回空，由调用方回落主会话。 */
  function assign(chatId, sessionId, chatName = '') {
    const id = str(chatId)
    const sid = str(sessionId)
    if (!id || !sid) return { ok: false, why: 'chatId / sessionId 为空' }
    if (data.workers[id]) {
      data.workers[id] = { sessionId: sid, chatName: str(chatName) || data.workers[id].chatName, lastAt: new Date(now()).toISOString() }
      save()
      return { ok: true, chatId: id, sessionId: sid, reused: true }
    }
    if (Object.keys(data.workers).length >= maxWorkers) return { ok: false, why: 'worker 已满', full: true }
    data.workers[id] = { sessionId: sid, chatName: str(chatName), lastAt: new Date(now()).toISOString() }
    save()
    return { ok: true, chatId: id, sessionId: sid, created: true }
  }

  function touch(chatId) {
    const id = str(chatId)
    const w = data.workers[id]
    if (!w) return
    w.lastAt = new Date(now()).toISOString()
    save()
  }

  function remove(chatId) {
    const id = str(chatId)
    if (data.workers[id]) {
      delete data.workers[id]
      save()
      return { ok: true }
    }
    return { ok: false, why: '没有这个群的 worker' }
  }

  function sessionIds() {
    return [...new Set([data.mainSessionId, ...Object.values(data.workers).map((w) => w.sessionId)].filter(Boolean))]
  }

  function list() {
    return Object.entries(data.workers).map(([chatId, w]) => ({ chatId, ...w }))
  }

  function stats() {
    return {
      maxSessions: limit,
      mainChatId: data.mainChatId,
      mainChatName: data.mainChatName,
      mainSessionId: data.mainSessionId,
      workers: Object.keys(data.workers).length,
      sessions: sessionIds().length,
    }
  }

  /** 只清映射，不删宿主会话；下次重新分配。 */
  function reset() {
    data = empty()
    save()
  }

  return {
    file, limit, sessionFor, chatOf, assignMain, assign, touch, remove,
    sessionIds, list, stats, reset, save,
  }
}
