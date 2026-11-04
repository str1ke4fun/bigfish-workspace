// 人物名册：node test-people.mjs
// 只测归一、别名、前缀解析和落盘；不启动微信、不读写真实名册。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULT_PEOPLE, createPeople, normalizePerson, splitPersonSuffix } from './lib/people.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const dir = () => mkdtempSync(join(tmpdir(), 'people-'))
const fileOf = (d) => join(d, 'people.json')
const T = 1000
const iso = (ms) => new Date(ms).toISOString()

console.log('名字归一')
await t('去掉所有空白并只做 ASCII 小写', async () => {
  assert.equal(normalizePerson('计科 4223　薛长顺'), '计科4223薛长顺')
  assert.equal(normalizePerson('Tina Yu'), 'tinayu')
  assert.equal(normalizePerson('  '), '')
})
await t('括号后缀拆分', async () => {
  assert.deepEqual(splitPersonSuffix('文天聪(w14973)'), { name: '文天聪', suffix: 'w14973' })
  assert.deepEqual(splitPersonSuffix('普通人'), { name: '普通人', suffix: '' })
  assert.deepEqual(splitPersonSuffix(' 文天聪（w14973） '), { name: '文天聪', suffix: 'w14973' })
})
await t('默认名册路径固定', async () => {
  assert.equal(DEFAULT_PEOPLE, '/home/str1k3/.dsh-wx/people.json')
})

console.log('学习与解析')
const d1 = dir()
const p = createPeople({ file: fileOf(d1), now: () => T })

await t('精确名字 high', async () => {
  const e = p.learn({ name: '计科4223薛长顺', source: 'preview', chatId: 'c_1' })
  assert.equal(e.key, '计科4223薛长顺')
  assert.equal(e.display, '计科4223薛长顺')
  assert.deepEqual(e.chats, ['c_1'])
  assert.deepEqual(e.sources, ['preview'])
  const r = p.resolve('计科4223薛长顺')
  assert.deepEqual(r, { name: '计科4223薛长顺', confidence: 'high', matched: true })
})

await t('没学过的短名不凭包含猜', async () => {
  const r = p.resolve('薛长顺')
  assert.deepEqual(r, { name: '薛长顺', confidence: 'low', matched: false })
})

await t('quote 短名作为别名并入已知全名', async () => {
  const e = p.learn({ name: '薛长顺', source: 'quote' })
  assert.equal(e.display, '计科4223薛长顺')
  assert.ok(e.aliases.includes('薛长顺'))
  assert.deepEqual(e.sources.sort(), ['preview', 'quote'])
  assert.deepEqual(p.resolve('薛长顺'), { name: '计科4223薛长顺', confidence: 'high', matched: true })
  assert.equal(p.all().length, 1)
})

await t('唯一前缀解析为 medium，不新建条目', async () => {
  p.learn({ name: '计科4223薛' })
  assert.equal(p.all().length, 1)
  assert.deepEqual(p.resolve('计科4223薛'), { name: '计科4223薛长顺', confidence: 'medium', matched: true })
})

await t('前缀撞名返回 low 且不匹配', async () => {
  p.learn({ name: '计科4223薛长顺2' })
  assert.equal(p.all().length, 2)
  assert.deepEqual(p.resolve('计科4223薛'), { name: '计科4223薛', confidence: 'low', matched: false })
})

await t('括号后缀进别名，主名可解析', async () => {
  p.learn({ name: '文天聪(w14973)' })
  assert.deepEqual(p.resolve('文天聪'), { name: '文天聪', confidence: 'high', matched: true })
  assert.deepEqual(p.resolve('w14973'), { name: '文天聪', confidence: 'high', matched: true })
  const e = p.entry('文天聪')
  assert.ok(e.aliases.includes('w14973'))
  assert.ok(e.aliases.includes('文天聪(w14973)'))
  assert.ok(!e.aliases.includes('文天聪'))
})

await t('entry 精确查询，未知返回 null', async () => {
  assert.equal(p.entry('没这个人'), null)
  assert.equal(p.entry('Tina Yu'), null)
})

console.log('时间与去重')
await t('firstSeenAt 只设一次，lastSeenAt 每次更新', async () => {
  let clock = T
  const pf = createPeople({ file: fileOf(dir()), now: () => clock })
  const first = pf.learn({ name: '甲' })
  assert.equal(first.firstSeenAt, iso(T))
  assert.equal(first.lastSeenAt, iso(T))
  clock = 2000
  const second = pf.learn({ name: '甲', source: 'quote', chatId: 'c_9' })
  assert.equal(second.firstSeenAt, iso(T))
  assert.equal(second.lastSeenAt, iso(2000))
  assert.deepEqual(second.sources, ['preview', 'quote'])
  assert.deepEqual(second.chats, ['c_9'])
})

await t('chats/sources/aliases 去重追加', async () => {
  const pf = createPeople({ file: fileOf(dir()), now: () => T })
  pf.learn({ name: '乙', source: 'preview', chatId: 'c_1' })
  const e = pf.learn({ name: '乙', source: 'preview', chatId: 'c_1' })
  assert.deepEqual(e.chats, ['c_1'])
  assert.deepEqual(e.sources, ['preview'])
  const e2 = pf.learn({ name: '乙', source: 'quote', chatId: 'c_2' })
  assert.deepEqual(e2.chats, ['c_1', 'c_2'])
  assert.deepEqual(e2.sources, ['preview', 'quote'])
})

