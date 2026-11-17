/**
 * presence-view.js —— 「他这几天」的纯渲染（presence spec §7.5）。
 *
 * 输入是 derive.presenceRecent（最近 7 天按天聚合）；输出 ≤200 字、最多 3 天。
 * 只写大致在做什么，不报分钟表，也不写应用名、窗口标题、屏幕文字。
 */

function workPhrase(min) {
  const m = Math.max(0, Math.round(Number(min) || 0))
  if (!m) return ''
  if (m >= 120) return '大半天在做事'
  if (m >= 60) return '有一阵在做事'
  if (m >= 30) return '在电脑前忙了一会儿'
  return '在电脑前坐了一会儿'
}

function gamePhrase(min) {
  const m = Math.max(0, Math.round(Number(min) || 0))
  if (!m) return ''
  if (m >= 120) return '玩了很久游戏'
  if (m >= 60) return '玩了好一阵游戏'
  if (m >= 20) return '玩了一会儿游戏'
  return '碰了会儿游戏'
}

function ambientPhrase(min) {
  const m = Math.max(0, Math.round(Number(min) || 0))
  if (!m) return ''
  if (m >= 120) return '在旁边待了很久'
  if (m >= 60) return '在旁边待了一阵'
  if (m >= 20) return '在旁边待了一会儿'
  return '在旁边看了一会儿'
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
    const work = workPhrase(r?.workMin)
    const game = gamePhrase(r?.eventMin)
    const ambient = ambientPhrase(r?.ambientMin)
    if (work) parts.push(work)
    if (game) parts.push(game)
    if (ambient) parts.push(ambient)
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
