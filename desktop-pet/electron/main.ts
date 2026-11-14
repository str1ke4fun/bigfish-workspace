import { app, BrowserWindow, ipcMain, Menu, protocol, screen } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { createPoller, createStateForwarder, type Poller } from './poller'
import { sendChat } from '../renderer/chat'
import { applyIgnoreMouse, clampWindowToDisplays, createPetWindow, flushPosition } from './window'
import { readPetSize, savePetSize } from './settings'
import { clampPetSize, windowSizeFor } from './size'
import {
  createSkinForwarder,
  missingSkinMedia,
  noteLocalSize,
  resolveRemoteSize,
  scanSkins,
  shouldApplySettings,
  validateSkin,
  SIMPLE_SKIN_ID,
  type PetSettings,
  type ScannedSkin,
  type SizeSyncState,
} from './skin'

const PET_STATE_URL = 'http://127.0.0.1:8788/api/fish/pet/state'
const PET_CONFIG_URL = 'http://127.0.0.1:8788/api/fish/pet/config'
const PET_HELLO_URL = 'http://127.0.0.1:8788/api/fish/pet/hello'
const PET_POLL_INTERVAL_MS = 2000
const PET_REQUEST_TIMEOUT_MS = 5000
const PET_HELLO_INTERVAL_MS = 60_000
const DEFAULT_SKIN_URI = 'pet-asset://local/webm'

/** 右键「演一个动作」：只列用户可选的七个动作，`dragging` 是手势态，不进菜单。 */
const MOTION_MENU_ITEMS: ReadonlyArray<{ label: string; motion: string }> = [
  { label: '挥手', motion: 'waving' },
  { label: '思考', motion: 'thinking' },
  { label: '忙碌', motion: 'working' },
  { label: '看结果', motion: 'result' },
  { label: '等待', motion: 'waiting' },
  { label: '庆祝', motion: 'success' },
  { label: '沮丧', motion: 'error' },
]

/** 右键「大小」预设：宠物身体宽度（px）。 */
const PET_SIZE_PRESETS: ReadonlyArray<{ label: string; size: number }> = [
  { label: '小', size: 320 },
  { label: '中', size: 400 },
  { label: '大', size: 462 },
]

let petPoller: Poller | null = null
let petWindow: BrowserWindow | null = null
let petSize = 400
/** 最近一次应用/尝试应用的设置；用来让每 2 秒重复下发的同一份设置保持幂等。 */
let petSettings: PetSettings = { size: petSize, skin: '' }
/** 启动时扫描到的本地皮肤；只用于 hello 上报，实际加载按需读盘复核。 */
let skinCatalog: ScannedSkin[] = [{ id: '', name: '默认', config: null }]
let helloTimer: ReturnType<typeof setInterval> | null = null
/** 皮肤加载的单调序号：慢的旧请求不能覆盖后来的新请求。 */
let skinRevision = 0
/** 本地尺寸覆盖：服务端回声前不让旧值把窗口拉回去。 */
let sizeSync: SizeSyncState = { current: petSize, pending: null }

/**
 * 皮肤推送缓存：首推可能早于渲染进程注册 `onSkin`（和 `pet:state` 同样的竞态）。
 * 渲染进程挂载时用 `pet:get-skin` 主动拉取，`pet:ready` 时再补发一次。
 */
const skinForwarder = createSkinForwarder((payload) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:skin', payload)
})

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

