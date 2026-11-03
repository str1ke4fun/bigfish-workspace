// 台账分层存储：node test-archive.mjs
// 只测归档计划、复制校验、移走与归档后的读取；不删除任何东西。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { archiveFile, archiveLedger, archivedFileOf, ledgerFiles, monthEndMs, planArchive } from './lib/archive.js'
import { createLedger } from './lib/ledger.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const dir = () => mkdtempSync(join(tmpdir(), 'dsh-wx-archive-'))

const line = (text) => JSON.stringify({ v: 1, msgId: 'm_' + text, chatId: 'c1', sender: '甲', kind: 'text', text, at: '2026-07-01T00:00:00Z' }) + '\n'

console.log('计划')
t('只归档整月已早于保留期的文件', () => {
  const d = dir()
  writeFileSync(join(d, 'c1-2026-06.jsonl'), line('六月'))
  writeFileSync(join(d, 'c1-2026-09.jsonl'), line('九月'))
  writeFileSync(join(d, 'notes.txt'), 'x')
  const now = Date.UTC(2026, 10, 3)
  const plan = planArchive({ dir: d, now, retentionDays: 90 })
  assert.deepEqual(plan.map((x) => x.month), ['2026-06'])
  assert.equal(ledgerFiles(d).length, 2)
})
t('月份结束时间按 UTC 算', () => {
  assert.equal(monthEndMs('2026-02'), Date.UTC(2026, 2, 1) - 1)
  assert.ok(Number.isNaN(monthEndMs('2026-2')))
})

console.log('归档')
t('复制 → 校验行数 → 移走；内容一字不差', () => {
  const d = dir()
  const src = join(d, 'c1-2026-06.jsonl')
  const raw = line('一') + line('二')
  writeFileSync(src, raw)
  const r = archiveFile({ file: src, archiveDir: join(d, 'archive') })
  assert.equal(r.ok, true)
  assert.ok(!existsSync(src))
  assert.equal(readFileSync(join(d, 'archive', 'c1-2026-06.jsonl'), 'utf8'), raw)
  assert.equal(r.lines, 2)
  assert.equal(archivedFileOf(d, 'c1', '2026-06'), join(d, 'archive', 'c1-2026-06.jsonl'))
})
t('目标已存在且内容不同 → 拒绝覆盖，原文件保留', () => {
  const d = dir()
  const src = join(d, 'c1-2026-06.jsonl')
  writeFileSync(src, line('新'))
  mkdirSync(join(d, 'archive'), { recursive: true })
  writeFileSync(join(d, 'archive', 'c1-2026-06.jsonl'), line('旧'))
  const r = archiveFile({ file: src, archiveDir: join(d, 'archive') })
  assert.equal(r.ok, false)
  assert.match(r.why, /内容不同/)
  assert.ok(existsSync(src))
})
t('目标已存在且内容相同 → 允许，原文件移走', () => {
  const d = dir()
  const src = join(d, 'c1-2026-06.jsonl')
  const raw = line('同')
  writeFileSync(src, raw)
  mkdirSync(join(d, 'archive'), { recursive: true })
  writeFileSync(join(d, 'archive', 'c1-2026-06.jsonl'), raw)
  const r = archiveFile({ file: src, archiveDir: join(d, 'archive') })
  assert.equal(r.ok, true)
  assert.ok(!existsSync(src))
})
t('批量归档：成功和失败都报出来，不静默', () => {
  const d = dir()
  writeFileSync(join(d, 'c1-2026-06.jsonl'), line('旧'))
  writeFileSync(join(d, 'c1-2026-07.jsonl'), line('也旧'))
  const r = archiveLedger({ dir: d, now: Date.UTC(2026, 10, 3), retentionDays: 90 })
  assert.equal(r.planned, 2)
  assert.equal(r.archived.length, 2)
  assert.equal(r.failed.length, 0)
  assert.equal(existsSync(join(d, 'c1-2026-06.jsonl')), false)
})

console.log('归档后的读取')
t('台账热文件没了，仍能从 archive 读回并继续追加', () => {
  const d = dir()
  const ledgerDir = join(d, 'ledger')
  const l = createLedger({ dir: ledgerDir, now: () => Date.parse('2026-07-02T00:00:00Z') })
  l.append('c1', [{ sender: '甲', text: '六月的话', at: '2026-07-01T00:00:00Z' }])
  const r = archiveLedger({ dir: ledgerDir, now: Date.UTC(2026, 10, 3), retentionDays: 90 })
  assert.equal(r.archived.length, 1)
  const again = createLedger({ dir: ledgerDir, now: () => Date.parse('2026-11-03T00:00:00Z') })
  assert.deepEqual(again.recent('c1', 5).map((x) => x.text), ['六月的话'])
  again.append('c1', [{ sender: '甲', text: '十一月的话', at: '2026-11-03T00:00:00Z' }])
  assert.deepEqual(again.recent('c1', 5).map((x) => x.text), ['六月的话', '十一月的话'])
  assert.ok(existsSync(join(ledgerDir, 'c1-2026-11.jsonl')))
  assert.equal(again.chats().includes('c1'), true)
})

console.log(`\n${n} 项通过`)
