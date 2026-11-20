// 人读日志的时间戳。宿主的 dsh-web.log 只是 stdout 原样追加，
// 没有这一行时间，几天的日志就没法和 inbound.jsonl / 系统日志对账。

/** 本地时间 `YYYY-MM-DD HH:mm:ss`。 */
export function formatStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 带时间戳的控制台日志。 */
export function logLine(...args) {
  console.log(`${formatStamp()} ${args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')}`)
}
