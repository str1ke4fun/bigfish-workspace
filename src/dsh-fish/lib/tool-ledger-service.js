/**
 * tool-ledger-service.js —— `fishCore.toolLedger`（A1.7）
 *
 * 设计 §7.7：status / read / artifact，全部只读。
 *   - read 按 UTC 日期取当天 JSONL（台账就是这么切的），再按会话/工具过滤；
 *   - artifact 只允许 tool-ledger/artifacts 前缀：resolve 之后必须仍落在该
 *     目录下，`..`、绝对路径指向外面都按 ARTIFACT_OUTSIDE 拒绝；
 *   - status 透传台账自己的计数，台账没挂上时明确说 NO_LEDGER，不伪装成 0。
 *
 * 这一层不写任何东西。台账的写入仍由 index.js 里注册的监听器负责，
 * 搬出去的 dsh-bili 只通过这里回看自己的调用。
 */

import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { paths } from './store.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function ledgerOf(source) {
  try {
    return typeof source === 'function' ? source() : source
  } catch {
    return null
  }
}

/**
 * @param {{ root?: string, ledger?: object|Function, log?: Function }} [opts]
 *   ledger 可以是实例，也可以是返回实例的 getter：index.js 先挂 fishCore、
 *   后建台账，getter 让两者顺序不必倒过来。
 */
export function createToolLedgerService({ root, ledger, log } = {}) {
  const p = paths(root)

  function status() {
    const l = ledgerOf(ledger)
    if (!l || typeof l.status !== 'function') return { ok: false, why: 'NO_LEDGER' }
    try {
      return l.status()
    } catch (err) {
      log?.(`[dsh-fish] toolLedger.status 读不到：${String(err?.message ?? err).slice(0, 120)}`)
      return { ok: false, why: 'LEDGER_STATUS_FAILED' }
    }
  }

  async function read({ date = '', session = '', tool = '', limit = 100 } = {}) {
    const day = String(date || new Date().toISOString().slice(0, 10))
    if (!DATE_RE.test(day)) return []

    let text
    try {
      text = await readFile(join(p.toolLedgerDir, `${day}.jsonl`), 'utf8')
    } catch {
      return []
    }

    const wantSession = String(session ?? '')
    const wantTool = String(tool ?? '')
    const max = Math.min(Math.max(Number(limit) || 100, 1), 1000)
    const rows = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue // 半行（进程被杀）跳过，不因为一行坏数据丢掉整天
      }
      if (wantSession && String(row?.sessionId ?? '') !== wantSession) continue
      if (wantTool && String(row?.tool ?? '') !== wantTool) continue
      rows.push(row)
    }
    return rows.slice(-max)
  }

  async function artifact(path) {
    const base = resolve(p.toolLedgerArtifacts)
    const target = resolve(base, String(path ?? ''))
    if (target !== base && !target.startsWith(base + sep)) {
      return { ok: false, why: 'ARTIFACT_OUTSIDE' }
    }
    try {
      const text = await readFile(target, 'utf8')
      return { ok: true, data: JSON.parse(text) }
    } catch {
      return { ok: false, why: 'ARTIFACT_UNREADABLE' }
    }
  }

  return { status, read, artifact }
}
