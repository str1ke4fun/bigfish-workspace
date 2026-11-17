import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { noteLocalLook, resolveRemoteLook, readRemoteLook } from '../electron/look.ts'
import type { ActionDefinition } from '../electron/actions.ts'
import { buildMenuModel, type MenuCallbacks, type MenuState } from '../electron/menu-model.ts'

type ElectronMock = {
  appPath: string
  exposed: Record<string, unknown>
  ipcHandled: Map<string, (...args: unknown[]) => unknown>
  ipcListeners: Map<string, Array<(...args: unknown[]) => void>>
  rendererListeners: Map<string, Array<(...args: unknown[]) => void>>
  rendererSends: Array<[string, unknown]>
  rendererInvokes: string[]
  windowFromContents: unknown
}

const electronMock: ElectronMock = {
  appPath: '/tmp/bigfish-desktop-pet-test-missing',
  exposed: {},
  ipcHandled: new Map(),
  ipcListeners: new Map(),
  rendererListeners: new Map(),
  rendererSends: [],
  rendererInvokes: [],
  windowFromContents: null,
}

;(globalThis as typeof globalThis & { __petElectronMock?: ElectronMock }).__petElectronMock = electronMock

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: 'mock:electron', shortCircuit: true }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && extname(specifier) === '') {
        try {
          return nextResolve(`${specifier}.ts`, context)
        } catch {
          // Re-throw the original resolution failure below.
        }
      }
      throw error
    }
  },
  load(url, context, nextLoad) {
    if (url === 'mock:electron') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const mock = globalThis.__petElectronMock
          const on = (map, channel, listener) => {
            const listeners = map.get(channel) ?? []
            listeners.push(listener)
            map.set(channel, listeners)
          }
          export const app = {
            requestSingleInstanceLock: () => false,
            quit() {},
            on() {},
            whenReady: () => ({ then: () => ({ catch: () => {} }) }),
            getAppPath: () => mock.appPath,
            getVersion: () => '0.1.0',
            getPath: () => '/tmp/bigfish-desktop-pet-test-runtime',
            setAsDefaultProtocolClient: () => true,
          }
          export const BrowserWindow = class {
            static fromWebContents() { return mock.windowFromContents }
          }
          export const ipcMain = {
            on: (channel, listener) => on(mock.ipcListeners, channel, listener),
            handle: (channel, listener) => mock.ipcHandled.set(channel, listener),
          }
          export const Menu = { buildFromTemplate: () => ({ popup() {} }) }
          export const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) }
          export const protocol = { registerSchemesAsPrivileged() {}, handle() {} }
          export const screen = {
            getCursorScreenPoint: () => ({ x: 0, y: 0 }),
            getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
            getAllDisplays: () => [],
            on() {},
            removeListener() {},
          }
          export const shell = { openExternal() {} }
          export const Tray = class {}
          export const contextBridge = {
            exposeInMainWorld: (name, bridge) => { mock.exposed[name] = bridge },
          }
          export const ipcRenderer = {
            on: (channel, listener) => on(mock.rendererListeners, channel, listener),
            removeListener() {},
            send: (channel, payload) => mock.rendererSends.push([channel, payload]),
            invoke: (channel) => {
              mock.rendererInvokes.push(channel)
              return channel === 'pet:get-action-catalog'
                ? Promise.resolve([{
                    id: 'wave', label: '挥手', anim: 'wave-file', loop: false, group: '回应',
                  }])
                : Promise.resolve({ ok: true, actions: [] })
            },
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

type MainModule = typeof import('../electron/main.ts')
type PetWindow = Parameters<MainModule['sendActionMessage']>[0]
let mainModulePromise: Promise<MainModule> | null = null
let freshModuleSequence = 0

function loadMainModule(): Promise<MainModule> {
  mainModulePromise ??= import('../electron/main.ts')
  return mainModulePromise
}

function loadFreshMainModule(label: string): Promise<MainModule> {
  freshModuleSequence += 1
  return import(`../electron/main.ts?test=${freshModuleSequence}-${label}`)
}

function fakeWindow(): { win: PetWindow; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = []
  return {
    win: {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload?: unknown) => sent.push([channel, payload]),
      },
    } as unknown as PetWindow,
    sent,
  }
}