console.log('校验')
await t('空名/超长/换行/冒号不学习', async () => {
  const pf = createPeople({ file: fileOf(dir()), now: () => T })
  assert.equal(pf.learn({ name: '' }), null)
  assert.equal(pf.learn({ name: '   ' }), null)
  assert.equal(pf.learn({ name: '名'.repeat(25) }), null)
  assert.equal(pf.learn({ name: '甲\n乙' }), null)
  assert.equal(pf.learn({ name: '甲:乙' }), null)
  assert.equal(pf.learn({ name: '甲：乙' }), null)
  assert.equal(pf.all().length, 0)
})

await t('OCR 任意昵称都可能，但第一次只记待确认', async () => {
  const pf = createPeople({ file: fileOf(dir()), now: () => T })
  const names = ['+e安卓4224柚厨圣', '‘ 安卓4224柚厨圣', '2午安', '张三.', '李四，', '阿依古丽·买买提', 'Anne-Marie', "O'Brien"]
  for (const name of names) assert.equal(pf.learn({ name, source: 'ocr' }), null)
  assert.equal(pf.all().length, 0)

  for (const name of names) {
    const e = pf.learn({ name, source: 'ocr', chatId: 'c_ocr' })
    assert.equal(e?.display, name)
  }
  assert.equal(pf.all().length, names.length)
})

await t('preview 一次建档并清掉 OCR 待确认', async () => {
  const pf = createPeople({ file: fileOf(dir()), now: () => T })
  assert.equal(pf.learn({ name: '张三.', source: 'ocr' }), null)
  const e = pf.learn({ name: '张三.', source: 'preview', chatId: 'c_1' })
  assert.equal(e.display, '张三.')
  // 已有条目：OCR 再次看到直接合并，不会新建，也不会先返回 null。
  const merged = pf.learn({ name: '张三.', source: 'ocr' })
  assert.equal(merged.display, '张三.')
  assert.deepEqual(merged.sources.sort(), ['ocr', 'preview'])
  assert.equal(pf.all().length, 1)
})

await t('已有条目被 OCR 看到立即合并，不用两次', async () => {
  const pf = createPeople({ file: fileOf(dir()), now: () => T })
  pf.learn({ name: '计科4223薛长顺', source: 'preview' })
  const e = pf.learn({ name: '计科4223薛长顺', source: 'ocr', chatId: 'c_1' })
  assert.equal(e.display, '计科4223薛长顺')
  assert.deepEqual(e.sources.sort(), ['ocr', 'preview'])
})

await t('不同 OCR 名字各自计数、互不影响', async () => {
  const pf = createPeople({ file: fileOf(dir()), now: () => T })
  assert.equal(pf.learn({ name: '甲怪', source: 'ocr' }), null)
  assert.equal(pf.learn({ name: '乙怪', source: 'ocr' }), null)
  assert.equal(pf.learn({ name: '甲怪', source: 'ocr' }).display, '甲怪')
  assert.equal(pf.entry('乙怪'), null)
  assert.equal(pf.learn({ name: '乙怪', source: 'ocr' }).display, '乙怪')
  assert.equal(pf.all().length, 2)
})

console.log('落盘')
await t('名册文件为 version 1，条目字段严格', async () => {
  const f = fileOf(dir())
  const pf = createPeople({ file: f, now: () => T })
  pf.learn({ name: '文天聪(w14973)', source: 'quote', chatId: 'c_1' })
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['people', 'version'])
  assert.equal(raw.version, 1)
  assert.equal(raw.people.length, 1)
  assert.deepEqual(Object.keys(raw.people[0]).sort(), [
    'aliases', 'chats', 'display', 'firstSeenAt', 'key', 'lastSeenAt', 'sources',
  ])
})

await t('名册写盘 0600', async () => {
  const f = fileOf(dir())
  const pf = createPeople({ file: f, now: () => T })
  pf.learn({ name: '甲' })
  assert.equal(statSync(f).mode & 0o777, 0o600)
})

await t('重开实例能读回名册与别名', async () => {
  const d = dir()
  const f = fileOf(d)
  const pf = createPeople({ file: f, now: () => T })
  pf.learn({ name: '计科4223薛长顺', source: 'preview', chatId: 'c_1' })
  pf.learn({ name: '薛长顺', source: 'quote' })
  pf.learn({ name: '文天聪(w14973)' })

  const again = createPeople({ file: f, now: () => 2000 })
  assert.equal(again.all().length, 2)
  assert.deepEqual(again.resolve('薛长顺'), { name: '计科4223薛长顺', confidence: 'high', matched: true })
  assert.equal(again.resolve('文天聪').name, '文天聪')
  assert.ok(again.entry('文天聪').aliases.includes('w14973'))
})

await t('坏 JSON 记日志并按空名册处理，不抛', async () => {
  const d = dir()
  const bad = join(d, 'bad.json')
  writeFileSync(bad, '{oops')
  const logs = []
  const pb = createPeople({ file: bad, log: (msg) => logs.push(String(msg)) })
  assert.equal(pb.all().length, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /名册/)
})

await t('文件不存在不记日志', async () => {
  const logs = []
  createPeople({ file: join(dir(), 'none.json'), log: (msg) => logs.push(String(msg)) })
  assert.equal(logs.length, 0)
})

await t('reload 丢弃内存状态并重读盘', async () => {
  const f = fileOf(dir())
  const pf = createPeople({ file: f, now: () => T })
  pf.learn({ name: '甲' })
  writeFileSync(f, JSON.stringify({
    version: 1,
    people: [{
      key: '乙', display: '乙', aliases: [], chats: [], sources: ['preview'],
      firstSeenAt: iso(T), lastSeenAt: iso(T),
    }],
  }))
  pf.reload()
  assert.equal(pf.all().length, 1)
  assert.equal(pf.entry('甲'), null)
  assert.equal(pf.entry('乙').display, '乙')
})

console.log(`\n${n} 项通过`)
