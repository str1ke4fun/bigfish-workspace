import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

test('通道 DOM 搬进临时模块，补扫入口留在通道', () => {
  const legacy = read('legacy-channels.js')
  for (const id of ['qq-dot', 'wx-shot', 'speech-save', 'chat-input']) {
    assert.match(legacy, new RegExp(`id="${id}"`), id)
  }
  assert.match(read('channels.js'), /wx\/scan/)
  assert.doesNotMatch(read('pages/data.js'), /wx\/scan/)
})

test('人工代操作：按钮标注「人工」，且 QQ/微信发送前都要确认', () => {
  const legacy = read('legacy-channels.js')
  assert.match(legacy, /人工发送/)
  assert.match(legacy, /人工打字/)
  assert.match(legacy, /人工回车/)
  const channels = read('channels.js')
  assert.match(channels, /人工代操作/)
  const confirms = [...channels.matchAll(/confirm\(`人工代操作/g)]
  assert.equal(confirms.length, 3, 'QQ 发送、微信打字、微信按键各要一次确认')
})

test('主动额度与微信限流字段都在通道模块里', () => {
  const legacy = read('legacy-channels.js')
  for (const id of ['wx-proactive-perday', 'wx-proactive-chats', 'speech-wx-gap', 'speech-wx-permin', 'speech-wx-perhour']) {
    assert.match(legacy, new RegExp(`id="${id}"`), id)
  }
  const js = read('channels.js')
  assert.match(js, /proactivePerDay/)
  assert.match(js, /proactiveChats/)
  assert.match(js, /speech-wx-gap/)
  assert.match(js, /speech-wx-permin/)
  assert.match(js, /speech-wx-perhour/)
})