async function actionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bigfish-pet-actions-'))
  const assets = join(root, 'assets')
  await mkdir(join(assets, 'webm'), { recursive: true })
  await mkdir(join(assets, 'skins', 'rest', 'webm'), { recursive: true })
  return { root, assets }
}

async function writeValidSkin(assets: string, id: string, name: string): Promise<void> {
  const skinDir = join(assets, 'skins', id)
  await mkdir(join(skinDir, 'webm'), { recursive: true })
  await writeFile(join(skinDir, 'webm', 'idle.webm'), '')
  const motions = {
    idle: 'idle',
    turn: 'idle',
    'moving-left': 'idle',
    'moving-right': 'idle',
    waving: 'idle',
    thinking: 'idle',
    working: 'idle',
    result: 'idle',
    waiting: 'idle',
    running: 'idle',
    review: 'idle',
    failed: 'idle',
    success: 'idle',
    error: 'idle',
  }
  await writeFile(join(skinDir, 'skin.json'), JSON.stringify({ name, motions }))
}

function captureWarnings(t: TestContext): string[] {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  t.after(() => {
    console.warn = originalWarn
  })
  return warnings
}

function captureHello(t: TestContext): unknown[] {
  const helloBodies: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    helloBodies.push(JSON.parse(String(init?.body)))
    return new Response('{"ok":true}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  return helloBodies
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('等待测试条件超时')
}

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

test('动作桥：菜单动作发新 union，旧 motion 字符串仍归一成 { motion }', async () => {
  const main = await loadMainModule()
  const messages: Array<{ motion: string } | { action: string }> = []
  const bridgeCallbacks = callbacks([])
  bridgeCallbacks.motion = (motion) => messages.push(main.toActionMessage('motion', motion))
  bridgeCallbacks.action = (id) => messages.push(main.toActionMessage('action', id))

  const menu = find(
    buildMenuModel(baseState, [registered('swing', '荡秋千', '玩耍')], bridgeCallbacks, 'context'),
    '演一个动作',
  ).submenu!
  find(menu, '常用').submenu!.find((item) => item.label === '挥手')!.click!()
  find(menu, '玩耍').submenu![0].click!()

  assert.deepEqual(messages, [
    { motion: 'waving' },
    { action: 'swing' },
  ])
  assert.deepEqual(main.normalizeActionMessage('waving'), { motion: 'waving' })
  assert.deepEqual(main.normalizeActionMessage({ action: 'swing' }), { action: 'swing' })
  assert.equal(main.normalizeActionMessage({ motion: 'waving', action: 'swing' }), null)
  assert.equal(main.normalizeActionMessage(''), null)
})

test('动作桥：catalog 推送、单动作推送和停止通知走固定 IPC 频道', async () => {
  const main = await loadMainModule()
  const { win, sent } = fakeWindow()
  const catalog: ActionDefinition[] = [
    { ...registered('swing', '荡秋千', '玩耍'), mediaUri: 'pet-asset://local/webm' },
    {
      id: 'sleep', label: '睡觉', seq: ['sleep-start', 'sleep-loop'], loop: true, group: '休息',
      mediaUri: 'pet-asset://local/skins/rest/webm',
    },
  ]

  main.sendActionMessage(win, { motion: 'waving' })
  main.sendActionCatalog(win, catalog)
  main.sendActionStop(win)

  assert.deepEqual(sent, [
    ['pet:action', { motion: 'waving' }],
    ['pet:action-catalog', [
      {
        id: 'swing', label: '荡秋千', anim: 'swing-anim', loop: false, group: '玩耍',
        mediaUri: 'pet-asset://local/webm',
      },
      {
        id: 'sleep', label: '睡觉', seq: ['sleep-start', 'sleep-loop'], loop: true, group: '休息',
        mediaUri: 'pet-asset://local/skins/rest/webm',
      },
    ]],
    ['pet:action-stop', undefined],
  ])
})

test('动作注册表：混合默认与皮肤动作保留各自媒体基地址，皮肤同 id 覆盖来源', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  await writeFile(join(assets, 'webm', 'wave.webm'), '')
  await writeFile(join(assets, 'webm', 'old.webm'), '')
  await writeFile(join(assets, 'skins', 'rest', 'webm', 'sleep.webm'), '')
  await writeFile(join(assets, 'skins', 'rest', 'webm', 'new.webm'), '')
  await writeFile(join(assets, 'actions.json'), JSON.stringify({
    actions: [
      { id: 'wave', label: '挥手', anim: 'wave', group: '回应' },
      { id: 'nap', label: '旧睡觉', anim: 'old', group: '休息' },
    ],
  }))
  await writeFile(join(assets, 'skins', 'rest', 'actions.json'), JSON.stringify({
    actions: [
      { id: 'sleep', label: '睡觉', anim: 'sleep', loop: true, group: '休息' },
      { id: 'nap', label: '新睡觉', anim: 'new', group: '休息' },
    ],
  }))

  assert.deepEqual(await main.readActionCatalog(assets, 'rest'), [
    {
      id: 'wave', label: '挥手', anim: 'wave', loop: false, group: '回应',
      mediaUri: 'pet-asset://local/webm',
    },
    {
      id: 'nap', label: '新睡觉', anim: 'new', loop: false, group: '休息',
      mediaUri: 'pet-asset://local/skins/rest/webm',
    },
    {
      id: 'sleep', label: '睡觉', anim: 'sleep', loop: true, group: '休息',
      mediaUri: 'pet-asset://local/skins/rest/webm',
    },
  ])
  assert.deepEqual((await main.readActionCatalog(assets, 'missing-skin')).map((action) => action.id), ['wave', 'nap'])
})

