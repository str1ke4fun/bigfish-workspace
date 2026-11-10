/**
 * cross-channel.test.mjs —— 跨面去引用化（A1.3）
 *
 * 隐私边界只有一条：**微信/QQ/屋子的对话原文不跨面**。
 * 但「她学到的东西」要能跨面——想法、语气、立场是她的，不是那条通道的。
 *
 * 这组用例守三件事：
 *   ① guard.crossChannel 的四条规则（同面原样、去引用、长段重合、短文本丢弃）；
 *   ② deriveSelf 的 beliefs 带 originChannel，且按 viewSurface 去引用化；
 *   ③ 身份文档渲染时真的走了 viewSurface:'identity'。
 *
 * 特别钉住主控裁定：规则 4 比对时排除信念自己的来源事件与 meta，
 * 否则每一条「从微信聊天里长出来的纯想法」都会在自己的原文上命中而消失。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { crossChannel } from '../lib/guard.js'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { appendEvent } from '../lib/store.js'
import { writeSelfDoc, selfDocPath } from '../lib/selfdoc.js'

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

/* ------------------------------ guard ------------------------------ */

test('crossChannel：core 来源或同一面原样返回', () => {
  const text = '我觉得人应该先照顾好自己。'
  assert.deepEqual(crossChannel(text, { from: 'core', to: 'bili', rawTexts: [] }), {
    text, redacted: false, why: '',
  })
  assert.deepEqual(crossChannel(text, { from: 'wx', to: 'wx', rawTexts: [] }), {
    text, redacted: false, why: '',
  })
  // 缺参数时宁可不动，也不要在调用方写错时替她删记忆。
  assert.deepEqual(crossChannel(text, {}), { text, redacted: false, why: '' })
})

test('crossChannel：空文本不抛，也不算被删', () => {
  assert.deepEqual(crossChannel('', { from: 'wx', to: 'bili' }), {
    text: '', redacted: false, why: '',
  })
  assert.deepEqual(crossChannel(null, { from: 'wx', to: 'bili' }), {
    text: '', redacted: false, why: '',
  })
})

test('crossChannel：去掉引号包裹的原文', () => {
  const r = crossChannel('他今天在群里说「下午三点老地方见，别迟到了啊」，我记下了。', {
    from: 'wx', to: 'bili', rawTexts: [],
  })
  assert.equal(r.redacted, true)
  assert.equal(r.text.includes('「'), false)
  assert.equal(r.text.includes('下午三点老地方见'), false)
  assert.ok(r.text.length >= 8)
})

test('crossChannel：去掉 @、URL、邮箱、手机号、QQ、微信号与点名介绍', () => {
  const base = '这件事我自己心里有数，不用你替我操心，也别到处去说。'
  const cases = [
    ['我闺蜜叫小美。', '小美'],
    ['@小美', '小美'],
    ['https://example.com/u/123', 'example.com'],
    ['xm@example.com', 'example.com'],
    ['13800138000', '13800138000'],
    ['QQ：123456789', '123456789'],
    ['微信号 xiaomei_2026', 'xiaomei_2026'],
  ]
  for (const [tail, leaked] of cases) {
    const r = crossChannel(base + tail, { from: 'wx', to: 'bili', rawTexts: [] })
    assert.equal(r.redacted, true, `应命中：${tail}`)
    assert.equal(r.text.includes(leaked), false, `不应泄露：${leaked}`)
    assert.ok(r.text.length >= 8, `安全正文应保留：${tail}`)
  }
})

test('crossChannel：日常动词「叫」不是点名介绍，别整句删掉', () => {
  const text = '我妈叫我回家吃饭，我先走了，回头再和你说这件事。'
  const r = crossChannel(text, { from: 'wx', to: 'bili', rawTexts: [] })
  assert.equal(r.text, text)
  assert.equal(r.redacted, false)
})

test('crossChannel：与来源通道原文连续 ≥12 字重合的整句去掉', () => {
  const raw = '下午三点在老地方见面别忘了'
  const safe = '我觉得人应该先照顾好自己，别总为了别人委屈自己。'
  const belief = safe + '他今天说下午三点在老地方见面别忘了。'
  const r = crossChannel(belief, { from: 'wx', to: 'bili', rawTexts: [raw] })
  assert.equal(r.redacted, true)
  assert.equal(r.text.includes('下午三点'), false, '重合的那一整句都要去掉')
  assert.ok(r.text.includes('别总为了别人委屈自己'), '不重合的句子要留下')
})

