// 会话目录：node test-directory.mjs
// 只测合并、稳定 id、截断名解析和跨页扫描；不启动微信。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createDirectory, looksTruncated, mergeScanned, scanSidebar, stripEllipsis, uniquePrefix } from './lib/directory.js'
import { chatIdFor } from './lib/ledger.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const file = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-dir-')), 'directory.json')
const seeded = (chats) => {
  const f = file()
  writeFileSync(f, JSON.stringify({ version: 1, chats }, null, 2), 'utf8')
  return f
}
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

console.log('发送目标')
await t('exact 名字给出规范名和目录里的稳定 id', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '测试群A' }] })
  const target = d.sendableTarget('测试群A')
  assert.deepEqual(target, { chatName: '测试群A', chatId: d.entry('测试群A').chatId })
})
await t('resolved 截断名给出全名和目录 id', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '星晓家园10号楼13...' }], knownNames: ['星晓家园10号楼1301'] })
  const target = d.sendableTarget('星晓家园10号楼13...')
  assert.deepEqual(target, { chatName: '星晓家园10号楼1301', chatId: d.entry('星晓家园10号楼13...').chatId })
  assert.equal(d.entry('星晓家园10号楼13...').nameConfidence, 'resolved')
})
await t('unknown 名字不生成可绑定的聊天 id', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  assert.equal(d.sendableTarget('没见过的群'), null)
})
await t('ambiguous 名字不猜发送目标', async () => {
  const d = createDirectory({
    file: seeded([{
      chatId: 'c_ambiguous', displayName: '星晓', fullName: '星晓', aliases: [],
      nameConfidence: 'ambiguous', firstSeenAt: new Date(T).toISOString(),
    }]),
    now: () => T,
  })
  assert.equal(d.sendableTarget('星晓'), null)
  assert.equal(d.idFor('星晓'), '')
})
await t('同名 exact 条目撞在一起时，查找、发送和 idFor 都 fail closed', async () => {
  const at = new Date(T).toISOString()
  const d = createDirectory({
    file: seeded([
      { chatId: 'c_dup_a', displayName: '同名群', fullName: '同名群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
      { chatId: 'c_dup_b', displayName: '同名群', fullName: '同名群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    ]),
    now: () => T,
  })
  assert.equal(d.entry('同名群'), null)
  assert.equal(d.sendableTarget('同名群'), null)
  assert.equal(d.idFor('同名群'), '')
})
await t('合并时发现全名与旧别名复用，相关条目都标 ambiguous', async () => {
  const at = new Date(T).toISOString()
  const d = createDirectory({
    file: seeded([
      {
        chatId: 'c_old', displayName: '群甲', fullName: '群甲', aliases: ['共享名'],
        nameConfidence: 'exact', firstSeenAt: at,
      },
      {
        chatId: 'c_new', displayName: '共享名', fullName: '共享名', aliases: [],
        nameConfidence: 'exact', firstSeenAt: at,
      },
    ]),
    now: () => T,
  })
  d.merge({ chats: [{ name: '共享名' }] })
  const collided = d.all().filter((e) => [e.displayName, e.fullName, ...e.aliases].includes('共享名'))
  assert.equal(collided.length, 2)
  assert.ok(collided.every((e) => e.nameConfidence === 'ambiguous'))
  assert.equal(d.idFor('共享名'), '')
})
await t('同一页出现两个同名行时不复用第一条，标 ambiguous', async () => {
  const at = new Date(T).toISOString()
  const d = createDirectory({
    file: seeded([{
      chatId: 'c_existing', displayName: '撞名群', fullName: '撞名群', aliases: [],
      nameConfidence: 'exact', firstSeenAt: at,
    }]),
    now: () => T,
  })
  d.merge({ chats: [{ name: '撞名群' }, { name: '撞名群' }] })
  assert.equal(d.entry('撞名群'), null)
  assert.equal(d.sendableTarget('撞名群'), null)
  assert.equal(d.idFor('撞名群'), '')
  assert.ok(d.all().filter((e) => [e.displayName, e.fullName].includes('撞名群'))
    .every((e) => e.nameConfidence === 'ambiguous'))
})
await t('改名后的旧名字仍指向新规范名和同一个 id', async () => {
  const d = createDirectory({
    file: seeded([{
      chatId: 'c_renamed', displayName: '新群名', fullName: '新群名', aliases: ['旧群名'],
      nameConfidence: 'exact', firstSeenAt: new Date(T).toISOString(),
    }]),
    now: () => T,
  })
  assert.deepEqual(d.sendableTarget('旧群名'), { chatName: '新群名', chatId: 'c_renamed' })
  assert.deepEqual(d.sendableTarget('新群名'), { chatName: '新群名', chatId: 'c_renamed' })
})
await t('忽略会话只更新元数据，不写预览正文', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({
    chats: [{ name: 'Service Messages', unread: 1, preview: '系统: 不该存' }],
    ignoreChats: ['Service Messages'],
  })
  const e = d.entry('Service Messages')
  assert.equal(e.lastPreview, '')
  assert.equal(e.unread, 1)
})
await t('未读清零后仍保留最后一次非零未读', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '群A', unread: 3, preview: '张三: hi' }] })
  let e = d.entry('群A')
  assert.equal(e.unread, 3)
  assert.equal(e.lastNonZeroUnread, 3)
  assert.ok(e.lastNonZeroAt, 'lastNonZeroAt 应是非空时间')
  assert.equal(new Date(e.lastNonZeroAt).toISOString(), e.lastNonZeroAt)
  d.merge({ chats: [{ name: '群A', unread: 0, preview: '张三: hi' }] })
  e = d.entry('群A')
  assert.equal(e.unread, 0)
  assert.equal(e.lastNonZeroUnread, 3) // 清掉红点后仍保留
  assert.ok(e.lastNonZeroAt)
})
await t('再次出现未读时刷新快照时间', async () => {
  const f = file()
  const later = T + 60_000
  let clock = T
  const d = createDirectory({ file: f, now: () => clock })
  d.merge({ chats: [{ name: '群A', unread: 2 }] })
  const firstAt = d.entry('群A').lastNonZeroAt
  clock = later
  d.merge({ chats: [{ name: '群A', unread: 5 }] })
  const e = d.entry('群A')
  assert.equal(e.lastNonZeroUnread, 5)
  assert.ok(e.lastNonZeroAt > firstAt)
  assert.equal(e.lastNonZeroAt, new Date(later).toISOString())
  const again = createDirectory({ file: f, now: () => clock })
  assert.equal(again.entry('群A').lastNonZeroUnread, 5)
  assert.equal(again.entry('群A').lastNonZeroAt, new Date(later).toISOString())
})
await t('老目录文件没有新字段时按默认值读出', async () => {
  const f = file()
  writeFileSync(f, JSON.stringify({
    version: 1,
    updatedAt: new Date(T).toISOString(),
    chats: [{ chatId: chatIdFor('老群'), displayName: '老群', fullName: '老群', unread: 0 }],
  }))
  const d = createDirectory({ file: f, now: () => T })
  const e = d.entry('老群')
  assert.equal(e.lastNonZeroUnread, 0)
  assert.equal(e.lastNonZeroAt, '')
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
const row = (name, y = 100, preview = '') => ({ name, unread: 0, preview, box: { cx: 100, cy: y } })
await t('滚到底：收集多页并回到顶部', async () => {
  const pages = [
    [{ parsed: { ok: true, chats: [row('A', 100, 'A: 预览'), row('B', 220, 'B: 预览')] } }],
    [{ parsed: { ok: true, chats: [row('B', 100, 'B: 预览'), row('C', 220, 'C: 预览')] } }],
    [{ parsed: { ok: true, chats: [row('C', 100, 'C: 预览'), row('D', 220, 'D: 预览')] } }],
    [{ parsed: { ok: true, chats: [row('D', 100, 'D: 预览')] } }],
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
await t('同名会话分处两页时不被扫描去重，并让目录 fail closed', async () => {
  const pages = [
    { parsed: { ok: true, chats: [row('甲群'), row('撞名群')] } },
    { parsed: { ok: true, chats: [row('乙群'), row('撞名群')] } },
  ]
  let i = 0
  const scanned = await scanSidebar({
    read: async () => pages[Math.min(i++, pages.length - 1)],
    scroll: async () => {},
    sleep: async () => {},
    maxPages: 2,
  })
  assert.equal(scanned.ok, true)
  assert.equal(scanned.chats.filter((c) => c.name === '撞名群').length, 2)

  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: mergeScanned(scanned.chats) })
  assert.equal(d.entry('撞名群'), null)
  assert.equal(d.sendableTarget('撞名群'), null)
  assert.equal(d.idFor('撞名群'), '')
})
await t('跨页接缝的同名行没有共同身份证据时保留为撞名', async () => {
  const pages = [
    { parsed: { ok: true, chats: [row('甲群'), row('撞名群', 220)] } },
    { parsed: { ok: true, chats: [{ ...row('撞名群', 100), preview: '另一个人: 收到' }, row('乙群', 220)] } },
  ]
  let i = 0
  const scanned = await scanSidebar({
    read: async () => pages[Math.min(i++, pages.length - 1)],
    scroll: async () => {},
    sleep: async () => {},
    maxPages: 2,
  })
  assert.equal(scanned.ok, true)
  assert.deepEqual(scanned.chats.map((c) => c.name), ['甲群', '撞名群', '撞名群', '乙群'])

  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: mergeScanned(scanned.chats) })
  assert.equal(d.entry('撞名群'), null)
  assert.equal(d.sendableTarget('撞名群'), null)
})

await t('没有预览/时间的行靠邻行证据对缝，不重复收集', async () => {
  // 少说话的老会话在侧栏里既没有预览也没有时间；重叠窗口里有强证据的邻行时，
  // 它们仍是同一个会话，不能因为自己没证据就把整段重复收一遍。
  const pages = [
    { parsed: { ok: true, chats: [row('甲群', 100, '甲: 预览'), row('乙群', 220, '乙: 预览'), row('丙群', 340, '丙: 预览'), row('丁群', 460), row('戊群', 580)] } },
    { parsed: { ok: true, chats: [row('丙群', 100, '丙: 预览'), row('丁群', 220), row('戊群', 340), row('己群', 460, '己: 预览')] } },
  ]
  let i = 0
  const scanned = await scanSidebar({
    read: async () => pages[Math.min(i++, pages.length - 1)],
    scroll: async () => {},
    sleep: async () => {},
    maxPages: 2,
  })
  assert.equal(scanned.ok, true)
  assert.deepEqual(scanned.chats.map((c) => c.name), ['甲群', '乙群', '丙群', '丁群', '戊群', '己群'])
})

await t('滚到底后重复读到同一页，不会把整页再算一遍', async () => {
  const pages = [
    { parsed: { ok: true, chats: [row('甲群', 100, '甲: 预览'), row('乙群', 220, '乙: 预览'), row('丙群', 340)] } },
    { parsed: { ok: true, chats: [row('乙群', 100, '乙: 预览'), row('丙群', 220), row('丁群', 340)] } },
    // 到底滚不动：内容与上一页相同；名字照旧，不能因此变成两行。
    { parsed: { ok: true, chats: [row('乙群', 100, '乙: 预览'), row('丙群', 220), row('丁群', 340)] } },
  ]
  let i = 0
  const scanned = await scanSidebar({
    read: async () => pages[Math.min(i++, pages.length - 1)],
    scroll: async () => {},
    sleep: async () => {},
    maxPages: 4,
  })
  assert.equal(scanned.ok, true)
  assert.equal(scanned.complete, true)
  assert.deepEqual(scanned.chats.map((c) => c.name), ['甲群', '乙群', '丙群', '丁群'])

  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: mergeScanned(scanned.chats) })
  assert.equal(d.sendableName('乙群'), '乙群', '唯一的会话必须还能发')
})

