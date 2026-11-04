/**
 * people.js —— 人物名册：把同一个人的全名、群昵称、引用短名归到一起
 *
 * 为什么需要名册：
 *   微信里同一个人会以不同写法出现：群名片「计科4223薛长顺」、引用里的「薛长顺」、
 *   带备注后缀的「文天聪(w14973)」。发言人如果能统一到一个人，台账才可检索。
 *
 * 三条规则：
 *   1. 只增不删。学习只会合并别名、会话、来源，名册永远不裁剪。
 *   2. 精确优先。全名 / 归一化名 / 已知别名精确命中才是 high；短名只做唯一前缀，
 *      不做「包含」猜测（那是学习阶段、有上下文时才做的事）。
 *   3. 名册是派生索引，不是消息真相；写坏了按空名册处理，台账不受影响。
 *
 * 文件格式（version 1）：
 *   { version: 1, people: [{ key, display, aliases, chats, sources, firstSeenAt, lastSeenAt }] }
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const PEOPLE_VERSION = 1
export const DEFAULT_PEOPLE = '/home/str1k3/.dsh-wx/people.json'
export const MIN_PREFIX = 3
export const MAX_NAME = 24

const str = (v) => String(v ?? '').trim()
const lengthOf = (s) => [...s].length
const nowIso = (now) => new Date(Number(now()) || Date.now()).toISOString()
const unique = (list) => [...new Set(list)]
const pushUnique = (list, value) => { if (value && !list.includes(value)) list.push(value) }

/**
 * 人物名归一：去掉所有空白（含全角空格），只把 ASCII 字母转小写。
 * 保留非 ASCII 大小写，避免不同语言的名字被改写。
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizePerson(name) {
  return String(name ?? '')
    .replace(/\s+/gu, '')
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * 拆出括号后缀：`文天聪(w14973)` → `{ name: '文天聪', suffix: 'w14973' }`。
 * 没有括号后缀时 suffix 为空串，name 保持原样。
 *
 * @param {unknown} name
 * @returns {{ name: string, suffix: string }}
 */
export function splitPersonSuffix(name) {
  const raw = str(name)
  const m = raw.match(/^(.+?)\s*[（(]\s*([^()（）]+?)\s*[)）]\s*$/u)
  if (!m) return { name: raw, suffix: '' }
  return { name: m[1].trim(), suffix: m[2].trim() }
}

function validName(raw) {
  const s = str(raw)
  const len = lengthOf(s)
  if (len < 1 || len > MAX_NAME) return false
  if (/[\r\n:：]/u.test(s)) return false
  return true
}

function blankPerson({ key, display, at }) {
  return {
    key,
    display,
    aliases: [],
    chats: [],
    sources: [],
    firstSeenAt: at,
    lastSeenAt: at,
  }
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const display = str(raw.display)
  const key = normalizePerson(raw.key) || normalizePerson(display)
  if (!key) return null
  return {
    key,
    display: display || key,
    aliases: unique((Array.isArray(raw.aliases) ? raw.aliases : []).map(str).filter(Boolean)),
    chats: unique((Array.isArray(raw.chats) ? raw.chats : []).map(str).filter(Boolean)),
    sources: unique((Array.isArray(raw.sources) ? raw.sources : []).map(str).filter(Boolean)),
    firstSeenAt: str(raw.firstSeenAt),
    lastSeenAt: str(raw.lastSeenAt) || str(raw.firstSeenAt),
  }
}

function readPeople(file, log) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      log?.('人物名册读不出来，按空名册处理：' + String(err?.message ?? err).slice(0, 120))
    }
    return []
  }
  const list = Array.isArray(raw?.people) ? raw.people : []
  return list.map(normalizeEntry).filter(Boolean)
}

