// 从 NapCat 控制台日志里认出 QQ 现在是「在线」还是「被踢下线等扫码」。
// 纯函数，方便拿真日志测（test/qq-watch.test.mjs）。
//
// 依据：日志是按时间追加的，被踢会写 [KickedOffLine]，成功登录会写「二维码已被扫描」。
// 谁在后面谁说了算——最后一条踢下线之后没有新的扫码，就是掉着。

const KICK = /\[KickedOffLine\]|你的账号当前登录已失效/
const BACK = /二维码已被扫描|账号状态变更为在线|账号上线/

/** 从 "10-29 17:53:38 [error] ..." 这种行里抠时间。没有年份，按今年算（跨年那几天会歪，不影响用）。 */
export function stampOf(line, now = new Date()) {
  const m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(line)
  if (!m) return null
  const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
  // 日志里可能是去年的（跨年），比现在晚半天以上就当去年
  if (d.getTime() - now.getTime() > 12 * 3600_000) d.setFullYear(d.getFullYear() - 1)
  return d
}

/**
 * @param {string[]} lines 日志最后 N 行（去颜色之后）
 * @returns {{ phase: 'online'|'kicked'|'unknown', at: Date|null, line: string }}
 */
export function qqState(lines, now = new Date()) {
  let kick = null
  let back = null
  for (const line of lines) {
    if (KICK.test(line)) kick = line
    if (BACK.test(line)) back = line
  }
  const kickAt = kick ? stampOf(kick, now) : null
  const backAt = back ? stampOf(back, now) : null
  if (!kick) return { phase: back ? 'online' : 'unknown', at: backAt, line: back ?? '' }
  if (backAt && kickAt && backAt > kickAt) return { phase: 'online', at: backAt, line: back }
  return { phase: 'kicked', at: kickAt, line: kick }
}

/** 只留最后 400 行，别把 460KB 全塞进内存。 */
export function tailLines(text, n = 400) {
  const all = String(text ?? '').split('\n').filter((l) => l.trim() !== '')
  return all.slice(Math.max(0, all.length - n))
}