const poisoned = () => {
  const f = file()
  writeFileSync(f, JSON.stringify({
    version: 1,
    chats: [
      { chatId: 'c_real01', displayName: '撞名群', fullName: '撞名群', aliases: [], kind: 'dm', nameConfidence: 'ambiguous', resolvedBy: 'duplicate-name' },
      { chatId: 'c_tmp_a1', displayName: '撞名群', fullName: '撞名群', aliases: [], kind: 'unknown', nameConfidence: 'ambiguous', resolvedBy: 'duplicate-name' },
      { chatId: 'c_tmp_a2', displayName: '撞名群', fullName: '撞名群', aliases: [], kind: 'unknown', nameConfidence: 'ambiguous', resolvedBy: 'duplicate-name' },
    ],
  }, null, 2))
  return f
}

await t('完整扫描只看到一个同名会话时，清掉重复名的临时记录并恢复可发', async () => {
  const d = createDirectory({ file: poisoned(), now: () => T })
  assert.equal(d.sendableTarget('撞名群'), null, '清理前必须是 fail closed')
  d.merge({ chats: [{ name: '撞名群', preview: '甲: 在吗' }], source: 'scan', reconcile: true })
  assert.deepEqual(d.sendableTarget('撞名群'), { chatName: '撞名群', chatId: 'c_real01' })
  assert.equal(d.all().filter((e) => e.displayName === '撞名群').length, 1)
})

