import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { qq } from '../assets/channels/qq.js'

test('QQ 适配器契约', () => {
  assert.equal(qq.id, 'qq')
  assert.equal(qq.order, 10)
  for (const f of ['badge', 'summary', 'renderPanel', 'refresh', 'leave']) assert.equal(typeof qq[f], 'function')
  assert.deepEqual(qq.humanActions, ['send'])
})
test('QQ 人工发送有确认与人工标记', () => {
  const s = readFileSync(new URL('../assets/channels/qq.js', import.meta.url), 'utf8')
  assert.match(s, /confirmHuman\(/)
  assert.match(s, /人工发送/)
  assert.match(s, /humanChip\(\)/)
  assert.match(s, /\/api\/qq\/send/)
  assert.doesNotMatch(s, /innerHTML/)
  const srv = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(srv, /operator:\s*'human'/)
  assert.match(srv, /channel:\s*'qq'/)
  assert.match(srv, /channel:\s*'wx'/)
})

import { wx } from '../assets/channels/wx.js'

test('微信适配器保留画面与人工代操作', () => {
  const s = readFileSync(new URL('../assets/channels/wx.js', import.meta.url), 'utf8')
  assert.equal(wx.id, 'wx')
  assert.equal(wx.order, 20)
  for (const p of ['/api/wx/frame.jpg', '/api/wx/click', '/api/wx/type', '/api/wx/key',
    '/api/wx/scope', '/api/wx/save', '/api/wx/peek', '/api/wx/close-extra',
    '/api/fish/wx/scan', '/api/gc']) assert.ok(s.includes(p), p)
  assert.match(s, /confirmHuman\(/)
  assert.match(s, /humanActions:\s*\['type',\s*'key'\]/)
  assert.match(s, /clearInterval/)
  assert.doesNotMatch(s, /innerHTML/)
})

import { CHANNELS } from '../assets/channels/registry.js'

test('通道注册表按 order 排序', () => {
  assert.deepEqual(CHANNELS.map((c) => c.id), ['qq', 'wx'])
})
test('总览遍历注册表，不写死 QQ / 微信', () => {
  const s = readFileSync(new URL('../assets/channels/overview.js', import.meta.url), 'utf8')
  assert.match(s, /CHANNELS\.map|for\s*\(const\s+\w+\s+of\s+CHANNELS\)/)
  assert.doesNotMatch(s, /if\s*\(\s*(id|ch)\.id\s*===\s*'qq'/)
  assert.match(s, /renderSpeechCard/)
  assert.match(s, /\/api\/status\.log/)
})
test('说话节奏是共享模块，键扁平', () => {
  const s = readFileSync(new URL('../assets/channels/speech.js', import.meta.url), 'utf8')
  for (const k of ['enabled', 'minGapSeconds', 'maxPerMinute', 'maxPerHour']) assert.ok(s.includes(k), k)
  assert.match(s, /\/api\/speech/)
  assert.doesNotMatch(s, /speech\.enabled|speech\.minGapSeconds/)
})
