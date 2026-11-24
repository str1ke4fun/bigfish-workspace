import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAllow, catalog, loadTargets, groupsFor, describeEntry } from '../lib/tool-policy.js'

const caps = { hasGui: true, hasOcr: true, hasImageRoute: true }
const CORE = ['growth_commit', 'her_recall', 'her_leave', 'her_tools']

test('全部面的常驻与按需可见矩阵不变', () => {
  const expectedAllow = {
    web: ['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'read_image'],
    wx: [
      'growth_commit', 'her_recall', 'her_leave', 'her_tools', 'read_image',
      'wx_peek', 'wx_send', 'wx_context', 'wx_task_done', 'wx_task_snooze',
      'her_inbox', 'her_remind', 'her_reminders', 'her_remind_cancel',
      'her_work', 'her_work_status',
    ],
    qq: ['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'read_image'],
    bili: ['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'read_image'],
    screen: ['growth_commit', 'read_image', 'her_recall', 'look_screen', 'her_work', 'her_work_status'],
    work: ['her_worker', 'her_worker_control', 'her_ask_user', 'growth_commit', 'her_recall', 'todo_write'],
  }
  const expectedCatalog = {
    web: [],
    wx: [
      'wx_see', 'wx_click', 'wx_type', 'wx_key', 'wx_ocr',
      'wx_sticker_scan', 'wx_sticker_list', 'wx_sticker_find', 'wx_sticker_tag',
      'wx_sticker_send', 'wx_sticker_collect', 'wx_sticker_search', 'wx_history',
    ],
    qq: [
      'qq_send_image', 'qq_send_voice', 'qq_send_video', 'qq_send_file',
      'qq_send_forward', 'qq_napcat_api', 'qq_group_history',
    ],
    bili: [],
    screen: [],
    work: [],
  }

  for (const surface of ['web', 'wx', 'qq', 'bili', 'screen', 'work']) {
    assert.deepEqual(resolveAllow({ surface, caps }), expectedAllow[surface], `${surface} 常驻矩阵变了`)
    assert.deepEqual(catalog({ surface, caps }).map((e) => e.name), expectedCatalog[surface], `${surface} 按需矩阵变了`)
  }
})

test('目录摘要是世界声，不露出机器接口名或内部术语', () => {
  const entries = ['web', 'wx', 'qq', 'bili', 'screen'].flatMap((surface) => catalog({ surface, caps }))
  for (const entry of entries) {
    assert.doesNotMatch(entry.summary, /模型|通道|台账|任务板|主机|宿主|permit|白名单|门禁|额度|配额|JSON|OCR|API|NapCat|工具/)
  }
  assert.equal(describeEntry('qq_napcat_api', 'qq').summary, '在 QQ 里做一件这里没有现成入口的小事')
})

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

test('screen 面能看图、翻旧事、记下想留的话，不挂说出口的工具', () => {
  const names = resolveAllow({ surface: 'screen', caps })
  assert.deepEqual(new Set(names), new Set(['growth_commit', 'read_image', 'her_recall', 'look_screen', 'her_work', 'her_work_status']))
  assert.equal(names.includes('her_leave'), false, '留话给他是聊天面的事，不混进陪看')
  assert.equal(names.includes('her_tools'), false, '屏幕面不展开工具目录')
  const web = resolveAllow({ surface: 'web', caps })
  assert.equal(web.includes('presence_speak'), false, 'presence_speak 不该出现在 web 面')
  assert.equal(names.includes('presence_speak'), false, '陪看时她自然说话，不调工具')
})
