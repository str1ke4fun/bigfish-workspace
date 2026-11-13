/**
 * presence-view.js —— 「他这几天」的纯渲染（presence spec §7.5）。
 *
 * 输入是 derive.presenceRecent（最近 7 天按天聚合）；输出 ≤200 字、最多 3 天。
 * 只写事实（工作/游戏/氛围分钟），不写应用名、窗口标题、屏幕文字。
 */

function fmtMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0))
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const r = m % 60
    return r ? `${h} 小时 ${r} 分钟` : `${h} 小时`
  }
  return `${m} 分钟`
}

/**
 * @param {Array<{dk:string,workMin?:number,eventMin?:number,ambientMin?:number}>} rows
 * @param {{maxDays?:number,maxChars?:number}} [opts]
 * @returns {string} 没有数据时返回空串（不输出空标题）
 */
export function presenceDocText(rows, { maxDays = 3, maxChars = 200 } = {}) {
  const list = Array.isArray(rows) ? rows.slice(0, Math.max(1, maxDays)) : []
  if (!list.length) return ''
  const lines = ['## 他这几天']
  for (const r of list) {
    const parts = []
    if (Number(r?.workMin) > 0) parts.push(`工作 ${fmtMinutes(r.workMin)}`)
    if (Number(r?.eventMin) > 0) parts.push(`游戏 ${fmtMinutes(r.eventMin)}`)
    if (Number(r?.ambientMin) > 0) parts.push(`氛围 ${fmtMinutes(r.ambientMin)}`)
    if (!parts.length) continue
    const dk = String(r?.dk ?? '')
    lines.push(`- ${dk.length >= 10 ? dk.slice(5) : dk}：${parts.join('；')}`)
  }
  if (lines.length <= 1) return ''

  const full = lines.join('\n')
  if (full.length <= maxChars) return full
  // 超预算：保留标题 + 尽可能多的整行，最后加一行省略号；不切半句。
  const kept = [lines[0]]
  for (const line of lines.slice(1)) {
    if ([...kept, line].join('\n').length <= maxChars - 2) kept.push(line)
    else break
  }
  return kept.join('\n') + '\n…'
}
