import test from 'node:test'
import assert from 'node:assert/strict'
import { qqState, stampOf, tailLines } from '../qq-watch.mjs'

// 用的都是真日志里的行（颜色码已去掉）。
const NOW = new Date(2026, 9, 29, 18, 0, 0)
const KICK = '10-29 17:53:38 [error] D33p53Ek | [KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。'
const SCAN_BEFORE = '10-29 16:41:45 [info] [Core] [Login] 二维码已被扫描，等待确认...'
const SCAN_AFTER = '10-29 18:05:10 [info] [Core] [Login] 二维码已被扫描，等待确认...'

test('最后一条是踢下线、后面没有扫码 → 掉着', () => {
  const s = qqState([SCAN_BEFORE, KICK], NOW)
  assert.equal(s.phase, 'kicked')
  assert.equal(s.at.getTime(), new Date(2026, 9, 29, 17, 53, 38).getTime())
})

test('踢下线之后又扫了码 → 在线', () => {
  const s = qqState([KICK, SCAN_AFTER], NOW)
  assert.equal(s.phase, 'online')
  assert.equal(s.at.getTime(), new Date(2026, 9, 29, 18, 5, 10).getTime())
})

test('扫码在前、踢在后 → 掉着', () => {
  const kickLater = KICK.replace('17:53:38', '18:10:00')
  assert.equal(qqState([SCAN_AFTER, kickLater], NOW).phase, 'kicked')
})

test('只有扫码记录 → 在线', () => {
  assert.equal(qqState([SCAN_BEFORE], NOW).phase, 'online')
})

test('什么都没认出来 → unknown', () => {
  assert.equal(qqState(['10-29 17:00:00 [info] 一堆别的话', '10-29 17:00:01 [info] 还是别的话'], NOW).phase, 'unknown')
})

test('时间戳解析成年月日时分秒', () => {
  const d = stampOf('10-29 17:53:38 [error] x', NOW)
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [9, 29, 17, 53, 38])
})

test('没有时间戳的行返回 null', () => {
  assert.equal(stampOf('CQ 码一行', NOW), null)
})

test('tailLines 只留最后 N 行，丢掉空行', () => {
  const text = Array.from({ length: 10 }, (_, i) => `行${i}`).join('\n') + '\n\n'
  assert.deepEqual(tailLines(text, 3), ['行7', '行8', '行9'])
})
