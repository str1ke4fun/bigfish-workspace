import { app, BrowserWindow, ipcMain, Menu, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { createPoller, createStateForwarder, type Poller } from './poller'
import { applyIgnoreMouse, createPetWindow, flushPosition } from './window'

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

let petPoller: Poller | null = null
let petWindow: BrowserWindow | null = null

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
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
      return new Response(body, {
        headers: {
          'content-type': type,
          'access-control-allow-origin': '*',
        },
      })
    } catch {
      return new Response('not found', { status: 404, headers: { 'access-control-allow-origin': '*' } })
    }
  })
}

function sendAction(win: BrowserWindow, motion: string): void {
  if (!win.isDestroyed()) win.webContents.send('pet:action', motion)
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

ipcMain.on('pet:ignore-mouse', (event, ignore: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) applyIgnoreMouse(win, ignore === true)
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
  const win = createPetWindow()
  attachPetMenu(win)
  startPetPoller(win)
  return win
}

app
  .whenReady()
  .then(() => {
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
  flushPosition()
  petPoller?.stop()
  petPoller = null
  petWindow = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
