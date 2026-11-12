import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8')

test('[hidden] 必须真的藏起来（main 的 display:grid 会盖掉浏览器默认规则）', () => {
  assert.match(read('app.css'), /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/)
})

test('八项导航与八个 main 一一对应', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const nav = [...html.matchAll(/<button data-page="([^"]+)"/g)].map((m) => m[1])
  const mains = [...html.matchAll(/<main data-page="([^"]+)"/g)].map((m) => m[1])
  assert.equal(nav.length, 8)
  assert.deepEqual(mains, nav)
})

test('每个页面模块都声明了对应的 id', () => {
  for (const id of ['overview', 'bili', 'memory', 'env', 'tools', 'data', 'principles']) {
    assert.match(read(`pages/${id}.js`), new RegExp(`id:\\s*'${id}'`), `${id}.js 的 id`)
  }
})