function appFile(...parts: string[]): string {
  return join(app.getAppPath(), ...parts)
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

function registerAssetProtocol(): void {
  protocol.handle('pet-asset', async (request) => {
    const url = new URL(request.url)
    let relative: string
    try {
      relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('bad request', { status: 400 })
    }

    const root = appFile('assets')
    const filePath = normalize(join(root, relative))
    if (!isInside(root, filePath)) {
      return new Response('not found', { status: 404 })
    }

    try {
      const body = await readFile(filePath)
      const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      const headers: Record<string, string> = {
        'content-type': type,
        'access-control-allow-origin': '*',
        'accept-ranges': 'bytes',
      }
      // Chromium 的媒体栈用 Range 请求拉 WebM；只回整包会让 <video> 报
      // MEDIA_ERR_SRC_NOT_SUPPORTED（错误码 4），宠物身体就整只不显示。
      const range = request.headers.get('range')
      const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
      if (match) {
        const total = body.length
        let start = match[1] === '' ? Number.NaN : Number(match[1])
        let end = match[2] === '' ? Number.NaN : Number(match[2])
        if (Number.isNaN(start)) {
          start = Math.max(0, total - (Number.isNaN(end) ? 0 : end))
          end = total - 1
        } else if (Number.isNaN(end) || end >= total) {
          end = total - 1
        }
        if (start > end || start >= total) {
          return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${total}` } })
        }
        headers['content-range'] = `bytes ${start}-${end}/${total}`
        headers['content-length'] = String(end - start + 1)
        return new Response(body.subarray(start, end + 1), { status: 206, headers })
      }
      headers['content-length'] = String(body.length)
      return new Response(body, { headers })
    } catch {
      return new Response('not found', { status: 404, headers: { 'access-control-allow-origin': '*' } })
    }
  })
}

function sendAction(win: BrowserWindow, motion: string): void {
  if (!win.isDestroyed()) win.webContents.send('pet:action', motion)
}

/**
 * 改尺寸：窗口按比例缩放，先夹回工作区，再把新尺寸推给渲染进程。
 *
 * - 右键菜单：`persist` + `sync`，本地落盘并尽力写回服务端。
 * - 服务端轮询：两者都关掉，只跟随远端值，避免「写回 → 再读到 → 再写回」的循环。
 */
interface ChangePetSizeOptions {
  persist?: boolean
  sync?: boolean
  /** 是否来自右键本地操作；远端应用只更新当前值，不产生新的待确认覆盖。 */
  local?: boolean
}

function changePetSize(
  win: BrowserWindow,
  size: number,
  { persist = true, sync = true, local = true }: ChangePetSizeOptions = {},
): void {
  petSize = persist ? savePetSize(size) : clampPetSize(size)
  petSettings = { ...petSettings, size: petSize }
  sizeSync = local ? noteLocalSize(petSize) : { ...sizeSync, current: petSize }
  if (!win.isDestroyed()) {
    const { width, height } = windowSizeFor(petSize)
    win.setSize(width, height)
    clampWindowToDisplays(win)
    win.webContents.send('pet:size', petSize)
  }
  if (sync) void syncPetConfig({ size: petSize })
}

/**
 * 尽力把本地设置同步回服务端；失败只影响工作台显示，本地照常生效。
 *
 * `/pet/config` 写配置失败时仍返回 HTTP 200 + `{ ok:false }`，只看状态码会把失败
 * 当成成功，所以这里显式检查 `ok === true`。
 */
async function syncPetConfig(update: { size?: number; skin?: string }): Promise<boolean> {
  try {
    const response = await fetch(PET_CONFIG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(PET_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && (body as Record<string, unknown>).ok === true
  } catch {
    // 本地已经生效；不打扰用户，也不刷日志。
    return false
  }
}

/** 心跳：窗口真的起来了才让服务端判 online。失败静默，不刷屏。 */
async function sendHello(): Promise<void> {
  try {
    const response = await fetch(PET_HELLO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: app.getVersion(),
        skins: skinCatalog.map(({ id, name }) => ({ id, name })),
      }),
      signal: AbortSignal.timeout(PET_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch {
    // 心跳失败不影响桌宠本身；下一拍再试。
  }
}

function startPetHeartbeat(): void {
  stopPetHeartbeat()
  void sendHello()
  helloTimer = setInterval(() => {
    void sendHello()
  }, PET_HELLO_INTERVAL_MS)
}

function stopPetHeartbeat(): void {
  if (helloTimer) clearInterval(helloTimer)
  helloTimer = null
}

/** 从 `/pet/state` 里取出可用的设置；缺字段/类型不对就不算一次变化。 */
function readRemoteSettings(state: unknown): { size?: number; skin?: string } {
  if (!state || typeof state !== 'object') return {}
  const settings = (state as Record<string, unknown>).settings
  if (!settings || typeof settings !== 'object') return {}
  const record = settings as Record<string, unknown>

  const next: { size?: number; skin?: string } = {}
  if (typeof record.size === 'number' && Number.isFinite(record.size)) {
    next.size = clampPetSize(record.size)
  }
  if (typeof record.skin === 'string') next.skin = record.skin
  return next
}

/**
 * 按 id 加载皮肤并推给渲染进程。默认皮肤回到现有 `config.json` + `assets/webm`。
 *
 * 先记录服务端意图（`petSettings.skin`），这样同一份失败设置不会每 2 秒重试并刷日志；
 * 但渲染进程只在校验通过（含 14 个动画文件齐全）后收到新皮肤，失败时继续用旧皮肤。
 */
async function applySkin(id: string): Promise<void> {
  const revision = ++skinRevision
  petSettings = { ...petSettings, skin: id }

  if (id === '') {
    try {
      const config: unknown = JSON.parse(await readFile(appFile('assets', 'config.json'), 'utf8'))
      if (revision === skinRevision) skinForwarder.onSkin({ id, config, uri: DEFAULT_SKIN_URI })
    } catch (error) {
      console.warn('[desktop-pet] 默认皮肤配置没载入，保留当前皮肤', error)
    }
    return
  }

  if (!SIMPLE_SKIN_ID.test(id)) {
    console.warn(`[desktop-pet] 皮肤 id 不合法，保留当前皮肤：${id}`)
    return
  }

  const assetsRoot = appFile('assets')
  const skinDir = join(assetsRoot, 'skins', id)
  const file = normalize(join(skinDir, 'skin.json'))
  if (!isInside(assetsRoot, file)) {
    console.warn(`[desktop-pet] 皮肤路径越界，保留当前皮肤：${id}`)
    return
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (revision !== skinRevision) return
    const validation = validateSkin(parsed)
    if (!validation.ok) {
      console.warn(`[desktop-pet] 皮肤 ${id} 没载入，保留当前皮肤：${validation.why}`)
      return
    }
    // skin.json 合法但素材缺失时，组件只会在运行时报错；必须提前拒绝，别顶掉能用的皮肤。
    const missing = missingSkinMedia(skinDir, validation.motions)
    if (missing.length > 0) {
      console.warn(`[desktop-pet] 皮肤 ${id} 缺动画文件，保留当前皮肤：${missing.join(', ')}`)
      return
    }
    skinForwarder.onSkin({
      id,
      config: parsed,
      uri: `pet-asset://local/skins/${id}/webm`,
    })
  } catch (error) {
    if (revision === skinRevision) {
      console.warn(`[desktop-pet] 皮肤 ${id} 没载入，保留当前皮肤`, error)
    }
  }
}

/** 每拍轮询后比较服务端设置；只在真正变化时改窗口/皮肤。 */
function applyRemoteSettings(state: unknown): void {
  const next = readRemoteSettings(state)

  // size 每拍都过一遍纯决策：pending 的清账不能被「值看起来没变」的幂等判断挡掉
  // （本地可能刚好改成和最后一次远端值相同）。resolveRemoteSize 自己保证幂等。
  if (typeof next.size === 'number') {
    const decision = resolveRemoteSize(sizeSync, next.size)
    sizeSync = decision.state
    petSettings = { ...petSettings, size: next.size }
    if (decision.apply !== null) {
      const win = petWindow
      if (win && !win.isDestroyed()) {
        changePetSize(win, decision.apply, { persist: false, sync: false, local: false })
      }
    }
  }

  if (typeof next.skin === 'string' && shouldApplySettings(petSettings, { skin: next.skin })) {
    void applySkin(next.skin)
  }
}

function attachPetMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', () => {
    if (win.isDestroyed()) return
    const menu = Menu.buildFromTemplate([
      {
        label: '演一个动作',
        submenu: MOTION_MENU_ITEMS.map(({ label, motion }) => ({
          label,
          click: () => sendAction(win, motion),
        })),
      },
      {
        label: '大小',
        submenu: PET_SIZE_PRESETS.map(({ label, size }) => ({
          label,
          type: 'radio' as const,
          checked: petSize === size,
          click: () => changePetSize(win, size),
        })),
      },
      { type: 'separator' },
      // v1 没有托盘：无边框 + skipTaskbar 的窗口一旦 hide() 就没有恢复入口，
      // 所以只给退出。托盘/显示按 spec §6.2 留到后续阶段。
      { label: '退出', click: () => app.quit() },
    ])
    menu.popup({ window: win })
  })
}

