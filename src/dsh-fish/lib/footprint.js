// 已软删除（2026-11-12）：B 站实现以 src/dsh-bili/lib/ 为准，dsh-fish 运行时不再
// 引用本文件；保留仅为回滚与对照。新增代码不要 import 这里。
/**
 * footprint.js —— 她在 B 站留下的两串足迹（只读）
 *
 * 2026-11-03（用户要求）：工作台里要能看见「她看过哪些视频」和「她在评论区说过什么」。
 *
 * 为什么单独一个模块、而不是继续用 history.js：
 *   history.js 只认 `browse:<日期> [...]` 那一种记账，回答的是「某一轮刷到了什么」。
 *   但她的足迹其实散在四类事件里：
 *     - `browse:`  —— 定时刷站，带标题/UP/时长/播放量
 *     - `saw:`     —— 后台刷站之后留下的记忆（0.6.1 起）
 *     - `looked:`  —— 她自己点开看过（只有 BV 号）
 *     - `watched:` —— 她真的抽帧看了画面
 *   评论则是 `comment:` / `creply:`，正文从 0.6.2 起另记在 `cbody:`。
 *   这里只做合并与格式化，不写盘、不联网——现取评论正文由 observe 的另一个路由负责。
 *
 * 三条边界：
 *   1. 只读。这里没有删除、没有改写，事件流仍是唯一可信源。
 *   2. 看过 ≠ 认同。这个列表只说明「见过」，不进判断。
 *   3. 老记录缺标题就显示 BV 号——用户明确说过「有 BV 号也可以」。
 */

import { videoUrl } from './history.js'

const BV_RE = /^BV[0-9A-Za-z]{10}$/
const DAY_MS = 86_400_000

/** 某条评论在 B 站的原地址（能点开、能对上 rpid）。 */
export function commentUrl(bvid, rpid) {
  const b = String(bvid ?? '').trim()
  const n = Number(rpid) || 0
  if (!BV_RE.test(b) || !n) return ''
  return `https://www.bilibili.com/video/${b}#reply${n}`
}

function validBvid(v) {
  const s = String(v ?? '').trim()
  return BV_RE.test(s) ? s : ''
}

function bvidIn(text) {
  const m = /BV[0-9A-Za-z]{10}/.exec(String(text ?? ''))
  return m ? m[0] : ''
}

/**
 * 从 `saw:` 的 200 字摘要里把标题、UP、时长、标签、简介抠回来。
 *
 * 摘要本来就是给人看的、可能被截断（结尾有「…」），所以这里是**尽力而为**：
 * 抠不到的部分留空，绝不因为格式变化把整条视频弄丢。
 */
export function parseSaw(text) {
  const raw = String(text ?? '')
  const title = (/《([^》]+)》/.exec(raw)?.[1] ?? '').trim()
  const up = (/UP：([^｜]+)/.exec(raw)?.[1] ?? '').trim()
  const tagsRaw = (/标签：([^｜]+)/.exec(raw)?.[1] ?? '').trim()
  const desc = (/简介：([^｜]+)/.exec(raw)?.[1] ?? '').trim()
  const dm = /(\d+)分(\d+)秒/.exec(raw)
  return {
    title,
    up,
    tags: tagsRaw ? tagsRaw.split('/').map((s) => s.trim()).filter(Boolean) : [],
    desc,
    duration: dm ? Number(dm[1]) * 60 + Number(dm[2]) : 0,
  }
}

function timeOf(e) {
  const t = Date.parse(String(e?.ts ?? ''))
  return Number.isFinite(t) ? t : 0
}

function clampDays(v, fallback = 365) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(1, Math.min(3650, n)) : fallback
}

function clampLimit(v, fallback = 500) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : fallback
}

/**
 * 她看过什么：把四类记账合到一条视频一行，按最近一次出现倒序。
 *
 * @param {Array} events 事件流
 * @param {{days?:number, limit?:number, now?:number}} opts
 * @returns {{total:number, rows:Array}} total = 去重后的视频数，rows 是截断后的展示行
 */