test('动作重载：成功后推 catalog、停旧动作并立即 hello；失败保留旧 catalog 并报错', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root

  await writeFile(join(assets, 'webm', 'wave.webm'), '')
  await writeFile(join(assets, 'actions.json'), JSON.stringify({
    actions: [{ id: 'wave', label: '挥手', anim: 'wave', group: '回应' }],
  }))

  const helloBodies: unknown[] = []
  const warnings: string[] = []
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  globalThis.fetch = async (_input, init) => {
    helloBodies.push(JSON.parse(String(init?.body)))
    return new Response('{"ok":true}', { status: 200 })
  }
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  t.after(() => {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  })

  const { win, sent } = fakeWindow()
  const first = await main.reloadRegisteredActions(win, assets)
  assert.equal(first.ok, true)
  assert.deepEqual(first.actions, [{ id: 'wave', label: '挥手', group: '回应' }])
  assert.deepEqual(sent.slice(0, 2), [
    ['pet:action-stop', undefined],
    ['pet:action-catalog', [{
      id: 'wave', label: '挥手', anim: 'wave', loop: false, group: '回应',
      mediaUri: 'pet-asset://local/webm',
    }]],
  ])
  assert.deepEqual(helloBodies, [{
    version: '0.1.0',
    skins: [{ id: '', name: '默认' }],
    actions: [{ id: 'wave', label: '挥手', group: '回应' }],
  }])

  await writeFile(join(assets, 'actions.json'), '{ nope')
  const second = await main.reloadRegisteredActions(win, assets)
  assert.equal(second.ok, false)
  assert.deepEqual(second.actions, [{ id: 'wave', label: '挥手', group: '回应' }])
  assert.match(second.error ?? '', /JSON|json|动作注册表/)
  assert.equal(sent.filter(([channel]) => channel === 'pet:action-catalog').length, 1)
  assert.equal(sent.at(-1)?.[0], 'pet:action-error')
  assert.equal(helloBodies.length, 1)
  assert.match(warnings.join('\n'), /动作没重新载入/)

  const getCatalog = electronMock.ipcHandled.get('pet:get-action-catalog')
  assert.ok(getCatalog)
  assert.deepEqual(await getCatalog(), [
    {
      id: 'wave', label: '挥手', anim: 'wave', loop: false, group: '回应',
      mediaUri: 'pet-asset://local/webm',
    },
  ])
})