/**
 * @param {object} [opts]
 * @param {string} [opts.file] 默认 ~/.dsh-wx/people.json
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createPeople({ file = DEFAULT_PEOPLE, now = Date.now, log } = {}) {
  let people = readPeople(file, log)

  const clone = (e) => ({
    ...e,
    aliases: [...e.aliases],
    chats: [...e.chats],
    sources: [...e.sources],
  })

  const matches = (e, n) => e.key === n || normalizePerson(e.display) === n ||
    e.aliases.some((a) => normalizePerson(a) === n)

  function findExact(name) {
    const n = normalizePerson(name)
    if (!n) return null
    return people.find((e) => matches(e, n)) ?? null
  }

  /** 学到的名字是某个已知人名的唯一前缀：多半是截断显示，不新建条目。 */
  function findUniquePrefix(n) {
    const hits = people.filter((e) => e.key !== n && e.key.startsWith(n))
    return hits.length === 1 ? hits[0] : null
  }

  /** 引用里的短名是某个已知人名的唯一后缀：当作别名并回原条目。 */
  function findUniqueSuffix(n) {
    const hits = people.filter((e) => e.key !== n && e.key.endsWith(n))
    return hits.length === 1 ? hits[0] : null
  }

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: PEOPLE_VERSION, people }, null, 2), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      return { ok: true }
    } catch (err) {
      log?.('人物名册写不进去：' + String(err?.message ?? err).slice(0, 160))
      return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
    }
  }

  function mergeObservation(e, { chatId, source, at }) {
    if (chatId) pushUnique(e.chats, chatId)
    if (source) pushUnique(e.sources, source)
    e.lastSeenAt = at
  }

  /**
   * 学习一次观察到的人名。返回合并后的条目；名字不合格返回 null。
   *
   * @param {object} req
   * @param {string} req.name 原始名字
   * @param {string} [req.source] preview / quote / ...
   * @param {string} [req.chatId]
   * @returns {object|null}
   */
  function learn({ name, source = 'preview', chatId = '' } = {}) {
    const raw = str(name)
    if (!validName(raw)) return null

    const { name: base, suffix } = splitPersonSuffix(raw)
    const display = str(base)
    if (!validName(display)) return null
    const key = normalizePerson(display)
    if (!key) return null

    const at = nowIso(now)
    const src = str(source) || 'preview'
    const chat = str(chatId)

    let e = people.find((x) => x.key === key || matches(x, key))
    if (!e && src === 'quote' && lengthOf(key) >= 2) {
      // 引用行常只显示姓名；只有唯一后缀才并回，撞名不猜。
      e = findUniqueSuffix(key)
    }
    if (!e && lengthOf(key) >= MIN_PREFIX) {
      const owner = findUniquePrefix(key)
      if (owner) {
        // 截断观察：记下这次看见，但不把截断名当别名。
        mergeObservation(owner, { chatId: chat, source: src, at })
        save()
        return clone(owner)
      }
    }

    if (e) {
      if (raw !== e.display) pushUnique(e.aliases, raw)
      if (suffix) pushUnique(e.aliases, suffix)
      mergeObservation(e, { chatId: chat, source: src, at })
      save()
      return clone(e)
    }

    e = blankPerson({ key, display, at })
    if (raw !== display) pushUnique(e.aliases, raw)
    if (suffix) pushUnique(e.aliases, suffix)
    mergeObservation(e, { chatId: chat, source: src, at })
    people.push(e)
    save()
    return clone(e)
  }

  /**
   * 解析一个名字。精确命中 high；唯一前缀 medium；其余 low 且不匹配。
   * `name` 在 low 时保持调用方原始写法。
   *
   * @param {unknown} raw
   * @returns {{ name: string, confidence: 'high'|'medium'|'low', matched: boolean }}
   */
  function resolve(raw) {
    const q = str(raw)
    const n = normalizePerson(q)
    if (!n) return { name: q, confidence: 'low', matched: false }

    const exact = people.find((e) => matches(e, n))
    if (exact) return { name: exact.display, confidence: 'high', matched: true }

    if (lengthOf(n) >= MIN_PREFIX) {
      const hits = people.filter((e) => e.key.startsWith(n) || n.startsWith(e.key))
      const keys = new Set(hits.map((e) => e.key))
      if (keys.size === 1) return { name: hits[0].display, confidence: 'medium', matched: true }
    }
    return { name: q, confidence: 'low', matched: false }
  }

  /** 精确查询一个人物条目（显示名 / key / 别名）。 */
  function entry(raw) {
    const e = findExact(raw)
    return e ? clone(e) : null
  }

  /** 名册快照，保持首次出现的顺序。 */
  function all() {
    return people.map(clone)
  }

  /** 丢掉内存状态，重新读盘。 */
  function reload() {
    people = readPeople(file, log)
    return all()
  }

  return { file, learn, resolve, entry, all, reload }
}
