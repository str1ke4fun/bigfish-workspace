/**
 * soft-deleted-bili.test.mjs —— B 站模块软删除（2026-11-12）
 *
 * A2 把 B 站实现拆到 `src/dsh-bili/lib/` 之后，dsh-fish 的 `lib/` 里还留着同一批
 * 文件。它们不再被运行时引用，文件头标了「已软删除」；这里守住两件事：
 *   1. 软删除名单里的文件仍然在（回滚对照要用），且都带标记；
 *   2. 名单外的生产代码不再 import 它们（测试可以 import，用于保留对照覆盖）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')

const SOFT_DELETED = [
  'bili', 'browse', 'browsejob', 'comment', 'cover', 'footprint', 'history', 'look',
  'ocr', 'outing', 'risk', 'speak', 'video', 'voices', 'watch',
]

test('软删除的 B 站模块还在，且文件头标了「已软删除」', () => {
  for (const name of SOFT_DELETED) {
    const src = readFileSync(join(LIB, `${name}.js`), 'utf8')
    assert.match(src.slice(0, 200), /已软删除/, `${name}.js 缺少软删除标记`)
    assert.match(src.slice(0, 400), /dsh-bili/, `${name}.js 要指向 dsh-bili`)
  }
})

test('生产代码不再 import 软删除的 B 站模块', () => {
  const pattern = new RegExp(
    `(?:from\\s*['"]\\./|import\\(\\s*['"]\\./)(${SOFT_DELETED.join('|')})\\.js['"]`,
  )
  const offenders = []
  for (const file of readdirSync(LIB)) {
    if (!file.endsWith('.js') || SOFT_DELETED.includes(file.slice(0, -3))) continue
    const src = readFileSync(join(LIB, file), 'utf8')
    if (pattern.test(src)) offenders.push(relative(ROOT, join(LIB, file)))
  }
  // 根目录入口与别的生产文件也不许引用。
  for (const file of readdirSync(ROOT)) {
    if (!file.endsWith('.js')) continue
    const src = readFileSync(join(ROOT, file), 'utf8')
    if (pattern.test(src)) offenders.push(file)
  }
  assert.deepEqual(offenders, [])
})