test('动作重载：hello 未确认成功时不报成功并恢复旧 catalog', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')

  const warnings = captureWarnings(t)
  const helloBodies: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    helloBodies.push(JSON.parse(String(init?.body)))
    return helloBodies.length === 1
      ? new Response('{"ok":true}', { status: 200 })
      : new Response('{"ok":false}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { win, sent } = fakeWindow()
  const oldActions = [registered('old-wave', '旧挥手', '回应')]
  const newActions = [registered('new-wave', '新挥手', '回应')]
  assert.equal(await main.applySkin('', {
    win,
    assetsRoot: assets,
    readCatalog: async () => oldActions,
  }), true)
  sent.length = 0

  const result = await main.reloadRegisteredActions(win, assets, async () => newActions)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /hello|报到|上传/)

  const getCatalog = electronMock.ipcHandled.get('pet:get-action-catalog')
  assert.ok(getCatalog)
  assert.deepEqual(await getCatalog(), [
    { id: 'old-wave', label: '旧挥手', anim: 'old-wave-anim', loop: false, group: '回应' },
  ])
  assert.deepEqual(
    sent.filter(([channel]) => channel === 'pet:action-catalog').at(-1)?.[1],
    [{ id: 'old-wave', label: '旧挥手', anim: 'old-wave-anim', loop: false, group: '回应' }],
  )
  assert.match(warnings.join('\n'), /hello|报到|上传/)
})

test('动作重载：catalog hello 串行发布，慢的旧请求不会排到新请求之后', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root

  const helloBodies: Array<{ actions: Array<{ id: string }> }> = []
  let releaseFirst!: () => void
  let markFirstStarted!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    helloBodies.push(JSON.parse(String(init?.body)))
    if (helloBodies.length === 1) {
      markFirstStarted()
      await firstGate
    }
    return new Response('{"ok":true}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { win } = fakeWindow()
  const firstActions = [registered('first-wave', '第一版', '回应')]
  const secondActions = [registered('second-wave', '第二版', '回应')]
  const first = main.reloadRegisteredActions(win, assets, async () => firstActions)
  await firstStarted
  const second = main.reloadRegisteredActions(win, assets, async () => secondActions)
  await Promise.resolve()
  await Promise.resolve()

  const callsBeforeRelease = helloBodies.length
  releaseFirst()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(callsBeforeRelease, 1)
  assert.deepEqual(helloBodies.map((body) => body.actions.map((action) => action.id)), [
    ['first-wave'],
    ['second-wave'],
  ])
  assert.equal(firstResult.ok, false)
  assert.equal(firstResult.stale, true)
  assert.equal(secondResult.ok, true)
})

test('动作重载：只使用最后提交成功的皮肤，不用被拒绝的请求', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')

  const warnings = captureWarnings(t)
  const helloBodies = captureHello(t)
  const { win } = fakeWindow()
  const defaultActions = [registered('default-wave', '默认挥手', '回应')]

  await main.applySkin('', {
    win,
    assetsRoot: assets,
    readCatalog: async () => defaultActions,
  })
  await main.applySkin('rejected-skin', { win, assetsRoot: assets })

  const readSkins: string[] = []
  const result = await main.reloadRegisteredActions(win, assets, async (_root, skinId) => {
    readSkins.push(skinId)
    return defaultActions
  })

  assert.deepEqual(readSkins, [''])
  assert.equal(result.ok, true)
  assert.deepEqual(result.actions, [{ id: 'default-wave', label: '默认挥手', group: '回应' }])
  assert.deepEqual(helloBodies.at(-1), {
    version: '0.1.0',
    skins: [{ id: '', name: '默认' }],
    actions: [{ id: 'default-wave', label: '默认挥手', group: '回应' }],
  })
  assert.match(warnings.join('\n'), /rejected-skin/)
})