test('crossChannel：剩余不足 8 字、或删减超过 60% → 整条不渲染', () => {
  const short = crossChannel('我不喜欢热闹。', { from: 'wx', to: 'bili', rawTexts: [] })
  assert.equal(short.text, '')
  assert.equal(short.why, 'privacy_redacted')

  const mostlyQuoted = crossChannel('「下午三点老地方见。」', { from: 'wx', to: 'bili', rawTexts: [] })
  assert.equal(mostlyQuoted.text, '')
  assert.equal(mostlyQuoted.redacted, true)
})

test('crossChannel：永不抛，异常输入走 guard-failed', () => {
  assert.doesNotThrow(() => crossChannel({ toString() { throw new Error('boom') } }, { from: 'wx', to: 'bili' }))
  const r = crossChannel({ toString() { throw new Error('boom') } }, { from: 'wx', to: 'bili' })
  assert.deepEqual(r, { text: '', redacted: true, why: 'guard-failed' })
})

/* ------------------------------ derive ------------------------------ */

function wxFixture() {
  return [
    ev('ev_seed', 'seed', 1, '种', { channel: 'core', surface: 'core', source: 'system' }),
    // 纯想法：从微信里说出来，但不含任何原文引用，必须能跨面。
    ev('ev_pure', 'utterance', 2, '我觉得人应该先照顾好自己。', { channel: 'wx', surface: 'wx' }),
    // 点名介绍：跨面时必须被抹掉。
    ev('ev_name', 'utterance', 3, '我闺蜜叫小美，她最近在找工作。', { channel: 'wx', surface: 'wx' }),
  ]
}

test('derive：beliefs 带 originChannel', () => {
  const m = deriveSelf(wxFixture(), { now: T0 + 4 * DAY_MS })
  const pure = m.beliefs.find((b) => b.id === 'ev_pure')
  const name = m.beliefs.find((b) => b.id === 'ev_name')
  assert.equal(pure.originChannel, 'wx')
  assert.equal(name.originChannel, 'wx')
})

test('derive：viewSurface=bili 时微信原文不出现，纯想法保留（不在自己的来源事件上误删）', () => {
  const m = deriveSelf(wxFixture(), { now: T0 + 4 * DAY_MS, viewSurface: 'bili' })
  assert.equal(m.beliefs.some((b) => String(b.text).includes('小美')), false)
  assert.equal(m.sharedBeliefs.some((b) => String(b.text).includes('小美')), false)
  assert.ok(m.sharedBeliefs.some((b) => String(b.text).includes('照顾好自己')), '纯想法必须跨面')
  assert.equal(m.facts.sharedBeliefs.some((b) => String(b.text).includes('小美')), false)
})

test('derive：viewSurface 与来源同面时原样，缺省时全部原样', () => {
  const same = deriveSelf(wxFixture(), { now: T0 + 4 * DAY_MS, viewSurface: 'wx' })
  assert.ok(same.beliefs.some((b) => String(b.text).includes('小美')), '微信面看得见微信原文')

  const none = deriveSelf(wxFixture(), { now: T0 + 4 * DAY_MS })
  assert.ok(none.beliefs.some((b) => String(b.text).includes('小美')), '不带 viewSurface 时行为不变')
  assert.ok(none.solid === undefined || Array.isArray(none.solid))
})

test('derive：privacyRedacted 按条计数，同一信念出现在 ranked/solid 不重复计数', () => {
  const quote = '「下午三点老地方见啊伙计」'
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { channel: 'core', surface: 'core', source: 'system' }),
    ev('ev_q1', 'utterance', 2, quote, { channel: 'wx', surface: 'wx' }),
    ev('ev_q2', 'utterance', 3, quote, { channel: 'wx', surface: 'wx' }),
    ev('ev_q3', 'utterance', 4, quote, { channel: 'wx', surface: 'wx' }),
  ]
  const m = deriveSelf(evs, { now: T0 + 5 * DAY_MS, viewSurface: 'bili' })
  assert.equal(m.beliefs.length, 0)
  assert.equal(m.solid.length, 0)
  assert.equal(m.facts.privacyRedacted, 3, '三条各自被删，不按 ranked+solid 重复计数')
})

