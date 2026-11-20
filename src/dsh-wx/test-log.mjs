// dsh-wx 的控制台日志必须有时间戳：没有时间的 dsh-web.log 没法按事件对账。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatStamp } from './lib/log.mjs'

assert.equal(formatStamp(new Date(2026, 10, 20, 9, 5, 3)), '2026-11-20 09:05:03')
const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
assert.equal(src.includes('console.log('), false, 'index.js 的人读日志都要带时间戳')
assert.equal(src.includes('logLine('), true)
console.log('log: 全部通过')