/**
 * 缓存最近状态并去重；渲染进程订阅完成（`pet:ready`）后补发一次，
 * 避免首拍 IPC 早于订阅被丢掉。
 */
const stateForwarder = createStateForwarder((state) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:state', state)
})

ipcMain.on('pet:ready', () => {
  stateForwarder.resend()
  // 皮肤可能早于渲染进程订阅就绪：就绪后补发最近一份。
  skinForwarder.ready()
})

ipcMain.handle('pet:get-size', () => petSize)

/** 渲染进程挂载时主动拉取最近皮肤，避免首推丢失后一直停在默认皮肤。 */
ipcMain.handle('pet:get-skin', () => skinForwarder.get())

ipcMain.on('pet:ignore-mouse', (event, ignore: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) applyIgnoreMouse(win, ignore === true)
})

/**
 * 拖拽：渲染进程在身体上按下时开始，主进程按光标位置轮询移动窗口。
 * 用光标轮询而不是跟着 mousemove 走，是因为指针甩出窗口时渲染进程会丢事件，
 * 轮询能让窗口一直跟着光标；松手后夹回工作区并落盘。
 */
let dragTimer: ReturnType<typeof setInterval> | null = null
let dragTarget: BrowserWindow | null = null
let dragOffset = { x: 0, y: 0 }

