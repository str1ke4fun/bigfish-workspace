/**
 * archive.js —— L0 热存 → L1 归档
 *
 * 台账按月分段，但不会无限留在热目录。超过保留期（默认 90 天）的**整月**文件
 * 移到 `ledger/archive/`，永久保留，不删除、不改写正文。
 *
 * 顺序是「复制 → 校验 → 移走」：
 *   1. 复制到 archive 下的临时文件；
 *   2. 两边 sha256 和行数一致才算通过；
 *   3. 校验通过后才把原文件 rename 到归档位置。
 * 任一步失败都保留原文件并告警；宁可多留一份，也不静默丢数据。
 *
 * 归档只处理「整月都已经早于保留期」的文件；当月和上个月不会被动。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export const DEFAULT_RETENTION_DAYS = 90
const MONTH_FILE = /^(.+)-(\d{4})-(\d{2})\.jsonl$/

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const lines = (buf) => String(buf).split('\n').filter((l) => l.trim()).length

/** 这个月份（UTC）的最后一毫秒。 */
export function monthEndMs(month) {
  const m = String(month ?? '').match(/^(\d{4})-(\d{2})$/)
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]), 1) - 1
}

/** 列出热目录里的台账文件（不递归）。 */
export function ledgerFiles(dir) {
  try {
    return readdirSync(dir)
      .map((name) => {
        const m = name.match(MONTH_FILE)
        if (!m) return null
        return { name, file: join(dir, name), chatId: m[1], month: `${m[2]}-${m[3]}` }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 哪些文件该归档：整月结束时间早于 now - retentionDays。
 * @returns {Array<{name:string,file:string,chatId:string,month:string}>}
 */
export function planArchive({ dir, now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const cutoff = Number(now) - Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS) * 24 * 3600_000
  return ledgerFiles(dir).filter((f) => {
    const end = monthEndMs(f.month)
    return Number.isFinite(end) && end < cutoff
  })
}

/**
 * 归档一个文件。返回可读的结果，永不静默。
 * @returns {{ok:boolean, why?:string, file?:string, target?:string, bytes?:number, lines?:number, sha256?:string}}
 */
export function archiveFile({ file, archiveDir, log } = {}) {
  const source = String(file ?? '')
  if (!source || !existsSync(source)) return { ok: false, why: '原文件不存在' }
  const target = join(archiveDir, basename(source))
  try {
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
    const before = readFileSync(source)
    const digest = sha(before)
    const count = lines(before)

    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    copyFileSync(source, tmp)
    const copied = readFileSync(tmp)
    if (sha(copied) !== digest || lines(copied) !== count) {
      return { ok: false, why: '复制校验不一致，保留原文件', file: source, target }
    }

    // 目标已存在时必须是同一份内容；不是就拒绝覆盖（可能有另一轮归档/人工文件）。
    if (existsSync(target)) {
      const old = readFileSync(target)
      if (sha(old) !== digest) return { ok: false, why: '归档目标已存在且内容不同，保留原文件', file: source, target }
    }
    renameSync(tmp, target)
    const final = readFileSync(target)
    if (sha(final) !== digest || lines(final) !== count) {
      return { ok: false, why: '归档文件校验不一致，原文件保留', file: source, target }
    }
    // 校验通过后移走原文件。rename 覆盖的是刚校验过的同一份内容，不会丢行。
    renameSync(source, target)
    return { ok: true, file: source, target, bytes: final.length, lines: count, sha256: digest }
  } catch (err) {
    const why = String(err?.message ?? err).slice(0, 200)
    log?.('归档失败：' + why + '（原文件保留）')
    return { ok: false, why, file: source, target }
  }
}

/**
 * 按保留期批量归档。
 * @returns {{ok:boolean, archived:Array<object>, failed:Array<object>, planned:number}}
 */
export function archiveLedger({
  dir, archiveDir = join(dir, 'archive'), now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS, log,
} = {}) {
  const plan = planArchive({ dir, now, retentionDays })
  const archived = []
  const failed = []
  for (const item of plan) {
    const r = archiveFile({ file: item.file, archiveDir, log })
    if (r.ok) {
      archived.push({ ...item, ...r })
      log?.(`归档 ${item.name}（${r.lines} 行）`)
    } else {
      failed.push({ ...item, ...r })
      log?.('归档没做：' + item.name + '：' + r.why)
    }
  }
  return { ok: failed.length === 0, archived, failed, planned: plan.length }
}

/** 归档目录里某个会话 + 月份的路径（没有就返回空串）。 */
export function archivedFileOf(dir, chatId, month, archiveDir = join(dir, 'archive')) {
  const file = join(archiveDir, `${chatId}-${month}.jsonl`)
  try { return statSync(file).isFile() ? file : '' } catch { return '' }
}