test('动作重载：旧 reload 在较新皮肤提交后完成也不覆盖新 catalog/hello', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')
  await writeValidSkin(assets, 'start', '起始皮肤')

  captureWarnings(t)
  const helloBodies = captureHello(t)
  const { win, sent } = fakeWindow()
  const startActions = [registered('start-wave', '起始挥手', '回应')]
  const defaultActions = [registered('default-wave', '默认挥手', '回应')]

  await main.applySkin('start', {
    win,
    assetsRoot: assets,
    readCatalog: async () => startActions,
  })
  sent.length = 0
  helloBodies.length = 0

  let reloadSkin = ''
  let resolveReload: ((actions: ActionDefinition[]) => void) | null = null
  const reload = main.reloadRegisteredActions(win, assets, async (_root, skinId) => {
    reloadSkin = skinId
    return await new Promise<ActionDefinition[]>((resolve) => {
      resolveReload = resolve
    })
  })

  assert.equal(reloadSkin, 'start')
  await main.applySkin('', {
    win,
    assetsRoot: assets,
    readCatalog: async () => defaultActions,
  })
  resolveReload!(startActions)

  const stale = await reload
  assert.equal(stale.ok, false)
  assert.equal(stale.stale, true)

  const getCatalog = electronMock.ipcHandled.get('pet:get-action-catalog')
  assert.ok(getCatalog)
  assert.deepEqual(await getCatalog(), [
    { id: 'default-wave', label: '默认挥手', anim: 'default-wave-anim', loop: false, group: '回应' },
  ])
  assert.deepEqual(helloBodies, [{
    version: '0.1.0',
    skins: [{ id: '', name: '默认' }],
    actions: [{ id: 'default-wave', label: '默认挥手', group: '回应' }],
  }])
  assert.deepEqual(
    sent.filter(([channel]) => channel === 'pet:action-catalog'),
    [['pet:action-catalog', [
      { id: 'default-wave', label: '默认挥手', anim: 'default-wave-anim', loop: false, group: '回应' },
    ]]],
  )
})