export function viewedFromEvents(events = [], opts = {}) {
  const days = clampDays(opts.days)
  const limit = clampLimit(opts.limit)
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const cutoff = now - days * DAY_MS
  const map = new Map()

  const add = (bvid, atMs, patch = {}) => {
    const b = validBvid(bvid)
    if (!b || !atMs || atMs < cutoff) return
    let cur = map.get(b)
    if (!cur) {
      cur = {
        bvid: b,
        title: '',
        up: '',
        duration: 0,
        view: 0,
        tags: [],
        desc: '',
        at: '',
        sources: [],
      }
      map.set(b, cur)
    }
    // 最近一次出现的时间决定排序；标题/UP 等字段只要拿到过就保留，
    // 后面的 `looked:` 只有 BV 号，不该把前面 browse 拿到的标题冲掉。
    const at = new Date(atMs).toISOString()
    if (!cur.at || atMs > Date.parse(cur.at)) cur.at = at
    if (patch.title && !cur.title) cur.title = String(patch.title).slice(0, 160)
    if (patch.up && !cur.up) cur.up = String(patch.up).slice(0, 80)
    if (patch.desc && !cur.desc) cur.desc = String(patch.desc).slice(0, 240)
    if (patch.duration && !cur.duration) cur.duration = Math.max(0, Math.round(Number(patch.duration) || 0))
    if (patch.view && !cur.view) cur.view = Math.max(0, Math.round(Number(patch.view) || 0))
    for (const t of Array.isArray(patch.tags) ? patch.tags : []) {
      const s = String(t ?? '').trim()
      if (s && !cur.tags.includes(s)) cur.tags.push(s)
    }
    const source = String(patch.source ?? '')
    if (source && !cur.sources.includes(source)) cur.sources.push(source)
  }

  for (const e of events ?? []) {
    const atMs = timeOf(e)
    if (!atMs) continue

    if (e?.type === 'saw') {
      const bvid = validBvid(e.refs?.[0]) || bvidIn(e.text)
      add(bvid, atMs, { ...parseSaw(e.text), source: 'saw' })
      continue
    }

    if (e?.type !== 'meta') continue
    const text = String(e.text ?? '')

    if (text.startsWith('browse:')) {
      const sp = text.indexOf(' ')
      if (sp < 0) continue
      const json = text.slice(sp + 1).trim()
      if (!json.startsWith('[')) continue
      let arr
      try { arr = JSON.parse(json) } catch { continue }
      for (const it of Array.isArray(arr) ? arr : []) {
        add(it?.bvid, atMs, {
          title: it?.title,
          up: it?.up,
          duration: it?.duration,
          view: it?.view,
          source: 'browse',
        })
      }
      continue
    }

    if (text.startsWith('looked:')) {
      add(text.slice('looked:'.length), atMs, { source: 'look' })
      continue
    }

    if (text.startsWith('watched:')) {
      const b = validBvid(text.split(/\s+/).slice(-1)[0])
      add(b, atMs, { source: 'watch' })
    }
  }

  const all = [...map.values()].map((x) => ({
    ...x,
    url: videoUrl(x.bvid),
  }))
  all.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
  return { total: all.length, rows: all.slice(0, limit) }
}

/**
 * 她在 B 站说过什么：评论与楼中楼都算足迹。
 *
 * `cbody:`（0.6.2 起）里存着真正发出去的那句话；更早的评论只有
 * `comment:<日期> <bvid> <rpid>`，没有正文——UI 会标成可现取，而不是假装空。
 */
export function commentsFromEvents(events = [], opts = {}) {
  const days = clampDays(opts.days)
  const limit = clampLimit(opts.limit, 300)
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const cutoff = now - days * DAY_MS

  // 先收正文。正文事件本身没有日期语义，按 rpid 建索引，供评论/回复行认领。
  const bodies = new Map()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const text = String(e.text ?? '')
    if (!text.startsWith('cbody:')) continue
    const sp = text.indexOf(' ')
    if (sp < 0) continue
    const rpid = Number(text.slice('cbody:'.length, sp)) || 0
    if (!rpid) continue
    try {
      const obj = JSON.parse(text.slice(sp + 1))
      if (obj && typeof obj === 'object') bodies.set(rpid, obj)
    } catch { /* 坏行跳过，正文显示为空，页面不崩 */ }
  }

  const rows = []
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const atMs = timeOf(e)
    if (!atMs || atMs < cutoff) continue
    const text = String(e.text ?? '')

    if (text.startsWith('comment:')) {
      const [key, bvid, rpid] = text.split(' ')
      const b = validBvid(bvid)
      const n = Number(rpid) || 0
      const dk = key.slice('comment:'.length)
      if (!b || !n) continue
      rows.push({
        kind: 'comment',
        bvid: b,
        rpid: n,
        dk,
        at: new Date(atMs).toISOString(),
        text: bodies.get(n)?.text ?? null,
        url: commentUrl(b, n),
      })
      continue
    }

    if (text.startsWith('creply:')) {
      const [key, bvid, rootRpid, parentRpid, newRpid] = text.split(' ')
      const b = validBvid(bvid)
      const root = Number(rootRpid) || 0
      const parent = Number(parentRpid) || 0
      const n = Number(newRpid) || 0
      const dk = key.slice('creply:'.length)
      if (!b || !root) continue
      rows.push({
        kind: 'reply',
        bvid: b,
        rpid: n || null,
        rootRpid: root,
        parentRpid: parent,
        dk,
        at: new Date(atMs).toISOString(),
        text: n ? (bodies.get(n)?.text ?? null) : null,
        url: commentUrl(b, n || root),
      })
    }
  }

  rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
  return { total: rows.length, rows: rows.slice(0, limit) }
}

/** 两串足迹一起取。路由只需要调这一个函数。 */
export function footprintFromEvents(events = [], opts = {}) {
  const days = clampDays(opts.days)
  return {
    days,
    viewed: viewedFromEvents(events, { ...opts, days }),
    comments: commentsFromEvents(events, { ...opts, days }),
  }
}
