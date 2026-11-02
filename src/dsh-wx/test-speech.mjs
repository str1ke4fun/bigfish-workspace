// 说话频率的判定测试：node test-speech.mjs
// 跑的是线上那份实现（/home/str1k3/dsh-plugins/speech/speech.mjs），状态文件指到临时目录。
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'speech-'))
const POLICY = join(dir, 'speech.json')
const STATE = join(dir, 'state.json')
process.env.SPEECH_POLICY = POLICY
process.env.SPEECH_STATE = STATE
const S = await import('../speech/speech.mjs')

const write = (p) => writeFileSync(POLICY, JSON.stringify(p))
const T = 1_700_000_000_000
let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

console.log('间隔')
t('上一条是 10 秒前、要求隔 25 秒 → 不让说，还差 15 秒', () => {
  const r = S.decide({ enabled: true, minGapSeconds: 25, maxPerMinute: 2, maxPerHour: 15 }, [T - 10_000], T)
  assert.equal(r.ok, false); assert.equal(r.waitMs, 15_000); assert.match(r.reason, /25 秒/)
})
t('上一条是 40 秒前 → 能说', () => {
  assert.equal(S.decide({ enabled: true, minGapSeconds: 25, maxPerMinute: 2, maxPerHour: 15 }, [T - 40_000], T).ok, true)
})
t('间隔设 0 就是不限', () => {
  assert.equal(S.decide({ enabled: true, minGapSeconds: 0, maxPerMinute: 2, maxPerHour: 15 }, [T - 500], T).ok, true)
})

console.log('额度')
t('一分钟内已经说了 2 条、上限 2 → 这条不发（waitMs=0，等也没用）', () => {
  const r = S.decide({ enabled: true, minGapSeconds: 0, maxPerMinute: 2, maxPerHour: 15 }, [T - 30_000, T - 5_000], T)
  assert.equal(r.ok, false); assert.equal(r.waitMs, 0); assert.match(r.reason, /一分钟内已经说了 2 条/)
})
t('一小时内已经说了 15 条、上限 15 → 这条不发', () => {
  const times = Array.from({ length: 15 }, (_, i) => T - (i + 1) * 200_000)
  const r = S.decide({ enabled: true, minGapSeconds: 0, maxPerMinute: 9, maxPerHour: 15 }, times, T)
  assert.equal(r.ok, false); assert.match(r.reason, /一小时已经说了 15 条/)
})
t('一小时以前的不算（窗口是滑动的）', () => {
  const times = Array.from({ length: 30 }, (_, i) => T - 3_600_000 - (i + 1) * 1000)
  assert.equal(S.decide({ enabled: true, minGapSeconds: 0, maxPerMinute: 2, maxPerHour: 15 }, times, T).ok, true)
})
t('关掉开关就完全不限', () => {
  const r = S.decide({ enabled: false, minGapSeconds: 999, maxPerMinute: 1, maxPerHour: 1 }, [T - 1, T - 2, T - 3], T)
  assert.equal(r.ok, true)
})

console.log('记账（admit）')
t('第一条放行并记账；紧接着第二条被间隔挡住', () => {
  rmSync(STATE, { force: true })
  write({ enabled: true, minGapSeconds: 25, maxPerMinute: 2, maxPerHour: 15 })
  assert.equal(S.admit('wx:测试群A', T).ok, true)
  const second = S.admit('wx:测试群A', T + 1000)
  assert.equal(second.ok, false)
  assert.equal(S.admit('wx:测试群A', T + 26_000).ok, true)
})
t('不同会话各算各的（微信的群和 QQ 的群不互相拖累）', () => {
  rmSync(STATE, { force: true })
  write({ enabled: true, minGapSeconds: 25, maxPerMinute: 2, maxPerHour: 15 })
  assert.equal(S.admit('wx:测试群A', T).ok, true)
  assert.equal(S.admit('group:200000002', T).ok, true)
  assert.equal(S.admit('wx:测试群A', T + 100).ok, false)
})
t('统计：一小时内的条数和最后一句话的时间', () => {
  rmSync(STATE, { force: true })
  write({ enabled: true, minGapSeconds: 0, maxPerMinute: 9, maxPerHour: 15 })
  S.admit('wx:测试群A', T - 300_000)
  S.admit('wx:测试群A', T - 100_000)
  S.admit('group:200000002', T - 20_000)
  const st = S.stats(T)
  const wx = st.find((x) => x.chat === 'wx:测试群A')
  assert.equal(wx.lastHour, 2)
  assert.equal(wx.lastAt, T - 100_000)
  assert.equal(st[0].chat, 'wx:测试群A')
})

console.log('策略文件'
)
t('手改崩了（字段缺失/负数/离谱）→ 落回默认，不会把她锁死', () => {
  write({ minGapSeconds: -5, maxPerMinute: 'abc', maxPerHour: 999999 })
  const p = S.readPolicy()
  assert.equal(p.enabled, true)
  assert.equal(p.minGapSeconds, 0)
  assert.equal(p.maxPerMinute, S.DEFAULTS.maxPerMinute)
  assert.equal(p.maxPerHour, 10000)
})
t('文件不存在 → 用默认值', () => {
  rmSync(POLICY, { force: true })
  assert.deepEqual(S.readPolicy(), S.DEFAULTS)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} 条断言全部通过`)