test('derive：tensions / solid 也一起按 viewSurface 去引用化', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { channel: 'core', surface: 'core', source: 'system' }),
    ev('ev_a', 'utterance', 2, '我认为人应该对朋友小美毫无保留地帮忙。', { channel: 'wx', surface: 'wx' }),
    ev('ev_b', 'utterance', 3, '我不认为人应该对朋友小美毫无保留地帮忙。', { channel: 'wx', surface: 'wx' }),
  ]
  const m = deriveSelf(evs, { now: T0 + 4 * DAY_MS, viewSurface: 'bili' })
  assert.equal(m.tensions.some((t) => String(t.a.text).includes('小美') || String(t.b.text).includes('小美')), false)
  for (const b of m.solid) assert.equal(String(b.text).includes('小美'), false)
})

/* ------------------------------ bili facts ------------------------------ */

test('derive：biliSaid / biliReplies / biliThreads 只收最近 7 天、最多 5 条、不进 beliefs', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { channel: 'core', surface: 'core', source: 'system' }),
    ev('ev_said', 'utterance', 2, '这期视频讲得挺实在。', {
      channel: 'core', surface: 'bili', refs: ['BV1xx411c7mD', '1001'],
    }),
    ev('ev_reply', 'bili_reply', 3, '你说得对，我也这么觉得。', {
      channel: 'core', surface: 'bili', refs: ['BV1xx411c7mD'],
      reply: { bvid: 'BV1xx411c7mD', rpid: '2001', root: '1001', parent: '1001', user: '路人', mid: '42' },
    }),
  ]
  const m = deriveSelf(evs, { now: T0 + 4 * DAY_MS })
  assert.equal(m.facts.biliSaid.length, 1)
  assert.equal(m.facts.biliSaid[0].text, '这期视频讲得挺实在。')
  assert.equal(m.facts.biliReplies.length, 1)
  assert.equal(m.facts.biliReplies[0].reply.rpid, '2001')
  assert.equal(m.facts.biliThreads.length, 1)
  assert.equal(m.facts.biliThreads[0].bvid, 'BV1xx411c7mD')
  assert.equal(m.facts.biliThreads[0].replies.length, 1)
  // 顶层也暴露一份，B 站面提示段不用记住 facts 的层级。
  assert.deepEqual(m.biliSaid, m.facts.biliSaid)
  assert.deepEqual(m.sharedBeliefs, m.facts.sharedBeliefs)
  // 对方回复不是她的判断。
  assert.equal(m.beliefs.some((b) => b.id === 'ev_reply'), false)
})

test('derive：biliSaid 最多 5 条且只收 7 天内', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { channel: 'core', surface: 'core', source: 'system' })]
  for (let i = 1; i <= 6; i++) {
    evs.push(ev(`ev_s${i}`, 'utterance', i, `第${i}条评论。`, { channel: 'core', surface: 'bili' }))
  }
  evs.push(ev('ev_old', 'utterance', 1, '很久以前的评论。', { channel: 'core', surface: 'bili' }))
  const m = deriveSelf(evs, { now: T0 + 7 * DAY_MS })
  assert.equal(m.facts.biliSaid.length, 5)
  assert.equal(m.facts.biliSaid[0].text, '第2条评论。', '取最近 5 条（6 条新评论 + 1 条同日的旧评论）')
  const later = deriveSelf(evs, { now: T0 + 20 * DAY_MS })
  assert.equal(later.facts.biliSaid.length, 0, '超过 7 天不再算最近')
})

/* ------------------------------ selfdoc ------------------------------ */

test('身份文档：渲染时走 viewSurface=identity，微信原文不出现、纯想法保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cross-'))
  try {
    await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent(
      { type: 'utterance', channel: 'wx', surface: 'wx', text: '我闺蜜叫小美，她最近在找工作。' },
      { day: 1, stage: 1, source: 'tool' },
      root,
    )
    await appendEvent(
      { type: 'utterance', channel: 'wx', surface: 'wx', text: '我觉得人应该先照顾好自己。' },
      { day: 1, stage: 1, source: 'tool' },
      root,
    )

    const w = await writeSelfDoc(root)
    assert.equal(w.ok, true, w.why)
    const md = await readFile(selfDocPath(root), 'utf8')
    assert.equal(md.includes('小美'), false, '身份文档不被微信原文污染')
    assert.match(md, /我觉得人应该先照顾好自己/, '纯想法要能跨面进身份文档')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
