/**
 * A0 依赖边界：core 里的插件桥（owner）不得反向依赖 B 站代码，
 * derive 与 voices 不得互相 import（两者的公共部分已搬到 similarity.js）。
 *
 * 只读源码文本，不加载模块——这条边界是对文件依赖图的约束，不是运行时行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')
const importsOf = (file, target) => new RegExp(`from ['"]\\./${target}['"]`).test(src(file))

test('A0: owner 不再依赖 bili', () => {
  assert.equal(importsOf('owner.js', 'bili.js'), false)
})

test('A0: derive 与 voices 不再互相依赖', () => {
  assert.equal(importsOf('derive.js', 'voices.js'), false)
  assert.equal(importsOf('voices.js', 'derive.js'), false)
})

test('A0: 两边都改从 similarity.js 取公共函数', () => {
  assert.equal(importsOf('derive.js', 'similarity.js'), true)
  assert.equal(importsOf('voices.js', 'similarity.js'), true)
})