await t('没拿到完整扫描证据时，重复名仍 fail closed', async () => {
  const d = createDirectory({ file: poisoned(), now: () => T })
  d.merge({ chats: [{ name: '撞名群', preview: '甲: 在吗' }], source: 'tree' })
  assert.equal(d.sendableTarget('撞名群'), null)
})

await t('两个稳定会话同名时，完整扫描只看到一次也不恢复发送', async () => {
  const f = file()
  writeFileSync(f, JSON.stringify({
    version: 1,
    chats: [
      { chatId: 'c_real01', displayName: '撞名群', fullName: '撞名群', aliases: [], kind: 'dm', nameConfidence: 'ambiguous', resolvedBy: 'duplicate-name' },
      { chatId: 'c_real02', displayName: '撞名群', fullName: '撞名群', aliases: [], kind: 'group', nameConfidence: 'ambiguous', resolvedBy: 'duplicate-name' },
    ],
  }, null, 2))
  const d = createDirectory({ file: f, now: () => T })
  d.merge({ chats: [{ name: '撞名群', preview: '甲: 在吗' }], source: 'scan', reconcile: true })
  assert.equal(d.sendableTarget('撞名群'), null, '两个稳定同名会话不能被误判成一个')
})

await t('OCR 来源只写名字，不写预览与发送者', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '某群', preview: 'ea] File Transfer 11/05' }], source: 'ocr' })
  assert.equal(d.entry('某群').lastPreview, '', 'OCR 不写预览')
  assert.equal(d.entry('某群').lastSender, null, 'OCR 不写发送者')
  d.merge({ chats: [{ name: '某群', preview: '真的预览' }], source: 'tree' })
  assert.equal(d.entry('某群').lastPreview, '真的预览', 'tree 照旧写预览')
})

console.log(`\n${n} 项通过`)
