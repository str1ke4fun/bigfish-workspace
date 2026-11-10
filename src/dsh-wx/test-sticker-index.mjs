// 收藏表情索引的存储与合并：node --test 或 node test-sticker-index.mjs
// 只碰临时目录，不启动微信、不读真实截图。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ART_HAMMING, INDEX_VERSION, annotate, emptyIndex, findEntry, loadIndex, matchEntry, mergeScan,
  pruneStale, saveIndex, thumbPath,
} from './lib/sticker-index.js'
import { hamming } from './lib/sticker-image.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0)
const iso = (ms) => new Date(ms).toISOString()

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-sticker-'))
const HASHES = [
  '0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0', '33cc33cc33cc33cc', 'cc33cc33cc33cc33',
  '5555aaaa5555aaaa', 'aaaa5555aaaa5555', '00ff00ff00ff00ff', 'ff00ff00ff00ff00',
]
const hash = (i) => HASHES[i % HASHES.length]
const cell = (i, pos, extra = {}) => ({ pHash: hash(i), sha: `sha-${i}`, pos, ...extra })
const seven = () => Array.from({ length: 7 }, (_, i) => cell(i, { row: Math.floor(i / 5), col: i % 5 }))

console.log('索引文件')
t('空索引有版本和面板参数', () => {
  const idx = emptyIndex()
  assert.equal(idx.v, INDEX_VERSION)
  assert.equal(idx.panel.w, 485)
  assert.deepEqual(idx.entries, [])
})
t('保存是原子替换，目录里不留临时文件', () => {
  const dir = tmp()
  try {
    saveIndex(dir, { ...emptyIndex(), entries: [] })
    const files = readdirSync(dir)
    assert.deepEqual(files.sort(), ['index.json', 'thumbs'])
    assert.ok(!files.some((f) => f.endsWith('.tmp')))
    assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).v, INDEX_VERSION)
    assert.equal(statSync(join(dir, 'index.json')).mode & 0o777, 0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
t('坏文件回退为空索引，不抛错覆盖现场', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'index.json'), '{ not json')
    const r = loadIndex(dir)
    assert.equal(r.recovered, true)
    assert.deepEqual(r.index.entries, [])
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), '{ not json')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
t('读回保存的索引', () => {
  const dir = tmp()
  try {
    const idx = mergeScan(emptyIndex(), seven(), { now: NOW }).index
    saveIndex(dir, idx)
    const r = loadIndex(dir)
    assert.equal(r.recovered, false)
    assert.equal(r.index.entries.length, 7)
    assert.equal(r.index.entries[0].pHash, idx.entries[0].pHash)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('合并')
t('首次扫描新增 7 条，id 由 pHash 生成', () => {
  const r = mergeScan(emptyIndex(), seven(), { now: NOW })
  assert.equal(r.added, 7)
  assert.equal(r.matched, 0)
  assert.equal(r.index.entries.length, 7)
  const e = r.index.entries[0]
  assert.equal(e.id, 'st_' + hash(0))
  assert.equal(e.thumb, thumbPath('', e.id).replace(/^\//, ''))
  assert.equal(e.firstSeen, iso(NOW))
  assert.equal(e.lastSeen, iso(NOW))
  assert.equal(e.stale, false)
  assert.deepEqual(e.pos, { row: 0, col: 0, order: 0 })
})
t('顺序变了、位置变了，仍按 pHash 认回同一张', () => {
  const first = mergeScan(emptyIndex(), seven(), { now: NOW }).index
  // 新收藏插到第一位：原来的 0 号挪到第 2 位
  const moved = seven().map((c, i) => cell(i, { row: 0, col: (i + 2) % 5 }))
  const r = mergeScan(first, moved, { now: NOW + 60_000 })
  assert.equal(r.added, 0)
  assert.equal(r.matched, 7)
  assert.equal(r.index.entries.length, 7)
  const e = r.index.entries.find((x) => x.id === 'st_' + hash(0))
  assert.equal(e.pos.col, 2)
  assert.equal(e.lastSeen, iso(NOW + 60_000))
})
t('pHash 距离 ≤ 6 算同一张；> 6 算新的', () => {
  const first = mergeScan(emptyIndex(), [cell(0, { row: 0, col: 0 })], { now: NOW }).index
  const near = { ...cell(0, { row: 0, col: 0 }), pHash: hash(0).slice(0, 15) + 'e', sha: 'sha-new' }
  assert.ok(hamming(hash(0), near.pHash) <= 6)
  const r1 = mergeScan(first, [near], { now: NOW + 1000 })
  assert.equal(r1.added, 0)
  assert.equal(r1.matched, 1)
  const far = { ...cell(0, { row: 0, col: 1 }), pHash: '5fffffffffffffff', sha: 'sha-far' }
  const r2 = mergeScan(first, [far], { now: NOW + 2000 })
  assert.equal(r2.added, 1)
  assert.equal(r2.index.entries.length, 2)
})
t('sha256 完全一致时，即使 pHash 差得远也认回', () => {
  const first = mergeScan(emptyIndex(), [cell(0, { row: 0, col: 0 })], { now: NOW }).index
  const same = { pHash: 'ffffffffffffffff', sha: 'sha-0', pos: { row: 1, col: 0 } }
  const r = mergeScan(first, [same], { now: NOW + 1000 })
  assert.equal(r.added, 0)
  assert.equal(r.matched, 1)
  assert.equal(r.index.entries[0].pos.row, 1)
})
t('这轮没见到的条目标 stale，不删；重新出现就恢复', () => {
  const first = mergeScan(emptyIndex(), seven(), { now: NOW }).index
  const r = mergeScan(first, seven().slice(0, 6), { now: NOW + 60_000 })
  const gone = r.index.entries.find((e) => e.pHash === hash(6))
  assert.equal(gone.stale, true)
  assert.equal(gone.staleSince, iso(NOW + 60_000))
  assert.equal(r.stale, 1)
  const back = mergeScan(r.index, seven(), { now: NOW + 120_000 })
  const e = back.index.entries.find((x) => x.pHash === hash(6))
  assert.equal(e.stale, false)
  assert.equal(e.staleSince, null)
})
t('空扫描不把整个索引标失效（切错页签/读图失败时保命）', () => {
  const first = mergeScan(emptyIndex(), seven(), { now: NOW }).index
  const r = mergeScan(first, [], { now: NOW + 1000 })
  assert.equal(r.skipped, true)
  assert.equal(r.stale, 0)
  assert.ok(r.index.entries.every((e) => !e.stale))
})
t('同一张表情在一屏里出现两次，只算一条（pHash 是身份）', () => {
  const a = cell(0, { row: 0, col: 0 })
  const b = { ...cell(0, { row: 0, col: 1 }), sha: 'sha-other' }
  const r = mergeScan(emptyIndex(), [a, b], { now: NOW })
  assert.equal(r.index.entries.length, 1)
})
t('matchEntry 优先精确 sha，再取最近的 pHash', () => {
  const idx = mergeScan(emptyIndex(), seven(), { now: NOW }).index
  assert.equal(matchEntry(idx.entries, { sha: 'sha-3', pHash: 'ffffffffffffffff' }).pHash, hash(3))
  assert.equal(matchEntry(idx.entries, { sha: 'nope', pHash: hash(4) }).pHash, hash(4))
  assert.equal(matchEntry(idx.entries, { sha: 'nope', pHash: 'ffffffffffffffff' }), null)
})
t('pHash 换帧后对不上，但 artHash 距离 ≤ 6：仍算同一张（动画表情兜底）', () => {
  const near = (h) => h.slice(0, -1) + (h.endsWith('e') ? 'f' : 'e')
  const first = mergeScan(emptyIndex(), [
    { ...cell(0, { row: 0, col: 0 }), artHash: hash(2) },
  ], { now: NOW }).index
  assert.ok(hamming(hash(2), near(hash(2))) <= ART_HAMMING)
  const changed = {
    pHash: '5fffffffffffffff', sha: 'sha-frame-2', artHash: near(hash(2)), pos: { row: 0, col: 1 },
  }
  const hit = matchEntry(first.entries, changed)
  assert.equal(hit?.id, 'st_' + hash(0))
  const r = mergeScan(first, [changed], { now: NOW + 1000 })
  assert.equal(r.added, 0)
  assert.equal(r.matched, 1)
  assert.equal(r.index.entries.length, 1)
  assert.equal(r.index.entries[0].artHash, near(hash(2)))
  assert.deepEqual(r.index.entries[0].pos, { row: 0, col: 1, order: 1 })
})
t('artHash 也对不上：仍算新条目，不硬合并', () => {
  const first = mergeScan(emptyIndex(), [
    { ...cell(0, { row: 0, col: 0 }), artHash: hash(2) },
  ], { now: NOW }).index
  const other = {
    pHash: '5fffffffffffffff', sha: 'sha-other', artHash: hash(5), pos: { row: 0, col: 1 },
  }
  assert.ok(hamming(hash(2), hash(5)) > ART_HAMMING)
  assert.equal(matchEntry(first.entries, other), null)
  const r = mergeScan(first, [other], { now: NOW + 1000 })
  assert.equal(r.added, 1)
  assert.equal(r.index.entries.length, 2)
})
t('claimed：同一轮扫描里一条索引最多认一个格子', () => {
  const idx = mergeScan(emptyIndex(), seven(), { now: NOW }).index
  const claimed = new Set(['st_' + hash(0)])
  assert.equal(matchEntry(idx.entries, { pHash: hash(0), artHash: '' }, { claimed }), null)
  assert.equal(matchEntry(idx.entries, { pHash: hash(1), artHash: '' }, { claimed }).id, 'st_' + hash(1))
})

console.log('stale 重复合并')
function legacyEntry(id, { pHash, artHash, stale = false, extra = {} }) {
  return {
    id, pHash, artHash, sha256: '', thumb: `thumbs/${id}.png`,
    pos: { row: 0, col: 0, order: 0 }, text: '', textConf: 'none', desc: '', tags: [],
    descConf: 'none', source: 'none', firstSeen: '', lastSeen: '',
    stale, staleSince: stale ? iso(NOW) : null, updatedAt: null, aliases: [], ...extra,
  }
}
t('stale 旧 id 与当前条目是同一张：元数据并入、旧 id 记别名、不重复计数', () => {
  const near = (h) => h.slice(0, -1) + (h.endsWith('e') ? 'f' : 'e')
  const active = legacyEntry('st_new', { pHash: hash(1), artHash: hash(2), extra: { tags: ['新'] } })
  const stale = legacyEntry('st_old', {
    pHash: hash(3), artHash: near(hash(2)), stale: true,
    extra: { tags: ['旧', '猫'], text: '喔唷', textConf: 'high', desc: '白猫', descConf: 'medium', firstSeen: iso(NOW - 86_400_000) },
  })
  const index = { ...emptyIndex(), entries: [active, stale] }
  const cellNow = { pHash: hash(1), artHash: hash(2), pos: { row: 0, col: 0 } }
  const r = mergeScan(index, [cellNow], { now: NOW + 1000 })
  assert.equal(r.matched, 1)
  assert.equal(r.added, 0)
  assert.equal(r.merged, 1)
  assert.equal(r.index.entries.length, 1)
  const e = r.index.entries[0]
  assert.equal(e.id, 'st_new')
  assert.deepEqual(e.aliases, ['st_old'])
  assert.deepEqual(e.tags, ['新', '旧', '猫'])
  assert.equal(e.text, '喔唷')
  assert.equal(e.desc, '白猫')
  assert.equal(e.firstSeen, iso(NOW - 86_400_000))
  assert.equal(findEntry(r.index, 'st_old')?.id, 'st_new')
})
t('stale 但 artHash 差得远：不合并，保留为独立条目', () => {
  const active = legacyEntry('st_new', { pHash: hash(1), artHash: hash(2) })
  const stale = legacyEntry('st_old', { pHash: hash(3), artHash: hash(5), stale: true })
  const index = { ...emptyIndex(), entries: [active, stale] }
  const cellNow = { pHash: hash(1), artHash: hash(2), pos: { row: 0, col: 0 } }
  const r = mergeScan(index, [cellNow], { now: NOW + 1000 })
  assert.equal(r.merged, 0)
  assert.equal(r.index.entries.length, 2)
  assert.ok(r.index.entries.find((e) => e.id === 'st_old'))
})

console.log('人工标签与清理')
t('补标签只改派生索引，字段受控', () => {
  const idx = mergeScan(emptyIndex(), seven(), { now: NOW }).index
  const id = 'st_' + hash(1)
  const r = annotate(idx, id, { text: '收到', textConf: 'medium', desc: '卡通奶牛，举爪敬礼', tags: ['牛', '收到', ' 牛 '], descConf: 'medium', source: 'manual' }, { now: NOW + 1000 })
  const e = r.entry
  assert.equal(e.text, '收到')
  assert.deepEqual(e.tags, ['牛', '收到'])
  assert.equal(e.descConf, 'medium')
  assert.equal(e.source, 'manual')
  assert.equal(e.updatedAt, iso(NOW + 1000))
  assert.throws(() => annotate(idx, 'st_nope', { tags: ['x'] }))
  assert.throws(() => annotate(idx, id, { descConf: 'certain' }))
})
t('旧 id 作为别名仍能补标签', () => {
  const active = legacyEntry('st_new', { pHash: hash(1), artHash: hash(2), extra: { aliases: ['st_old'] } })
  const idx = { ...emptyIndex(), entries: [active] }
  assert.equal(findEntry(idx, 'st_old')?.id, 'st_new')
  const r = annotate(idx, 'st_old', { tags: ['旧称呼'] }, { now: NOW + 1000 })
  assert.equal(r.entry.id, 'st_new')
  assert.deepEqual(r.entry.tags, ['旧称呼'])
})
t('stale 超过 30 天才清理', () => {
  const first = mergeScan(emptyIndex(), seven(), { now: NOW }).index
  const staled = mergeScan(first, seven().slice(0, 6), { now: NOW + 60_000 }).index
  assert.equal(pruneStale(staled, { now: NOW + 29 * 86_400_000 }).removed, 0)
  assert.equal(pruneStale(staled, { now: NOW + 31 * 86_400_000 }).removed, 1)
})

console.log(`\n${n} 项通过`)
