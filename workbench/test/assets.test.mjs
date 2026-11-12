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

test('微信会话目录补扫放在通道页，数据页不再重复入口', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /id="wx-scan"/)
  assert.match(read('channels.js'), /wx\/scan/)
  assert.doesNotMatch(read('pages/data.js'), /wx\/scan/)
})

test('人工代操作：按钮标注「人工」，且 QQ/微信发送前都要确认', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /人工发送/)
  assert.match(html, /人工打字/)
  assert.match(html, /人工回车/)
  const channels = read('channels.js')
  assert.match(channels, /人工代操作/)
  const confirms = [...channels.matchAll(/confirm\(`人工代操作/g)]
  assert.equal(confirms.length, 3, 'QQ 发送、微信打字、微信按键各要一次确认')
})