function endDrag(): void {
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = null
  const win = dragTarget
  dragTarget = null
  // 松手只要求还看得见：允许贴边、甚至半只挂在屏幕外，不再整窗弹回。
  if (win && !win.isDestroyed()) clampWindowToDisplays(win, true)
  flushPosition()
}

ipcMain.on('pet:drag-start', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = win.getPosition()
  dragOffset = { x: cursor.x - x, y: cursor.y - y }
  dragTarget = win
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = setInterval(() => {
    if (!dragTarget || dragTarget.isDestroyed()) {
      endDrag()
      return
    }
    const point = screen.getCursorScreenPoint()
    dragTarget.setPosition(point.x - dragOffset.x, point.y - dragOffset.y)
  }, 16)
})

ipcMain.on('pet:drag-end', () => endDrag())

/**
 * 对话请求从主进程发：渲染进程是 `file://`，BFF 不带 CORS 头，
 * 在渲染进程里 fetch 会被浏览器拦住。这里永远 resolve 成
 * `{ ok, herReply, note }`，不让异常跨 IPC 边界。
 */
ipcMain.handle('pet:chat', async (_event, text: unknown) => {
  if (typeof text !== 'string') {
    return { ok: false, herReply: '', note: '没听懂要说什么。' }
  }
  try {
    return await sendChat(text, { fetchImpl: (url, init) => fetch(url, init) })
  } catch {
    return { ok: false, herReply: '', note: '没送到。' }
  }
})

function startPetPoller(win: BrowserWindow): void {
  petPoller?.stop()
  petWindow = win

  petPoller = createPoller({
    url: PET_STATE_URL,
    intervalMs: PET_POLL_INTERVAL_MS,
    fetchImpl: (url, init) => fetch(url, init),
    onState: (state) => {
      stateForwarder.onState(state)
      applyRemoteSettings(state)
    },
  })
  petPoller.start()
}

function startPetWindow(): BrowserWindow {
  const win = createPetWindow(petSize)
  attachPetMenu(win)
  startPetPoller(win)
  return win
}

app
  .whenReady()
  .then(() => {
    petSize = readPetSize()
    petSettings = { size: petSize, skin: '' }
    sizeSync = { current: petSize, pending: null }
    registerAssetProtocol()
    skinCatalog = scanSkins(appFile('assets'))
    startPetWindow()
    // 窗口先建好再报到，服务端的 online 才真的代表「窗口起来了」。
    startPetHeartbeat()

    app.on('activate', () => {
      if (!petWindow || petWindow.isDestroyed()) {
        startPetWindow()
      } else {
        petWindow.show()
        petWindow.focus()
      }
    })
  })
  .catch((error: unknown) => {
    console.error('[desktop-pet] failed to start', error)
    app.quit()
  })

app.on('before-quit', () => {
  endDrag()
  flushPosition()
  stopPetHeartbeat()
  petPoller?.stop()
  petPoller = null
  petWindow = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
