import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { createPoller, createStateForwarder, type Poller } from './poller'

const WINDOW_WIDTH = 500
const WINDOW_HEIGHT = 340

const PET_STATE_URL = 'http://127.0.0.1:8788/api/fish/pet/state'
const PET_POLL_INTERVAL_MS = 2000

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

export function createPetWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: appFile('dist-electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(appFile('dist-renderer', 'index.html'))
  }

  return win
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

app
  .whenReady()
  .then(() => {
    registerAssetProtocol()
    startPetPoller(createPetWindow())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) startPetPoller(createPetWindow())
    })
  })
  .catch((error: unknown) => {
    console.error('[desktop-pet] failed to start', error)
    app.quit()
  })

app.on('before-quit', () => {
  petPoller?.stop()
  petPoller = null
  petWindow = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
