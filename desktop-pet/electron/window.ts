import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions, type Display } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clampToDisplays, defaultPosition, ensureVisible } from './pointer'
import { PET_SIZE_DEFAULT, windowSizeFor } from './size'

/** 窗口移动会连发 `moved`，攒一下再落盘。 */
const POSITION_SAVE_DELAY_MS = 300

type SavedPosition = { x: number; y: number }

const ignoreState = new WeakMap<BrowserWindow, boolean>()

let pendingSave: ReturnType<typeof setTimeout> | null = null
let pendingWindow: BrowserWindow | null = null

function positionFile(): string {
  return join(app.getPath('userData'), 'position.json')
}

function readSavedPosition(): SavedPosition | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(positionFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.x !== 'number' || typeof record.y !== 'number') return null
    if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return null
    return { x: Math.round(record.x), y: Math.round(record.y) }
  } catch {
    // 文件不存在/损坏都按“没有保存过位置”处理，不阻塞启动。
    return null
  }
}

function savePosition(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const [x, y] = win.getPosition()
    writeFileSync(positionFile(), JSON.stringify({ x, y }), 'utf8')
  } catch (error) {
    console.warn('[desktop-pet] 保存窗口位置失败', error)
  }
}

function schedulePositionSave(win: BrowserWindow): void {
  pendingWindow = win
  if (pendingSave) clearTimeout(pendingSave)
  pendingSave = setTimeout(() => {
    pendingSave = null
    const target = pendingWindow
    pendingWindow = null
    if (target) savePosition(target)
  }, POSITION_SAVE_DELAY_MS)
}

/** 退出前把防抖队列里没写完的位置补上。 */
export function flushPosition(): void {
  if (pendingSave) clearTimeout(pendingSave)
  pendingSave = null
  const target = pendingWindow
  pendingWindow = null
  if (target) savePosition(target)
}

/** 主屏放第一位：窗口完全离屏时用它兜底。 */
function displaysWithPrimaryFirst(): Display[] {
  const primary = screen.getPrimaryDisplay()
  return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)]
}

/**
 * 拖拽结束时只保证“还看得见”（允许贴边/半出屏）；
 * 显示器变化或启动时则完整夹回工作区，避免换屏后找不到宠物。
 */
export function clampWindowToDisplays(win: BrowserWindow, allowPartial = false): void {
  if (win.isDestroyed()) return
  const displays = displaysWithPrimaryFirst()
  const [x, y] = win.getPosition()
  const [width, height] = win.getSize()
  const bounds = { x, y, width, height }
  const next = allowPartial
    ? ensureVisible(bounds, displays, (display) => display.workArea, displays[0])
    : clampToDisplays(bounds, displays, (display) => display.workArea, displays[0])
  if (next.x !== x || next.y !== y) win.setPosition(next.x, next.y)
}

/**
 * 默认整窗穿透；只有渲染进程报告指针在身体/UI 上（或拖拽中）才切成可交互。
 * `forward: true` 让穿透状态下仍能收到鼠标移动，才有机会翻回来。
 */
export function applyIgnoreMouse(win: BrowserWindow, ignore: boolean): void {
  if (win.isDestroyed()) return
  if (ignoreState.get(win) === ignore) return
  ignoreState.set(win, ignore)
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

/**
 * 程序化改窗口尺寸。
 *
 * Windows 下 `resizable:false` 的窗口会**忽略 `setSize`**（实测 438×305 调 358×260
 * 完全不动）。无边框窗口本来也没有拖拽边框，所以这里临时放开 resizable、改完
 * 再关回去，既能让工作台下发尺寸，又不给用户留下可拉伸的边。
 */
export function resizePetWindow(win: BrowserWindow, size: number): void {
  if (win.isDestroyed()) return
  const { width, height } = windowSizeFor(size)
  const wasResizable = win.isResizable()
  if (!wasResizable) win.setResizable(true)
  win.setSize(width, height)
  if (!wasResizable) win.setResizable(false)
  clampWindowToDisplays(win)
}

export function createPetWindow(size: number = PET_SIZE_DEFAULT): BrowserWindow {
  const displays = displaysWithPrimaryFirst()
  const saved = readSavedPosition()
  const { width, height } = windowSizeFor(size)

  const options: BrowserWindowConstructorOptions = {
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }

  // 从没保存过位置时放主屏右下角；保存过的位置要按当前显示器夹一遍。
  const initial = saved ?? defaultPosition(displays[0].workArea, width, height)
  const position = clampToDisplays(
    { ...initial, width, height },
    displays,
    (display) => display.workArea,
    displays[0],
  )
  options.x = position.x
  options.y = position.y

  const win = new BrowserWindow(options)
  applyIgnoreMouse(win, true)

  win.on('moved', () => schedulePositionSave(win))

  const onDisplaysChanged = (): void => clampWindowToDisplays(win)
  screen.on('display-removed', onDisplaysChanged)
  screen.on('display-metrics-changed', onDisplaysChanged)
  win.on('closed', () => {
    screen.removeListener('display-removed', onDisplaysChanged)
    screen.removeListener('display-metrics-changed', onDisplaysChanged)
    if (pendingWindow === win) {
      if (pendingSave) clearTimeout(pendingSave)
      pendingSave = null
      pendingWindow = null
    }
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(app.getAppPath(), 'dist-renderer', 'index.html'))
  }

  return win
}
