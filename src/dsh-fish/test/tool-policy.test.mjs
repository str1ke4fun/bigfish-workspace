import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAllow, catalog, loadTargets, groupsFor } from '../lib/tool-policy.js'

const caps = { hasGui: true, hasOcr: true, hasImageRoute: true }
const CORE = ['growth_commit', 'her_recall', 'her_leave', 'her_tools']

test('web 只有 core + read_image，看不到 wx/qq/bili', () => {
  const allow = resolveAllow({ surface: 'web', caps })
  for (const n of CORE) assert.ok(allow.includes(n), n)
  assert.ok(allow.includes('read_image'))
  assert.equal(allow.some((n) => /^(wx_|qq_|bili_)/.test(n)), false)
})

test('wx 常驻是 core + 10 个常用动作，deferred 不常驻', () => {
  const allow = resolveAllow({ surface: 'wx', caps })
  for (const n of ['wx_peek', 'wx_send', 'wx_context', 'wx_task_done', 'wx_task_snooze', 'her_inbox', 'her_remind', 'her_reminders', 'her_remind_cancel', 'read_image']) {
    assert.ok(allow.includes(n), n)
  }
  assert.equal(allow.includes('wx_see'), false)
  assert.equal(allow.includes('wx_sticker_scan'), false)
  assert.equal(allow.some((n) => /^(qq_|bili_)/.test(n)), false)
})

test('revealed 组只打开该组，revealed 名字只打开该名字', () => {
  const byGroup = resolveAllow({ surface: 'wx', caps, revealed: new Set(['wx.ui']) })
  for (const n of ['wx_see', 'wx_click', 'wx_type', 'wx_key', 'wx_ocr']) assert.ok(byGroup.includes(n), n)
  assert.equal(byGroup.includes('wx_sticker_scan'), false)

  const byName = resolveAllow({ surface: 'wx', caps, revealed: new Set(['wx_history']) })
  assert.ok(byName.includes('wx_history'))
  assert.equal(byName.includes('wx_see'), false)
})

test('qq 和 bili 只看见自己的面', () => {
  const qq = resolveAllow({ surface: 'qq', caps })
  assert.ok(qq.includes('read_image'))
  assert.equal(qq.some((n) => /^(wx_|bili_)/.test(n)), false)

  // B 站 3 个对话工具从 A1.4 起由贡献表提供；没有贡献方时 bili 只剩 5 条 core。
  const bili = resolveAllow({ surface: 'bili', caps })
  for (const n of [...CORE, 'read_image']) assert.ok(bili.includes(n), n)
  assert.equal(bili.length, 5, '没有贡献时 bili 只有 coreEntries')
  for (const n of ['bili_look', 'bili_watch', 'bili_speak']) {
    assert.equal(bili.includes(n), false, `${n} 应该由贡献表提供，不在内置表里`)
  }
  assert.equal(bili.some((n) => /^(wx_|qq_)/.test(n)), false)
})

test('hostNames 过滤掉宿主没注册的名字', () => {
  const allow = resolveAllow({ surface: 'wx', caps, hostNames: new Set(['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'wx_peek', 'read_image']) })
  assert.deepEqual(allow.sort(), ['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'read_image', 'wx_peek'].sort())
})

test('能力不满足就不列（wx.ui 需要 hasGui，wx_ocr 需要 hasOcr）', () => {
  const noGui = resolveAllow({ surface: 'wx', caps: { hasGui: false, hasOcr: false, hasImageRoute: true }, revealed: new Set(['wx.ui']) })
  assert.equal(noGui.includes('wx_see'), false)
  assert.equal(noGui.includes('wx_ocr'), false)
})

test('catalog 只列当前面的 deferred，且不列宿主工具', () => {
  const cat = catalog({ surface: 'wx', caps })
  assert.ok(cat.length > 0)
  assert.equal(cat.every((e) => e.surface === 'wx' && e.tier === 'deferred'), true)
  assert.equal(cat.some((e) => e.name === 'bash' || e.name === 'write' || e.name === 'skill'), false)
  assert.equal(cat.some((e) => /^bili_/.test(e.name)), false)
})

test('loadTargets 只接受当前面的组/名字；别的面、未注册名字、宿主工具一律拒绝', () => {
  assert.equal(loadTargets({ surface: 'wx', caps, group: 'wx.ui' }).ok, true)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['wx_see'] }).ok, true)
  assert.equal(loadTargets({ surface: 'wx', caps, group: 'qq.media' }).ok, false)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['bili_look'] }).ok, false)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['bash'] }).ok, false)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['wx_not_real'] }).ok, false)
})

test('groupsFor 返回策略表里的组，不含空组', () => {
  assert.deepEqual(groupsFor('wx').sort(), ['wx.history', 'wx.stickers', 'wx.ui'])
  assert.deepEqual(groupsFor('bili'), [])
})
