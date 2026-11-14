import { app, BrowserWindow, ipcMain, Menu, protocol, screen } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { createPoller, createStateForwarder, type Poller } from './poller'
import { sendChat } from '../renderer/chat'
import { applyIgnoreMouse, clampWindowToDisplays, createPetWindow, flushPosition } from './window'
import { readPetSize, savePetSize } from './settings'
import { windowSizeFor } from './size'

const PET_STATE_URL = 'http://127.0.0.1:8788/api/fish/pet/state'
const PET_POLL_INTERVAL_MS = 2000

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

/** 改尺寸：窗口按比例缩放，先夹回工作区，再把新尺寸推给渲染进程。 */
function changePetSize(win: BrowserWindow, size: number): void {
  petSize = savePetSize(size)
  if (win.isDestroyed()) return
  const { width, height } = windowSizeFor(petSize)
  win.setSize(width, height)
  clampWindowToDisplays(win)
  win.webContents.send('pet:size', petSize)
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
})

ipcMain.handle('pet:get-size', () => petSize)

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
    onState: (state) => stateForwarder.onState(state),
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
    registerAssetProtocol()
    startPetWindow()

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
  petPoller?.stop()
  petPoller = null
  petWindow = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
