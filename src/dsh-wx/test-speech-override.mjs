// 微信限流覆盖层：QQ 继续用顶层值，微信用 wx.* 覆盖。
// 跑：node --test test-speech-override.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'speech-override-'))
process.env.SPEECH_POLICY = join(dir, 'speech.json')
process.env.SPEECH_STATE = join(dir, 'state.json')

const S = await import('../speech/speech.mjs')

after(() => rmSync(dir, { recursive: true, force: true }))

test('缺省 wx 覆盖是 8 / 4 / 40，QQ 仍是 base', () => {
  const raw = S.normalize({})
  assert.deepEqual(raw.wx, S.WX_DEFAULTS)
  assert.equal(S.resolve(raw, 'qq').minGapSeconds, S.DEFAULTS.minGapSeconds)
  assert.equal(S.resolve(raw, 'qq').maxPerMinute, S.DEFAULTS.maxPerMinute)
  assert.equal(S.resolve(raw, 'wx').minGapSeconds, 8)
  assert.equal(S.resolve(raw, 'wx').maxPerMinute, 4)
  assert.equal(S.resolve(raw, 'wx').maxPerHour, 40)
})

test('自定义 wx 覆盖只影响微信', () => {
  const p = S.normalize({ wx: { minGapSeconds: 3, maxPerMinute: 6, maxPerHour: 60 } })
  assert.equal(S.resolve(p, 'wx').minGapSeconds, 3)
  assert.equal(S.resolve(p, 'wx').maxPerMinute, 6)
  assert.equal(S.resolve(p, 'wx').maxPerHour, 60)
  assert.equal(S.resolve(p, 'qq').minGapSeconds, S.DEFAULTS.minGapSeconds)
})

test('wx 覆盖里的离谱值也落回上下限', () => {
  const p = S.normalize({ wx: { minGapSeconds: -1, maxPerMinute: 9999, maxPerHour: 99999 } })
  assert.equal(S.resolve(p, 'wx').minGapSeconds, 0)
  assert.equal(S.resolve(p, 'wx').maxPerMinute, 1000)
  assert.equal(S.resolve(p, 'wx').maxPerHour, 10000)
})

test('channelOf 按 key 前缀认出微信，admit 用覆盖值判定', () => {
  assert.equal(S.channelOf('wx:测试群A'), 'wx')
  assert.equal(S.channelOf('group:123'), 'qq')
  writeFileSync(process.env.SPEECH_POLICY, JSON.stringify({ minGapSeconds: 25, maxPerMinute: 2, maxPerHour: 15, wx: { minGapSeconds: 8, maxPerMinute: 4, maxPerHour: 40 } }))
  const T = 1_700_000_000_000
  // 8 秒前说过一条：微信能说（覆盖 8s），QQ 不能（base 25s）。
  assert.equal(S.decide(S.resolve(S.readPolicy(), 'wx'), [T - 8_000], T).ok, true)
  assert.equal(S.decide(S.resolve(S.readPolicy(), 'qq'), [T - 8_000], T).ok, false)
})

test('文件不存在时 readPolicy 仍是完整默认值（含 wx）', () => {
  rmSync(process.env.SPEECH_POLICY, { force: true })
  assert.deepEqual(S.readPolicy(), S.DEFAULTS)
})
