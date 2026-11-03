// 收藏表情检索：node --test 或 node test-sticker-query.mjs
// 只测打分与文案，不启动微信、不读图。
import assert from 'node:assert/strict'

import { annotate, mergeScan, emptyIndex } from './lib/sticker-index.js'
import { confidenceOf, findStickers, formatFind, formatList, listStickers } from './lib/sticker-query.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0)
const iso = (ms) => new Date(ms).toISOString()

function sample() {
  const cells = [
    { pHash: '0f0f0f0f0f0f0f0f', sha: 'cow', pos: { row: 0, col: 0 } },
    { pHash: 'f0f0f0f0f0f0f0f0', sha: 'cat', pos: { row: 0, col: 1 } },
    { pHash: '33cc33cc33cc33cc', sha: 'dog', pos: { row: 0, col: 2 } },
  ]
  let idx = mergeScan(emptyIndex(), cells, { now: NOW }).index
  idx = annotate(idx, 'st_0f0f0f0f0f0f0f0f', {
    text: '收到', textConf: 'medium', desc: '卡通奶牛，举爪敬礼', tags: ['牛', '收到', '敬礼'],
    descConf: 'medium', source: 'bubble',
  }, { now: NOW }).index
  idx = annotate(idx, 'st_f0f0f0f0f0f0f0f0', {
    text: '', desc: '白猫歪头，不干嘛', tags: ['猫', '白猫'], descConf: 'low', source: 'panel',
  }, { now: NOW }).index
  idx = annotate(idx, 'st_33cc33cc33cc33cc', {
    text: '打劫', textConf: 'high', desc: '戴头套的狗举枪', tags: ['狗', '打劫'], descConf: 'high', source: 'manual',
  }, { now: NOW }).index
  return idx
}

console.log('置信度')
t('panel/low 标低置信，bubble/medium 标中，manual/high 标高', () => {
  const idx = sample()
  const byId = Object.fromEntries(idx.entries.map((e) => [e.id, e]))
  assert.equal(confidenceOf(byId['st_f0f0f0f0f0f0f0f0']), 'low')
  assert.equal(confidenceOf(byId['st_0f0f0f0f0f0f0f0f']), 'medium')
  assert.equal(confidenceOf(byId['st_33cc33cc33cc33cc']), 'high')
  assert.equal(confidenceOf({ descConf: 'none', textConf: 'none', source: 'none' }), 'low')
})

console.log('检索')
t('“牛 收到”先返回奶牛，并说明命中原因', () => {
  const rows = findStickers(sample(), '牛 收到')
  assert.equal(rows[0].entry.sha256, 'cow')
  const why = rows[0].reasons.join(' ')
  assert.match(why, /标签/)
  assert.match(why, /收到/)
  assert.equal(rows[0].confidence, 'medium')
})
t('图上文字、标签、描述都能单独命中', () => {
  const idx = sample()
  assert.equal(findStickers(idx, '收到')[0].entry.sha256, 'cow')
  assert.equal(findStickers(idx, '打劫')[0].entry.sha256, 'dog')
  assert.equal(findStickers(idx, '歪头')[0].entry.sha256, 'cat')
})
t('置信度低的条目照样能搜到，但带 low 标记', () => {
  const rows = findStickers(sample(), '猫')
  assert.equal(rows[0].entry.sha256, 'cat')
  assert.equal(rows[0].confidence, 'low')
})
t('没有命中就返回空，不拿不相干的凑数', () => {
  assert.deepEqual(findStickers(sample(), '量子力学'), [])
  assert.deepEqual(findStickers(sample(), ''), [])
})
t('默认不返回 stale 条目', () => {
  const idx = sample()
  const staled = mergeScan(idx, [
    { pHash: '0f0f0f0f0f0f0f0f', sha: 'cow', pos: { row: 0, col: 0 } },
  ], { now: NOW + 1000 }).index
  assert.ok(staled.entries.find((e) => e.sha256 === 'cat').stale)
  assert.ok(!findStickers(staled, '猫').some((r) => r.entry.sha256 === 'cat'))
})
t('limit 收紧，最多 10 条', () => {
  const idx = sample()
  assert.equal(findStickers(idx, '猫', { limit: 0 }).length, 1)
  assert.ok(findStickers(idx, '猫', { limit: 99 }).length <= 10)
})

console.log('列表与文案')
t('列表按最近看到排序，stale 标出来', () => {
  const idx = sample()
  const staled = mergeScan(idx, [
    { pHash: 'f0f0f0f0f0f0f0f0', sha: 'cat', pos: { row: 0, col: 0 } },
  ], { now: NOW + 5000 }).index
  const rows = listStickers(staled, { limit: 10 })
  assert.equal(rows.length, 3)
  assert.equal(rows[0].entry.sha256, 'cat')
  assert.ok(rows.some((r) => r.entry.sha256 === 'cow' && r.entry.stale))
})
t('列表文案带 id、标签、描述和置信度', () => {
  const text = formatList(sample(), listStickers(sample(), { limit: 10 }), { at: iso(NOW) })
  assert.match(text, /收藏表情索引：3 张/)
  assert.match(text, /st_0f0f0f0f0f0f0f0f/)
  assert.match(text, /奶牛/)
  assert.match(text, /medium/)
})
t('搜索文案说清命中原因，并提醒低置信只是提示', () => {
  const idx = sample()
  const text = formatFind(idx, '牛 收到', findStickers(idx, '牛 收到'))
  assert.match(text, /找到 1 张候选/)
  assert.match(text, /标签/)
  assert.match(text, /置信度：medium/)
  const low = formatFind(idx, '猫', findStickers(idx, '猫'))
  assert.match(low, /低置信|不确定|只作提示/)
})
t('没找到 / 空索引给的是下一步动作，不是编造结果', () => {
  const idx = sample()
  assert.match(formatFind(idx, '量子力学', findStickers(idx, '量子力学')), /没有找到/)
  const empty = formatFind(emptyIndex(), '牛', [])
  assert.match(empty, /wx_sticker_scan/)
})

console.log(`\n${n} 项通过`)
