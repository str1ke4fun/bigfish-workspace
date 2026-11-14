import { app, BrowserWindow, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const WINDOW_WIDTH = 500
const WINDOW_HEIGHT = 340

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

app
  .whenReady()
  .then(() => {
    registerAssetProtocol()
    createPetWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    })
  })
  .catch((error: unknown) => {
    console.error('[desktop-pet] failed to start', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
