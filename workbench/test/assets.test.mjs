import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const read = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8')
const html = () => readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('[hidden] 必须真的藏起来（页面网格会盖掉浏览器默认规则）', () => {
  assert.match(read('app.css'), /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/)
})

test('外壳只有导航、页签和挂载点', () => {
  const page = html()
  for (const id of ['view', 'nav', 'subtabs', 'theme-toggle', 'open-her']) {
    assert.match(page, new RegExp(`id="${id}"`), id)
  }
  assert.ok(page.indexOf('/assets/app.js') > 0)
  assert.ok(page.indexOf('/assets/app.js') < page.indexOf('</body>'))
  for (const old of ['id="qq-dot"', 'id="wx-shot"', 'id="speech-save"', 'id="chat-input"', 'data-page="overview"', '<main data-page=']) {
    assert.ok(!page.includes(old), old)
  }
})

test('theme-boot 在样式表之前同步执行', () => {
  const page = html()
  const boot = page.indexOf('theme-boot.js')
  assert.ok(boot > 0, 'theme-boot.js')
  assert.ok(boot < page.indexOf('theme.css'), 'theme-boot 先于 theme.css')
  assert.ok(boot < page.indexOf('app.css'), 'theme-boot 先于 app.css')
})

test('通道拆成注册表模块，旧外壳不再被引用', () => {
  const registry = read('channels/registry.js')
  assert.match(registry, /export const CHANNELS/)
  assert.match(read('channels/overview.js'), /CHANNELS/)
  assert.match(read('channels/wx.js'), /wx\/scan/)
  assert.doesNotMatch(read('pages/data.js'), /wx\/scan/)
  const nav = read('nav.js')
  assert.doesNotMatch(nav, /legacy-channels/)
  assert.doesNotMatch(html(), /legacy-channels/)
})

test('人工代操作：按钮标注「人工」，且 QQ/微信发送前都要确认', () => {
  assert.match(read('channels/shared.js'), /confirm\(`人工代操作/)
  const calls = (read('channels/qq.js') + read('channels/wx.js')).match(/confirmHuman\(/g) || []
  assert.equal(calls.length, 3, 'QQ 发送、微信打字、微信按键各要一次确认')
  for (const name of ['channels/qq.js', 'channels/wx.js']) {
    assert.match(read(name), /humanChip\(\)/, name)
  }
})

const list = (dir) => readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => f.endsWith('.js'))

test('新页面与新通道没有 innerHTML', () => {
  const files = [...list('assets/pages').map((f) => 'pages/' + f), 'app.js', 'nav.js', 'config-form.js',
    ...list('assets/channels').map((f) => 'channels/' + f)]
  for (const f of files) assert.doesNotMatch(read(f), /innerHTML/, f)
})

test('窄屏与长文本有兜底', () => {
  const css = read('app.css')
  assert.match(css, /@media\s*\(max-width:\s*900px\)/)
  assert.match(css, /overflow-wrap:\s*anywhere/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
})

test('旧文件只保留、不被新外壳或新页面引用', () => {
  const app = read('app.js') + read('nav.js')
  const pages = list('assets/pages').map((f) => read('pages/' + f)).join('\n')
  for (const old of ['pages/overview.js', 'pages/bili.js', 'pages/memory.js', 'pages/env.js',
    'pages/tools.js', 'pages/data.js', 'pages/principles.js', 'channels.js']) {
    const re = new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    assert.doesNotMatch(app, re)
    assert.doesNotMatch(pages, re)
  }
})
