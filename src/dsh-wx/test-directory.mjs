// 会话目录：node test-directory.mjs
// 只测合并、稳定 id、截断名解析和跨页扫描；不启动微信。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createDirectory, looksTruncated, mergeScanned, scanSidebar, stripEllipsis, uniquePrefix } from './lib/directory.js'
import { chatIdFor } from './lib/ledger.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const file = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-dir-')), 'directory.json')
const T = Date.UTC(2026, 10, 3, 4, 0, 0)

console.log('名字')
await t('截断尾巴识别与剥离', async () => {
  assert.equal(looksTruncated('星晓家园10号楼13...'), true)
  assert.equal(looksTruncated('星晓家园10号楼13…'), true)
  assert.equal(looksTruncated('星晓家园10号楼13'), false)
  assert.equal(stripEllipsis('星晓家园10号楼13...'), '星晓家园10号楼13')
})
await t('只在截断时做唯一前缀；撞名前缀不猜', async () => {
  assert.equal(uniquePrefix('星晓家园10号楼13...', ['星晓家园10号楼1301', '另一个群']), '星晓家园10号楼1301')
  assert.equal(uniquePrefix('星晓...', ['星晓A', '星晓B']), '')
  assert.equal(uniquePrefix('星晓家园10号楼13', ['星晓家园10号楼1301']), '')
})

console.log('合并')
await t('新名字分配 chatId；同一个名字合并后不变', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  const a = d.merge({ chats: [{ name: '测试群A', unread: 1, preview: '甲: 在吗' }] })
  const id = d.idFor('测试群A')
  assert.equal(id, chatIdFor('测试群A'))
  assert.equal(a.count, 1)
  d.merge({ chats: [{ name: '测试群A', unread: 0, preview: '乙: 收到' }] })
  assert.equal(d.idFor('测试群A'), id)
  assert.equal(d.entry('测试群A').unread, 0)
  assert.equal(d.entry('测试群A').lastSender, '乙')
})
await t('截断名先给临时 id；解析成全名后保留原 id（台账不换账本名）', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '星晓家园10号楼13...' }] })
  const tempId = d.idFor('星晓家园10号楼13...')
  assert.match(tempId, /^c_tmp_/)
  assert.equal(d.sendableName('星晓家园10号楼13...'), '')
  d.merge({ chats: [{ name: '星晓家园10号楼13...' }], knownNames: ['星晓家园10号楼1301'] })
  const e = d.entry('星晓家园10号楼13...')
  assert.equal(e.fullName, '星晓家园10号楼1301')
  assert.equal(e.nameConfidence, 'resolved')
  assert.equal(e.chatId, tempId)
  assert.equal(d.idFor('星晓家园10号楼1301'), tempId)
  assert.equal(d.sendableName('星晓家园10号楼1301'), '星晓家园10号楼1301')
})
await t('当前会话是全名时，可以反向解析侧栏截断行', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '星晓家园10号楼13...' }, { name: '别的群' }] })
  d.merge({ chats: [], current: '星晓家园10号楼1301' })
  assert.equal(d.entry('星晓家园10号楼13...').fullName, '星晓家园10号楼1301')
})
await t('私聊名单标记 kind=dm；群聊按预览猜 kind', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '大白饭', preview: '吃了吗' }, { name: '测试群A', preview: '甲: 在吗' }], directNames: ['大白饭'] })
  assert.equal(d.entry('大白饭').kind, 'dm')
  assert.equal(d.entry('测试群A').kind, 'group')
})
await t('目录写盘 0600，重开一个实例能读回', async () => {
  const f = file()
  const d = createDirectory({ file: f, now: () => T })
  d.merge({ chats: [{ name: '测试群A' }] })
  const again = createDirectory({ file: f, now: () => T })
  assert.equal(again.idFor('测试群A'), d.idFor('测试群A'))
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.chats.length, 1)
})

console.log('跨页扫描')
const row = (name, y = 100) => ({ name, unread: 0, preview: '', box: { cx: 100, cy: y } })
await t('滚到底：收集多页并回到顶部', async () => {
  const pages = [
    [{ parsed: { ok: true, chats: [row('A'), row('B')] } }],
    [{ parsed: { ok: true, chats: [row('B'), row('C')] } }],
    [{ parsed: { ok: true, chats: [row('C'), row('D')] } }],
    [{ parsed: { ok: true, chats: [row('D')] } }],
  ]
  let i = 0
  const scrolls = []
  const r = await scanSidebar({
    read: async () => pages[Math.min(i++, pages.length - 1)][0],
    scroll: async (s) => { scrolls.push(s.direction) },
    sleep: async () => {},
    maxPages: 8,
  })
  assert.equal(r.ok, true)
  assert.equal(r.complete, true)
  assert.deepEqual(r.chats.map((c) => c.name), ['A', 'B', 'C', 'D'])
  assert.deepEqual([...new Set(scrolls)], ['down', 'up'])
})
await t('有草稿就不滚（避免丢草稿）', async () => {
  const r = await scanSidebar({
    read: async () => ({ parsed: { ok: true, chats: [{ name: 'A', draft: true }] } }),
    scroll: async () => { throw new Error('不该滚') },
    sleep: async () => {},
  })
  assert.equal(r.ok, false)
  assert.match(r.why, /草稿/)
})
await t('多页去重：截断名与全名保留全名', async () => {
  const merged = mergeScanned([{ name: '星晓家园10号楼13...' }, { name: '星晓家园10号楼1301' }, { name: '别的群' }])
  assert.deepEqual(merged.map((c) => c.name), ['星晓家园10号楼1301', '别的群'])
})

console.log(`\n${n} 项通过`)
