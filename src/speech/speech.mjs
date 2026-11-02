/**
 * 说话频率：两个通道共用的限流器。QQ 和微信都读同一个策略文件，工作台改完立刻生效（每次都现读）。
 *
 * 为什么放在插件目录里：QQ 那边是 vendor 补丁（`qq/patch-speech-limit.py` 往 outbound.js 里插一句
 * `await speechGate(chatId)`），微信这边是 `dsh-wx` 自己的代码。两边必须用同一份判定，
 * 否则"工作台调了没反应"这种坑会反复出现，所以抽成一个不依赖任何插件的小文件，两边按绝对路径 import。
 *
 * 策略（`speech.json`，只认这几个键，其余忽略）：
 *   enabled       总开关
 *   minGapSeconds 同一个会话两条之间至少隔多少秒（会等，等到就说）
 *   maxPerMinute  一分钟内最多几条（超了这条就不发）
 *   maxPerHour    一小时内最多几条（超了这条就不发）
 *
 * 状态（`speech-state.json`）：`{ chats: { "wx:测试群A": [ts, …] } }`，只留最近一小时。
 * 键由调用方给：微信 `wx:<会话名>`，QQ `group:<群号>` / `private:<QQ号>`。
 * 写文件用 tmp + rename，两个进程同时写最多丢一条时间戳（偏宽松，不会卡住她）。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const DIR = '/home/str1k3/dsh-plugins/speech'
// 测试时可以指到临时文件，生产不设这两个环境变量
export const POLICY_PATH = process.env.SPEECH_POLICY || DIR + '/speech.json'
export const STATE_PATH = process.env.SPEECH_STATE || DIR + '/speech-state.json'

export const DEFAULTS = { enabled: true, minGapSeconds: 25, maxPerMinute: 2, maxPerHour: 15 }

const HOUR = 3600_000
const MINUTE = 60_000

/** 数值兜底：NaN/负数/离谱值都落回默认，免得手改崩掉限流。 */
export function normalize(raw) {
  const num = (v, def, lo, hi) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(hi, Math.max(lo, Math.round(n)))
  }
  return {
    enabled: raw?.enabled !== false,
    minGapSeconds: num(raw?.minGapSeconds, DEFAULTS.minGapSeconds, 0, 3600),
    maxPerMinute: num(raw?.maxPerMinute, DEFAULTS.maxPerMinute, 1, 1000),
    maxPerHour: num(raw?.maxPerHour, DEFAULTS.maxPerHour, 1, 10000),
  }
}

export function readPolicy() {
  try { return normalize(JSON.parse(readFileSync(POLICY_PATH, 'utf8'))) } catch { return { ...DEFAULTS } }
}

/**
 * 纯判定：给定策略、该会话最近的时间戳、现在，能不能说。
 * 返回 { ok:true } 或 { ok:false, waitMs, reason }。
 *   waitMs > 0  = 等一会儿就能说（间隔不够，可以等）
 *   waitMs == 0 = 这个窗口内的额度用完了（等也没意义，这条别发）
 */
export function decide(policy, times, now) {
  if (!policy.enabled) return { ok: true }
  const recent = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && now - t < HOUR).sort((a, b) => a - b)
  const last = recent[recent.length - 1]
  const gap = policy.minGapSeconds * 1000
  if (last !== undefined && now - last < gap) {
    const waitMs = gap - (now - last)
    return { ok: false, waitMs, reason: `同一会话两条之间至少隔 ${policy.minGapSeconds} 秒，还差 ${Math.ceil(waitMs / 1000)} 秒` }
  }
  const lastMinute = recent.filter((t) => now - t < MINUTE).length
  if (lastMinute >= policy.maxPerMinute) {
    return { ok: false, waitMs: 0, reason: `一分钟内已经说了 ${lastMinute} 条（上限 ${policy.maxPerMinute}），这条不发` }
  }
  if (recent.length >= policy.maxPerHour) {
    return { ok: false, waitMs: 0, reason: `这一小时已经说了 ${recent.length} 条（上限 ${policy.maxPerHour}），这条不发` }
  }
  return { ok: true }
}

export function readState() {
  try {
    const j = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    const chats = j && typeof j.chats === 'object' && j.chats !== null ? j.chats : {}
    return { chats }
  } catch { return { chats: {} } }
}

function writeState(state) {
  try {
    const tmp = STATE_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, STATE_PATH)
  } catch { /* 存不下就当没说，下次重算 */ }
}

/**
 * 判定 + 记账：能说就记一条时间戳并返回 { ok:true, policy }，不能说就只返回原因。
 * 记账是在「决定发」的时候做的，不是发成功之后——发失败多算一条也比漏算安全。
 */
export function admit(chatKey, now = Date.now()) {
  const policy = readPolicy()
  if (!policy.enabled) return { ok: true, policy }
  const state = readState()
  const times = state.chats[chatKey] ?? []
  const verdict = decide(policy, times, now)
  if (!verdict.ok) return { ...verdict, policy }
  const next = {}
  for (const [k, v] of Object.entries(state.chats)) {
    const keep = (Array.isArray(v) ? v : []).filter((t) => Number.isFinite(t) && now - t < HOUR)
    if (keep.length > 0) next[k] = keep
  }
  next[chatKey] = [...(next[chatKey] ?? []), now].slice(-500)
  writeState({ chats: next })
  return { ok: true, policy }
}

/** 等一会儿再说：最多等 maxWaitMs，还是不行就返回原因。两个通道都用它，行为一致。 */
export async function waitAndAdmit(chatKey, maxWaitMs = 60_000, now = Date.now) {
  let verdict = admit(chatKey, now())
  if (verdict.ok) return verdict
  if (verdict.waitMs > 0 && verdict.waitMs <= maxWaitMs) {
    await new Promise((r) => setTimeout(r, verdict.waitMs + 200))
    verdict = admit(chatKey, now())
    if (verdict.ok) return verdict
  }
  return verdict
}

/** 工作台用：每个会话最近一分钟/一小时各说了几条。 */
export function stats(now = Date.now()) {
  const state = readState()
  const out = []
  for (const [chat, times] of Object.entries(state.chats)) {
    const t = (Array.isArray(times) ? times : []).filter((x) => Number.isFinite(x) && now - x < HOUR)
    if (t.length === 0) continue
    out.push({
      chat,
      lastHour: t.length,
      lastMinute: t.filter((x) => now - x < MINUTE).length,
      lastAt: Math.max(...t),
      quietMs: now - Math.max(...t),
    })
  }
  return out.sort((a, b) => b.lastHour - a.lastHour)
}