test('动作重载：皮肤 hello 未完成时排队的旧 catalog 不会在新皮肤提交后补发', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')
  await writeValidSkin(assets, 'next', '下一张皮肤')

  const helloBodies: Array<{ actions: Array<{ id: string }> }> = []
  let releaseSkinHello!: () => void
  let markSkinHelloStarted!: () => void
  const skinHelloGate = new Promise<void>((resolve) => { releaseSkinHello = resolve })
  const skinHelloStarted = new Promise<void>((resolve) => { markSkinHelloStarted = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { actions: Array<{ id: string }> }
    helloBodies.push(body)
    if (body.actions.some((action) => action.id === 'next-wave')) {
      markSkinHelloStarted()
      await skinHelloGate
    }
    return new Response('{"ok":true}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { win, sent } = fakeWindow()
  const defaultActions = [registered('default-wave', '默认挥手', '回应')]
  const nextActions = [registered('next-wave', '新皮肤挥手', '回应')]
  const oldReloadActions = [registered('old-reload-wave', '旧目录挥手', '回应')]
  assert.equal(await main.applySkin('', {
    win,
    assetsRoot: assets,
    readCatalog: async () => defaultActions,
  }), true)

  helloBodies.length = 0
  sent.length = 0
  const skin = main.applySkin('next', {
    win,
    assetsRoot: assets,
    readCatalog: async () => nextActions,
  })
  await skinHelloStarted

  const reload = main.reloadRegisteredActions(win, assets, async (_root, skinId) => {
    assert.equal(skinId, '')
    return oldReloadActions
  })
  await waitFor(() => sent.some(([channel, payload]) => (
    channel === 'pet:action-catalog'
    && Array.isArray(payload)
    && (payload as Array<{ id?: string }>).some((action) => action.id === 'old-reload-wave')
  )))

  releaseSkinHello()
  assert.equal(await skin, true)
  const stale = await reload
  assert.equal(stale.ok, false)
  assert.equal(stale.stale, true)
  assert.deepEqual(helloBodies.map((body) => body.actions.map((action) => action.id)), [
    ['next-wave'],
  ])

  const getCatalog = electronMock.ipcHandled.get('pet:get-action-catalog')
  assert.ok(getCatalog)
  assert.deepEqual(await getCatalog(), [
    { id: 'next-wave', label: '新皮肤挥手', anim: 'next-wave-anim', loop: false, group: '回应' },
  ])
})

test('皮肤切换：单个事件日志证明 hello 确认后才提交 skin 与 catalog', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')
  await writeValidSkin(assets, 'start', '起始皮肤')

  const events: string[] = []
  const helloBodies: unknown[] = []
  const readCommittedSkin = electronMock.ipcHandled.get('pet:get-skin')
  assert.ok(readCommittedSkin)
  let skinObserved = false
  const observeSkin = () => {
    const cached = readCommittedSkin() as { id?: string } | null
    if (!skinObserved && cached?.id === 'start') {
      skinObserved = true
      events.push('skin')
    }
  }
  const win = {
    isDestroyed: () => false,
    webContents: {
      send(channel: string) {
        observeSkin()
        if (channel === 'pet:action-stop') events.push('stop')
        if (channel === 'pet:action-catalog') {
          observeSkin()
          events.push('catalog')
        }
      },
    },
  } as unknown as PetWindow
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    observeSkin()
    events.push('hello')
    helloBodies.push(JSON.parse(String(init?.body)))
    return new Response('{"ok":true}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const actions = [registered('start-wave', '起始挥手', '回应')]

  await main.applySkin('', { win, assetsRoot: assets, readCatalog: async () => [] })
  events.length = 0
  helloBodies.length = 0
  skinObserved = false

  await main.applySkin('start', {
    win,
    assetsRoot: assets,
    readCatalog: async () => actions,
  })

  assert.deepEqual(events, ['stop', 'hello', 'skin', 'catalog'])
  assert.deepEqual(helloBodies, [{
    version: '0.1.0',
    skins: [{ id: '', name: '默认' }],
    actions: [{ id: 'start-wave', label: '起始挥手', group: '回应' }],
  }])
})

test('皮肤切换：hello 失败时回退旧皮肤和 catalog，不报告提交成功', async (t) => {
  const main = await loadMainModule()
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')
  await writeValidSkin(assets, 'start', '起始皮肤')

  const warnings = captureWarnings(t)
  const helloBodies: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    helloBodies.push(JSON.parse(String(init?.body)))
    return helloBodies.length === 1
      ? new Response('{"ok":true}', { status: 200 })
      : new Response('{"ok":false}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { win, sent } = fakeWindow()
  const defaultActions = [registered('default-wave', '默认挥手', '回应')]
  const skinActions = [registered('skin-wave', '皮肤挥手', '回应')]
  assert.equal(await main.applySkin('', {
    win,
    assetsRoot: assets,
    readCatalog: async () => defaultActions,
  }), true)

  const committed = await main.applySkin('start', {
    win,
    assetsRoot: assets,
    readCatalog: async () => skinActions,
  })
  assert.equal(committed, false)

  const getSkin = electronMock.ipcHandled.get('pet:get-skin')
  const getCatalog = electronMock.ipcHandled.get('pet:get-action-catalog')
  assert.ok(getSkin)
  assert.ok(getCatalog)
  assert.equal((await getSkin() as { id: string }).id, '')
  assert.deepEqual(await getCatalog(), [
    { id: 'default-wave', label: '默认挥手', anim: 'default-wave-anim', loop: false, group: '回应' },
  ])
  assert.equal(sent.at(-1)?.[0], 'pet:skin-error')
  assert.match(warnings.join('\n'), /hello|报到|上传/)
})

test('皮肤切换：首个非默认皮肤 hello 失败时不把候选推给渲染进程', async (t) => {
  const main = await loadFreshMainModule('first-skin-failure')
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')
  await writeValidSkin(assets, 'first', '第一张皮肤')

  const warnings = captureWarnings(t)
  const originalFetch = globalThis.fetch
  let helloCalls = 0
  globalThis.fetch = async () => {
    helloCalls += 1
    return new Response('{"ok":false}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { win, sent } = fakeWindow()
  const candidate = [registered('first-wave', '第一张挥手', '回应')]
  const committed = await main.applySkin('first', {
    win,
    assetsRoot: assets,
    readCatalog: async () => candidate,
  })

  const getSkin = electronMock.ipcHandled.get('pet:get-skin')
  const getCatalog = electronMock.ipcHandled.get('pet:get-action-catalog')
  assert.ok(getSkin)
  assert.ok(getCatalog)
  assert.equal(committed, false)
  assert.equal(helloCalls, 1)
  assert.equal(await getSkin(), null)
  assert.deepEqual(await getCatalog(), [])
  assert.equal(sent.some(([channel]) => channel === 'pet:skin'), false)
  assert.equal(sent.some(([channel]) => channel === 'pet:action-catalog'), false)
  assert.equal(sent.at(-1)?.[0], 'pet:skin-error')
  assert.match(warnings.join('\n'), /hello|报到|上传/)
})

test('皮肤切换：两次重叠失败都只停留最后确认的基线，不回退到未确认候选', async (t) => {
  const main = await loadFreshMainModule('overlapping-skin-failures')
  const { root, assets } = await actionFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  electronMock.appPath = root
  await writeFile(join(assets, 'config.json'), '{}')
  await writeValidSkin(assets, 'first', '第一张皮肤')
  await writeValidSkin(assets, 'second', '第二张皮肤')

  const warnings = captureWarnings(t)
  const pendingHellos: Array<{
    body: unknown
    resolve: (ok: boolean) => void
  }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => await new Promise<Response>((resolve) => {
    pendingHellos.push({
      body: JSON.parse(String(init?.body)),
      resolve: (ok) => resolve(new Response(JSON.stringify({ ok }), { status: 200 })),
    })
  })
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { win, sent } = fakeWindow()
  const first = main.applySkin('first', {
    win,
    assetsRoot: assets,
    readCatalog: async () => [registered('first-wave', '第一张挥手', '回应')],
  })
  await waitFor(() => pendingHellos.length === 1)

  const second = main.applySkin('second', {
    win,
    assetsRoot: assets,
    readCatalog: async () => [registered('second-wave', '第二张挥手', '回应')],
  })
  await waitFor(() => sent.filter(([channel]) => channel === 'pet:action-stop').length === 2)

  pendingHellos[0].resolve(false)
  await waitFor(() => pendingHellos.length === 2)
  pendingHellos[1].resolve(false)
  assert.deepEqual(await Promise.all([first, second]), [false, false])

  const getSkin = electronMock.ipcHandled.get('pet:get-skin')
  const getCatalog = electronMock.ipcHandled.get('pet:get-action-catalog')
  assert.ok(getSkin)
  assert.ok(getCatalog)
  assert.equal(await getSkin(), null)
  assert.deepEqual(await getCatalog(), [])
  assert.equal(sent.some(([channel]) => channel === 'pet:skin'), false)
  assert.equal(sent.some(([channel]) => channel === 'pet:action-catalog'), false)
  assert.match(warnings.join('\n'), /hello|报到|上传/)
})

test('preload 暴露 catalog/stop/reload API，并兼容旧 motion 字符串载荷', async () => {
  await loadMainModule()
  await import('../electron/preload.ts')
  const bridge = electronMock.exposed.petBridge as {
    onAction(handler: (payload: unknown) => void): () => void
    onActionCatalog(handler: (catalog: unknown) => void): () => void
    onActionStop(handler: () => void): () => void
    onActionError(handler: (error: unknown) => void): () => void
    getActionCatalog(): Promise<unknown>
    reloadActions(): Promise<unknown>
    requestAction(payload: unknown): void
  }

  const actions: unknown[] = []
  const catalogs: unknown[] = []
  let stops = 0
  const errors: unknown[] = []
  bridge.onAction((payload) => actions.push(payload))
  bridge.onActionCatalog((catalog) => catalogs.push(catalog))
  bridge.onActionStop(() => { stops += 1 })
  bridge.onActionError((error) => errors.push(error))

  electronMock.rendererListeners.get('pet:action')![0]({}, { motion: 'waving' })
  electronMock.rendererListeners.get('pet:action')![0]({}, 'thinking')
  electronMock.rendererListeners.get('pet:action-catalog')![0]({}, [
    { id: 'wave', label: '挥手', anim: 'wave-file', loop: false, group: '回应' },
  ])
  electronMock.rendererListeners.get('pet:action-stop')![0]({})
  electronMock.rendererListeners.get('pet:action-error')![0]({}, { why: '坏了' })

  assert.deepEqual(actions, [{ motion: 'waving' }, 'thinking'])
  assert.deepEqual(catalogs, [[
    { id: 'wave', label: '挥手', anim: 'wave-file', loop: false, group: '回应' },
  ]])
  assert.equal(stops, 1)
  assert.deepEqual(errors, [{ why: '坏了' }])
  assert.deepEqual(await bridge.getActionCatalog(), [
    { id: 'wave', label: '挥手', anim: 'wave-file', loop: false, group: '回应' },
  ])
  assert.deepEqual(await bridge.reloadActions(), { ok: true, actions: [] })
  assert.deepEqual(electronMock.rendererInvokes, ['pet:get-action-catalog', 'pet:actions-reload'])

  bridge.requestAction('waving')
  bridge.requestAction({ action: 'wave' })
  assert.deepEqual(electronMock.rendererSends, [
    ['pet:action-request', 'waving'],
    ['pet:action-request', { action: 'wave' }],
  ])
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
