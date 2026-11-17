import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noteLocalLook, resolveRemoteLook, readRemoteLook } from '../electron/look.ts'
import type { ActionDefinition } from '../electron/actions.ts'
import { buildMenuModel, type MenuCallbacks, type MenuState } from '../electron/menu-model.ts'

test('读远端外观：缺字段/非法值给 null，合法值夹取', () => {
  assert.equal(readRemoteLook({ settings: {} }), null)
  assert.deepEqual(readRemoteLook({ settings: { bubbleOpacity: 70, bubbleWidth: 300 } }), { opacity: 70, width: 300 })
  assert.deepEqual(readRemoteLook({ settings: { bubbleOpacity: 5, bubbleWidth: 999 } }), { opacity: 40, width: 420 })
  assert.equal(readRemoteLook(null), null)
})

test('本地改外观后，旧的远端值不会把它拉回去，回声到了才清账', () => {
  const start = { current: { opacity: 90, width: 0 }, pending: null }
  const local = noteLocalLook({ opacity: 50, width: 0 })
  assert.deepEqual(local.pending, { opacity: 50, width: 0 })

  const stale = resolveRemoteLook(local, { opacity: 90, width: 0 })
  assert.equal(stale.apply, null)
  assert.notEqual(stale.state.pending, null)

  const echoed = resolveRemoteLook(stale.state, { opacity: 50, width: 0 })
  assert.equal(echoed.apply, null)
  assert.equal(echoed.state.pending, null)

  const remote = resolveRemoteLook(echoed.state, { opacity: 70, width: 300 })
  assert.deepEqual(remote.apply, { opacity: 70, width: 300 })
  assert.deepEqual(remote.state.current, { opacity: 70, width: 300 })

  // 没有变化时保持幂等
  assert.equal(resolveRemoteLook(start, { opacity: 90, width: 0 }).apply, null)
})

function callbacks(log: string[]): MenuCallbacks {
  return {
    motion: (m) => log.push(`motion:${m}`),
    action: (id) => log.push(`action:${id}`),
    stop: () => log.push('stop'),
    reload: () => log.push('reload'),
    size: (n) => log.push(`size:${n}`),
    opacity: (n) => log.push(`opacity:${n}`),
    width: (n) => log.push(`width:${n}`),
    toggleHidden: () => log.push('toggle'),
    resetPosition: () => log.push('reset'),
    presence: (mode) => log.push(`presence:${mode}`),
    openWorkbench: () => log.push('workbench'),
    quit: () => log.push('quit'),
  }
}

function registered(id: string, label: string, group: string): ActionDefinition {
  return { id, label, anim: `${id}-anim`, loop: false, group }
}

const baseState: MenuState = {
  size: 400,
  opacity: 90,
  width: 0,
  hidden: false,
  presence: { on: true, mode: 'event' },
}

function find(items: ReturnType<typeof buildMenuModel>, label: string) {
  const item = items.find((entry) => entry.label === label)
  assert.ok(item, `缺少菜单项 ${label}`)
  return item!
}

test('右键菜单：有隐藏项，没有托盘专属项', () => {
  const items = buildMenuModel(baseState, [], callbacks([]), 'context')
  const labels = items.map((item) => item.label).filter(Boolean)
  assert.deepEqual(labels, ['演一个动作', '大小', '气泡', '隐藏桌宠', '退出'])
})

test('托盘菜单：显示/隐藏、回到右下角、陪你看屏幕、打开工作台都在', () => {
  const items = buildMenuModel({ ...baseState, hidden: true }, [], callbacks([]), 'tray')
  const labels = items.map((item) => item.label).filter(Boolean)
  assert.deepEqual(labels, [
    '显示桌宠', '回到右下角', '演一个动作', '大小', '气泡', '陪你看屏幕', '打开工作台', '退出',
  ])
})

test('大小、透明度、宽度子菜单按当前值勾选，点击走对应动作', () => {
  const log: string[] = []
  const items = buildMenuModel({ ...baseState, size: 320, opacity: 70, width: 320 }, [], callbacks(log), 'tray')

  const size = find(items, '大小').submenu!
  assert.deepEqual(size.filter((i) => i.checked).map((i) => i.label), ['小'])
  size.find((i) => i.label === '大')!.click!()

  const bubble = find(items, '气泡').submenu!
  const checked = bubble.filter((i) => i.checked).map((i) => i.label)
  assert.deepEqual(checked, ['透明 70%', '宽度 中'])
  bubble.find((i) => i.label === '透明 50%')!.click!()
  bubble.find((i) => i.label === '宽度 跟随大小')!.click!()

  assert.deepEqual(log, ['size:462', 'opacity:50', 'width:0'])
})

test('陪你看屏幕：开着时勾选当前模式，点关闭走 off；服务端没回时不出现', () => {
  const log: string[] = []
  const items = buildMenuModel(baseState, [], callbacks(log), 'tray')
  const presence = find(items, '陪你看屏幕').submenu!
  assert.deepEqual(presence.filter((i) => i.checked).map((i) => i.label), ['事件'])
  presence.find((i) => i.label === '关闭')!.click!()
  presence.find((i) => i.label === '氛围')!.click!()
  assert.deepEqual(log, ['presence:off', 'presence:ambient'])

  const offline = buildMenuModel({ ...baseState, presence: null }, [], callbacks([]), 'tray')
  assert.equal(offline.find((i) => i.label === '陪你看屏幕'), undefined)

  const off = buildMenuModel({ ...baseState, presence: { on: false, mode: null } }, [], callbacks([]), 'tray')
  assert.deepEqual(find(off, '陪你看屏幕').submenu!.filter((i) => i.checked).map((i) => i.label), ['关闭'])
})

