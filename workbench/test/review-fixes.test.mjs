// 整条分支审查发现的行为契约：轮询不覆盖表单、保存要先读到配置、通道页重进后
// 继续收状态、列表按接口的真实顺序（新 → 旧）取数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8')

const bodyOf = (source, name) => {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} 存在`)
  const next = source.indexOf('\nfunction ', start + 1)
  return next < 0 ? source.slice(start) : source.slice(start, next)
}

test('微信 3 秒状态轮询不重建「允许说话」表单', () => {
  const s = read('channels/wx.js')
  assert.doesNotMatch(bodyOf(s, 'applyStatus'), /renderScopeNow/)
  // 进/回分段时才读一次表单；保存后用服务端返回的新 policy 重画。
  assert.match(s, /id === 'scope'\) loadScope\(\)/)
})

test('配置分组在读不到配置时不能保存', () => {
  const s = read('config-form.js')
  assert.match(s, /save\.disabled = true/)
  assert.match(bodyOf(s, 'setConfig'), /save\.disabled = false/)
  assert.doesNotMatch(s, /setConfig\(\{\}\)/)
})

test('观测与工具白名单读不到配置时不能保存', () => {
  const data = read('pages/system-data.js')
  assert.match(data, /observeSave\.disabled = true/)
  assert.match(bodyOf(data, 'loadObserve'), /observeSave\.disabled = false/)
  const tools = read('pages/system-tools.js')
  assert.match(tools, /saveBtn\.disabled = true/)
  assert.match(bodyOf(tools, 'refresh'), /saveBtn\.disabled = false/)
})

test('QQ 说话范围读失败时保存禁用，读成功才放开', () => {
  const s = read('channels/qq.js')
  assert.match(s, /scopeSave\.disabled = true/)
  assert.match(bodyOf(s, 'renderScope'), /scopeSave\.disabled = false/)
})

test('通道页每次进入都重新订阅状态', () => {
  for (const name of ['channels/overview.js', 'channels/qq.js', 'channels/wx.js']) {
    const s = read(name)
    assert.match(s, /onStatus\?\.\(/, `${name} 订阅状态`)
    // build 与重进各调一次 subscribe(ctx)。
    assert.ok((s.match(/subscribe\(ctx\)/g) || []).length >= 2, `${name} 重进要重新订阅`)
  }
})

test('她今天的话、信箱与判断按新到旧取最新', () => {
  const s = read('pages/her-today.js')
  assert.match(s, /const last = rows\[0\]/)
  assert.match(s, /rows\.slice\(0, 6\)/)
  assert.doesNotMatch(s, /slice\(-6\)\.reverse\(\)/)
  assert.match(s, /active\.slice\(0, 6\)/)
})

test('B 站今天：视频按天倒序里取最新 8 条，状态读不到时开关禁用', () => {
  const s = read('pages/bili-today.js')
  assert.match(s, /\[\.\.\.\(g\.items \|\| \[\]\)\]\.reverse\(\)/)
  assert.match(s, /\.slice\(0, 8\)\.map\(videoRow\)/)
  assert.match(s, /if \(!status\.ok\)[\s\S]{0,200}disabled = true/)
})

test('B 站足迹的评论保持接口的新到旧顺序', () => {
  const s = read('pages/bili-footprint.js')
  assert.doesNotMatch(s, /rows\.slice\(\)\.reverse\(\)\.map\(commentRow\)/)
  assert.match(s, /\.\.\.rows\.map\(commentRow\)/)
})
