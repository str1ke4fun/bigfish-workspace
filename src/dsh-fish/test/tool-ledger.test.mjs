import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolLedger } from '../lib/tool-ledger.js'

const guard = { looksLikeSecret: (s) => ({ hit: /sk-|cookie|token/i.test(String(s ?? '')), why: '' }) }

async function tmpRoot() { return mkdtemp(join(tmpdir(), 'fish-ledger-')) }

test('成功的工具调用写一条完整台账', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard })
    const exec = { name: 'wx_context', arguments: { query: '晚上' }, agent: { session: { header: { id: 's1' } } } }
    const result = { isError: false, value: { ok: true, code: 'OK', data: { n: 3 } }, content: [{ type: 'text', text: '[翻到] 3 条' }] }
    const entry = await ledger.record(exec, result, { surface: 'wx', durationMs: 42 })
    assert.equal(entry.tool, 'wx_context')
    assert.equal(entry.ok, true)
    assert.equal(entry.durationMs, 42)
    assert.equal(entry.modelText, '[翻到] 3 条')
    const line = (await readFile(join(root, 'tool-ledger', `${entry.ts.slice(0, 10)}.jsonl`), 'utf8')).trim()
    assert.equal(JSON.parse(line).id, entry.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('失败调用也写台账，error 进 error 字段', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard })
    const entry = await ledger.record(
      { name: 'wx_send', arguments: {}, agent: { session: { header: { id: 's1' } } } },
      { isError: true, error: { message: 'boom', info: { code: 'WX_FAILED' } }, content: [{ type: 'text', text: 'Error: boom' }] },
      { surface: 'wx' },
    )
    assert.equal(entry.ok, false)
    assert.equal(entry.code, 'WX_FAILED')
    assert.match(entry.error, /boom/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('密钥被脱敏，redacted=true', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard })
    const entry = await ledger.record(
      { name: 'qq_napcat_api', arguments: { token: 'sk-123' }, agent: { session: { header: { id: 's1' } } } },
      { isError: false, value: { ok: true, data: { cookie: 'abc' } }, content: [{ type: 'text', text: 'ok' }] },
      { surface: 'qq' },
    )
    assert.equal(entry.redacted, true)
    assert.equal(JSON.stringify(entry).includes('sk-123'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('超过 32KB 的结果落 artifact，台账只留 sha256', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard, maxInlineBytes: 64 })
    const entry = await ledger.record(
      { name: 'wx_ocr', arguments: {}, agent: { session: { header: { id: 's1' } } } },
      { isError: false, value: { ok: true, data: { text: 'x'.repeat(200) } }, content: [{ type: 'text', text: 'ocr' }] },
      { surface: 'wx' },
    )
    assert.equal(typeof entry.artifact, 'string')
    assert.equal(typeof entry.bytes, 'number')
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('台账写失败不抛，只记 status', async () => {
  const root = await tmpRoot()
  try {
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'x') // 用普通文件占位，mkdir 其下必然失败
    const ledger = createToolLedger({ root: blocker, guard })
    const entry = await ledger.record({ name: 'x', arguments: {}, agent: {} }, { isError: false, value: { ok: true }, content: [] }, {})
    assert.equal(entry, null)
    assert.equal(ledger.status().failed >= 1, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