test('显示/隐藏项的文案跟着 hidden 变，点击走 toggleHidden', () => {
  const log: string[] = []
  const shown = buildMenuModel(baseState, [], callbacks(log), 'tray')
  find(shown, '隐藏桌宠').click!()
  const hidden = buildMenuModel({ ...baseState, hidden: true }, [], callbacks(log), 'tray')
  find(hidden, '显示桌宠').click!()
  assert.deepEqual(log, ['toggle', 'toggle'])
})

test('动作菜单：常用保留原 7 项，状态提供其余 7 个 motion', () => {
  const log: string[] = []
  const menu = find(buildMenuModel(baseState, [], callbacks(log), 'context'), '演一个动作').submenu!
  const common = find(menu, '常用').submenu!
  const status = find(menu, '状态').submenu!

  assert.deepEqual(common.map((item) => item.label), ['挥手', '思考', '忙碌', '看结果', '等待', '庆祝', '沮丧'])
  assert.equal(status.length, 7)

  common.forEach((item) => item.click!())
  status.forEach((item) => item.click!())
  assert.deepEqual(log, [
    'motion:waving',
    'motion:thinking',
    'motion:working',
    'motion:result',
    'motion:waiting',
    'motion:success',
    'motion:error',
    'motion:idle',
    'motion:turn',
    'motion:moving-left',
    'motion:moving-right',
    'motion:running',
    'motion:review',
    'motion:failed',
  ])
})

test('注册表动作按 group 建二级菜单，组和动作顺序稳定', () => {
  const log: string[] = []
  const catalog = [
    registered('wave', '挥手', '玩耍'),
    registered('sleep', '睡觉', '休息'),
    registered('swing', '荡秋千', '玩耍'),
  ]
  const menu = find(buildMenuModel(baseState, catalog, callbacks(log), 'context'), '演一个动作').submenu!

  assert.deepEqual(menu.map((item) => item.label), ['常用', '状态', '玩耍', '休息', '停下当前动作', '重新载入动作'])
  const play = find(menu, '玩耍').submenu!
  assert.deepEqual(play.map((item) => item.label), ['挥手', '荡秋千'])
  play[1].click!()
  assert.equal(menu.some((item) => item.label === '未登记'), false)
  assert.deepEqual(log, ['action:swing'])
})

test('空白 group 落到其他，不生成空标题菜单', () => {
  const menu = find(
    buildMenuModel(baseState, [registered('misc', '随手动作', '   ')], callbacks([]), 'context'),
    '演一个动作',
  ).submenu!

  assert.equal(menu.some((item) => item.label === ''), false)
  assert.deepEqual(find(menu, '其他').submenu!.map((item) => item.label), ['随手动作'])
})

test('同组重复 label 保留为独立动作，点击仍按 id 分发', () => {
  const log: string[] = []
  const catalog = [
    registered('first', '同名', '玩耍'),
    registered('second', '同名', '玩耍'),
  ]
  const menu = find(buildMenuModel(baseState, catalog, callbacks(log), 'context'), '演一个动作').submenu!
  const duplicates = find(menu, '玩耍').submenu!.filter((item) => item.label === '同名')

  assert.equal(duplicates.length, 2)
  duplicates[0].click!()
  duplicates[1].click!()
  assert.deepEqual(log, ['action:first', 'action:second'])
})

test('动作菜单：停下当前动作和重新载入动作分别走 stop/reload', () => {
  const log: string[] = []
  const menu = find(buildMenuModel(baseState, [], callbacks(log), 'context'), '演一个动作').submenu!

  find(menu, '停下当前动作').click!()
  find(menu, '重新载入动作').click!()
  assert.deepEqual(log, ['stop', 'reload'])
})

test('打开链接：命令行带 bigfishpet:// 才算，大小写不敏感', async () => {
  const { hasOpenLink, OPEN_URL } = await import('../electron/open-link.ts')
  assert.equal(OPEN_URL, 'bigfishpet://open')
  assert.equal(hasOpenLink(['C:\\app.exe', 'bigfishpet://open']), true)
  assert.equal(hasOpenLink(['C:\\app.exe', 'BigFishPet://open']), true)
  assert.equal(hasOpenLink(['C:\\app.exe', '--flag']), false)
  assert.equal(hasOpenLink([]), false)
})

test('登记协议的目标：portable 用原始 exe，开发态带应用目录', async () => {
  const { protocolTarget } = await import('../electron/open-link.ts')
  assert.deepEqual(
    protocolTarget({ execPath: 'C:\\Temp\\x\\electron.exe', portableFile: 'D:\\pet\\pet.exe' }),
    { exec: 'D:\\pet\\pet.exe', args: [] },
  )
  assert.deepEqual(
    protocolTarget({ execPath: 'C:\\e\\electron.exe', defaultApp: true, appArg: 'D:\\fish\\desktop-pet' }),
    { exec: 'C:\\e\\electron.exe', args: ['D:\\fish\\desktop-pet'] },
  )
  assert.deepEqual(protocolTarget({ execPath: 'C:\\app\\pet.exe' }), { exec: 'C:\\app\\pet.exe', args: [] })
})
