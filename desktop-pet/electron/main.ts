import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, screen, shell, Tray, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { mergeActionCatalogs, parseActions, type ActionDefinition } from './actions'
import { createPoller, createStateForwarder, type Poller } from './poller'
import { sendChat } from '../renderer/chat'
import { applyIgnoreMouse, clampWindowToDisplays, createPetWindow, flushPosition, resetPetPosition, resizePetWindow } from './window'
import { DEFAULT_LOOK, noteLocalLook, readRemoteLook, resolveRemoteLook, type BubbleLook, type LookSyncState } from './look'
import { buildMenuModel, type MenuItemModel } from './menu-model'
import { OPEN_PROTOCOL, protocolTarget } from './open-link'
import { readPetSize, savePetSize } from './settings'
import { clampPetSize } from './size'
import {
  createSkinForwarder,
  decideSkinLoad,
  noteLocalSize,
  resolveRemoteSize,
  scanSkins,
  shouldApplySettings,
  skinRefusal,
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

const WORKBENCH_PET_URL = 'http://127.0.0.1:8788/#her/pet'
const PRESENCE_MODE_URL = 'http://127.0.0.1:8788/api/fish/presence/mode'

export type PetActionMessage = { motion: string } | { action: string }

export interface PetActionCatalogEntry {
  id: string
  label: string
  group: string
}

export interface PetActionReloadResult {
  ok: boolean
  actions: PetActionCatalogEntry[]
  error?: string
  stale?: boolean
}

let petPoller: Poller | null = null
let petWindow: BrowserWindow | null = null
let petSize = 400
/** 最近一次应用/尝试应用的设置；用来让每 2 秒重复下发的同一份设置保持幂等。 */
let petSettings: PetSettings = { size: petSize, skin: '' }
/** 已同时提交给 renderer 的皮肤；`petSettings.skin` 只代表服务端请求意图。 */
let activeSkinId = ''
/** 启动时扫描到的本地皮肤；只用于 hello 上报，实际加载按需读盘复核。 */
let skinCatalog: ScannedSkin[] = [{ id: '', name: '默认', config: null }]
let helloTimer: ReturnType<typeof setInterval> | null = null
/** 皮肤加载的单调序号：慢的旧请求不能覆盖后来的新请求。 */
let skinRevision = 0
/** 本地尺寸覆盖：服务端回声前不让旧值把窗口拉回去。 */
let sizeSync: SizeSyncState = { current: petSize, pending: null }
/** 气泡外观：同样本地优先，回声前不被旧的远端值拉回去。 */
let petLook: BubbleLook = DEFAULT_LOOK
let lookSync: LookSyncState = { current: DEFAULT_LOOK, pending: null }
/** 托盘「隐藏」只存内存，重启后默认可见。 */
let petHidden = false
let tray: Tray | null = null
/** 最近一次 `/pet/state` 里的陪看状态，托盘菜单用。 */
let lastPresence: { on: boolean; mode: string | null } | null = null
/** 当前默认注册表 + 当前皮肤覆盖后的完整动作；菜单、渲染进程与 hello 共用。 */
let actionCatalog: ActionDefinition[] = []
let lastActionError: string | null = null
/** 每次 reload 争用所有权、每次皮肤提交完成时递增；旧异步任务不得再提交。 */
let actionCatalogGeneration = 0

/**
 * 皮肤推送缓存：首推可能早于渲染进程注册 `onSkin`（和 `pet:state` 同样的竞态）。
 * 渲染进程挂载时用 `pet:get-skin` 主动拉取，`pet:ready` 时再补发一次。
 */
const skinForwarder = createSkinForwarder((payload) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:skin', payload)
})

/** 最近一次皮肤拒绝；渲染进程订阅可能晚于首推，`pet:ready` 时补发。 */
let lastSkinError: { id: string; why: string } | null = null

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toActionMessage(kind: 'motion' | 'action', value: string): PetActionMessage {
  return kind === 'motion' ? { motion: value } : { action: value }
}

/** 旧版 preload/renderer 仍可能发纯 motion 字符串；入站时统一成新 union。 */
export function normalizeActionMessage(value: unknown): PetActionMessage | null {
  if (typeof value === 'string') {
    const motion = value.trim()
    return motion === '' ? null : { motion }
  }
  if (!isRecord(value)) return null

  const hasMotion = Object.hasOwn(value, 'motion')
  const hasAction = Object.hasOwn(value, 'action')
  if (hasMotion === hasAction) return null

  const field = hasMotion ? 'motion' : 'action'
  const raw = value[field]
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  if (id === '') return null
  return field === 'motion' ? { motion: id } : { action: id }
}

export function actionCatalogEntries(actions: readonly ActionDefinition[]): PetActionCatalogEntry[] {
  return actions.map(({ id, label, group }) => ({ id, label, group }))
}

export function toHelloPayload(
  version: string,
  skins: readonly ScannedSkin[],
  actions: readonly ActionDefinition[],
): {
  version: string
  skins: Array<{ id: string; name: string }>
  actions: PetActionCatalogEntry[]
} {
  return {
    version,
    skins: skins.map(({ id, name }) => ({ id, name })),
    actions: actionCatalogEntries(actions),
  }
}

export function sendActionMessage(win: BrowserWindow | null, payload: PetActionMessage): void {
  if (win && !win.isDestroyed()) win.webContents.send('pet:action', payload)
}

export function sendActionCatalog(win: BrowserWindow | null, actions: readonly ActionDefinition[]): void {
  if (win && !win.isDestroyed()) {
    // renderer 要用 anim/seq/loop 改写借用槽；hello/reload 结果仍只暴露公开元数据。
    win.webContents.send('pet:action-catalog', mergeActionCatalogs(actions, []))
  }
}

export function sendActionStop(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.webContents.send('pet:action-stop')
}

function sendActionError(win: BrowserWindow | null, error: { why: string }): void {
  if (win && !win.isDestroyed()) win.webContents.send('pet:action-error', error)
}

function reportActionError(why: string, win: BrowserWindow | null = petWindow): void {
  lastActionError = why
  console.warn(`[desktop-pet] ${why}`)
  sendActionError(win, { why })
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
    resizePetWindow(win, petSize)
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
async function syncPetConfig(update: { size?: number; skin?: string; bubbleOpacity?: number; bubbleWidth?: number }): Promise<boolean> {
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

/** 改气泡外观：立即推给渲染进程，并尽力写回服务端（失败只影响工作台显示）。 */
function changePetLook(
  win: BrowserWindow,
  look: BubbleLook,
  { sync = true, local = true }: { sync?: boolean; local?: boolean } = {},
): void {
  petLook = look
  lookSync = local ? noteLocalLook(look) : { ...lookSync, current: look }
  if (!win.isDestroyed()) win.webContents.send('pet:look', look)
  if (sync) void syncPetConfig({ bubbleOpacity: look.opacity, bubbleWidth: look.width })
}

/** 心跳：窗口真的起来了才让服务端判 online。失败静默，不刷屏。 */
async function sendHello(): Promise<void> {
  try {
    const response = await fetch(PET_HELLO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toHelloPayload(app.getVersion(), skinCatalog, actionCatalog)),
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function missingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

async function readActionRegistry(file: string, mediaDir: string, label: string): Promise<ActionDefinition[]> {
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    // 动作表是可选扩展；还没登记任何动作时不需要把它当成启动失败。
    if (missingFile(error)) return []
    throw new Error(`${label}动作注册表读不了：${errorText(error)}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    throw new Error(`${label}动作注册表 JSON 不合法：${errorText(error)}`)
  }
  if (!isRecord(raw) || !Array.isArray(raw.actions)) {
    throw new Error(`${label}动作注册表必须是包含 actions 数组的对象。`)
  }

  const result = parseActions(raw, {
    mediaDir,
    exists: existsSync,
    log: (message) => console.warn(`[desktop-pet] ${label}${message}`),
  })
  return result.actions
}

/** 读默认 actions.json，再用当前皮肤 actions.json 覆盖同 id 条目。 */
export async function readActionCatalog(assetsRoot: string, skinId: string): Promise<ActionDefinition[]> {
  if (skinId !== '' && !SIMPLE_SKIN_ID.test(skinId)) {
    throw new Error('皮肤 id 不合法，无法读取动作注册表。')
  }

  const defaults = await readActionRegistry(
    join(assetsRoot, 'actions.json'),
    join(assetsRoot, 'webm'),
    '默认',
  )
  if (skinId === '') return mergeActionCatalogs(defaults, [])

  const skinRoot = join(assetsRoot, 'skins', skinId)
  const skinActions = await readActionRegistry(
    join(skinRoot, 'actions.json'),
    join(skinRoot, 'webm'),
    `皮肤 ${skinId} 的`,
  )
  return mergeActionCatalogs(defaults, skinActions)
}

export type ReadActionCatalog = (assetsRoot: string, skinId: string) => Promise<ActionDefinition[]>

function setActionCatalog(actions: readonly ActionDefinition[], win: BrowserWindow | null = petWindow): void {
  actionCatalog = mergeActionCatalogs(actions, [])
  // 右键/托盘菜单每次打开都从 actionCatalog 现建，更新这里就是菜单重建。
  sendActionCatalog(win, actionCatalog)
}

/**
 * 手动重载只读磁盘一次。失败时保留上一份 catalog，播放器收到 stop，
 * 并把可读原因送到 renderer；成功才推 catalog、立即 hello。
 */
export async function reloadRegisteredActions(
  win: BrowserWindow | null = petWindow,
  assetsRoot: string = appFile('assets'),
  readCatalog: ReadActionCatalog = readActionCatalog,
): Promise<PetActionReloadResult> {
  const skinId = activeSkinId
  const generation = ++actionCatalogGeneration
  sendActionStop(win)
  try {
    const next = await readCatalog(assetsRoot, skinId)
    if (generation !== actionCatalogGeneration || skinId !== activeSkinId) {
      return {
        ok: false,
        stale: true,
        actions: actionCatalogEntries(actionCatalog),
        error: '动作目录已被更新的重载或皮肤切换替代，未提交旧结果。',
      }
    }
    setActionCatalog(next, win)
    lastActionError = null
    void sendHello()
    return { ok: true, actions: actionCatalogEntries(actionCatalog) }
  } catch (error) {
    if (generation !== actionCatalogGeneration || skinId !== activeSkinId) {
      return {
        ok: false,
        stale: true,
        actions: actionCatalogEntries(actionCatalog),
        error: '动作目录已被更新的重载或皮肤切换替代，未提交旧结果。',
      }
    }
    const why = `动作没重新载入，继续用上一份：${errorText(error)}`
    reportActionError(why, win)
    return { ok: false, actions: actionCatalogEntries(actionCatalog), error: why }
  }
}

/**
 * 皮肤被拒绝：保留当前皮肤，并把原因送到渲染进程。
 *
 * 只写 console.warn 时用户在工作台选了坏皮肤却看不到任何提示，
 * 所以统一发 `pet:skin-error { id, why }`，由渲染进程弹「皮肤没载入」。
 */
function reportSkinError(id: string, why: string, win: BrowserWindow | null = petWindow): void {
  const payload = skinRefusal(id, why)
  lastSkinError = payload
  console.warn(`[desktop-pet] 皮肤 ${id || '默认'} 没载入，保留当前皮肤：${payload.why}`)
  if (win && !win.isDestroyed()) win.webContents.send('pet:skin-error', payload)
}

/**
 * 按 id 加载皮肤并推给渲染进程。默认皮肤回到现有 `config.json` + `assets/webm`。
 *
 * 先记录服务端意图（`petSettings.skin`），这样同一份失败设置不会每 2 秒重试并刷日志；
 * 但渲染进程只在校验通过（含 14 个动画文件齐全）后收到新皮肤，失败时继续用旧皮肤。
 */
export interface ApplySkinOptions {
  win?: BrowserWindow | null
  assetsRoot?: string
  readCatalog?: ReadActionCatalog
}

export async function applySkin(id: string, options: ApplySkinOptions = {}): Promise<void> {
  const revision = ++skinRevision
  petSettings = { ...petSettings, skin: id }
  const win = options.win === undefined ? petWindow : options.win
  const assetsRoot = options.assetsRoot ?? appFile('assets')
  const loadCatalog = options.readCatalog ?? readActionCatalog

  async function applyValidatedSkin(config: unknown, uri: string): Promise<void> {
    let nextActions: ActionDefinition[]
    try {
      nextActions = await loadCatalog(assetsRoot, id)
    } catch (error) {
      throw new Error(`动作注册表没载入：${errorText(error)}`)
    }
    if (revision !== skinRevision) return

    // 新皮肤会替换全部动画映射；先让播放器结束旧 generation 的借用槽。
    sendActionStop(win)
    lastSkinError = null
    lastActionError = null
    skinForwarder.onSkin({ id, revision, config, uri })
    setActionCatalog(nextActions, win)
    // skin forwarder 与动作 catalog 都成功后，这个 id 才成为 reload 可信的已提交皮肤。
    activeSkinId = id
    actionCatalogGeneration += 1
    // 皮肤与动作目录都在同一成功点生效，随后马上刷新服务端可接受的 action id。
    void sendHello()
  }

  if (id === '') {
    let config: unknown
    try {
      config = JSON.parse(await readFile(join(assetsRoot, 'config.json'), 'utf8'))
    } catch (error) {
      if (revision === skinRevision) {
        reportSkinError('', `默认皮肤配置没载入：${errorText(error)}`, win)
      }
      return
    }
    try {
      await applyValidatedSkin(config, DEFAULT_SKIN_URI)
    } catch (error) {
      if (revision === skinRevision) reportSkinError('', errorText(error), win)
    }
    return
  }

  if (!SIMPLE_SKIN_ID.test(id)) {
    reportSkinError(id, '皮肤 id 不合法。', win)
    return
  }

  const skinDir = join(assetsRoot, 'skins', id)
  const file = normalize(join(skinDir, 'skin.json'))
  if (!isInside(assetsRoot, file)) {
    reportSkinError(id, '皮肤路径越界。', win)
    return
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (revision !== skinRevision) return
    const decision = decideSkinLoad(parsed, skinDir)
    if (!decision.ok) {
      reportSkinError(id, decision.why, win)
      return
    }
    await applyValidatedSkin(decision.config, `pet-asset://local/skins/${id}/webm`)
  } catch (error) {
    if (revision === skinRevision) {
      const why = errorText(error)
      reportSkinError(id, why.startsWith('动作注册表') ? why : `读不了 skin.json：${why}`, win)
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

  const remoteLook = readRemoteLook(state)
  if (remoteLook) {
    const decision = resolveRemoteLook(lookSync, remoteLook)
    lookSync = decision.state
    if (decision.apply && petWindow && !petWindow.isDestroyed()) {
      changePetLook(petWindow, decision.apply, { sync: false, local: false })
    }
  }

  if (typeof next.skin === 'string' && shouldApplySettings(petSettings, { skin: next.skin })) {
    void applySkin(next.skin)
  }
}

function toElectronItems(items: MenuItemModel[]): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.separator) return { type: 'separator' as const }
    const out: MenuItemConstructorOptions = { label: item.label }
    if (item.submenu) out.submenu = toElectronItems(item.submenu)
    else if (item.checked !== undefined) {
      out.type = 'radio'
      out.checked = item.checked
    }
    if (item.click) out.click = item.click
    return out
  })
}

/** 陪看模式开关：经工作台 BFF 走现有 `/presence/mode`；点托盘本身就是用户的明确操作。 */
async function setPresence(mode: 'off' | 'event' | 'ambient' | 'work'): Promise<void> {
  const target = mode === 'off' ? lastPresence?.mode : mode
  if (!target) return
  try {
    await fetch(PRESENCE_MODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: target, on: mode !== 'off' }),
      signal: AbortSignal.timeout(PET_REQUEST_TIMEOUT_MS),
    })
  } catch {
    // 工作台没起来就算了；下一拍状态会如实反映。
  }
}

function setPetHidden(hidden: boolean): void {
  petHidden = hidden
  const win = petWindow
  if (!win || win.isDestroyed()) return
  if (hidden) win.hide()
  else win.showInactive()
}

function buildMenu(kind: 'context' | 'tray'): Menu {
  const win = petWindow
  const model = buildMenuModel(
    { size: petSize, opacity: petLook.opacity, width: petLook.width, hidden: petHidden, presence: lastPresence },
    actionCatalog,
    {
      motion: (motion) => sendActionMessage(win, toActionMessage('motion', motion)),
      action: (id) => sendActionMessage(win, toActionMessage('action', id)),
      stop: () => sendActionStop(win),
      reload: () => void reloadRegisteredActions(win),
      size: (size) => win && changePetSize(win, size),
      opacity: (opacity) => win && changePetLook(win, { ...petLook, opacity }),
      width: (width) => win && changePetLook(win, { ...petLook, width }),
      toggleHidden: () => setPetHidden(!petHidden),
      resetPosition: () => {
        if (!win || win.isDestroyed()) return
        resetPetPosition(win)
        if (petHidden) setPetHidden(false)
      },
      presence: (mode) => void setPresence(mode),
      openWorkbench: () => void shell.openExternal(WORKBENCH_PET_URL),
      quit: () => app.quit(),
    },
    kind,
  )
  return Menu.buildFromTemplate(toElectronItems(model))
}

function attachPetMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', () => {
    if (win.isDestroyed()) return
    buildMenu('context').popup({ window: win })
  })
}

/** 通知区图标：左键/双击切换显示，右键弹菜单。窗口隐藏后这里是唯一的恢复入口。 */
function createPetTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(appFile('assets', 'tray.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('大肥鱼桌宠')
  tray.on('click', () => setPetHidden(!petHidden))
  tray.on('double-click', () => setPetHidden(!petHidden))
  tray.on('right-click', () => tray?.popUpContextMenu(buildMenu('tray')))
}

/**
 * 缓存最近状态并去重；渲染进程订阅完成（`pet:ready`）后补发一次，
 * 避免首拍 IPC 早于订阅被丢掉。
 */
const stateForwarder = createStateForwarder((state) => {
  const presence = state && typeof state === 'object' ? (state as Record<string, unknown>).presence : null
  if (presence && typeof presence === 'object') {
    const p = presence as Record<string, unknown>
    lastPresence = { on: p.on === true, mode: typeof p.mode === 'string' ? p.mode : null }
  }
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:state', state)
})

ipcMain.on('pet:ready', () => {
  stateForwarder.resend()
  // 皮肤可能早于渲染进程订阅就绪：就绪后补发最近一份。
  skinForwarder.ready()
  sendActionCatalog(petWindow, actionCatalog)
  if (lastSkinError && petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:skin-error', lastSkinError)
  }
  if (lastActionError) sendActionError(petWindow, { why: lastActionError })
})

ipcMain.handle('pet:get-size', () => petSize)
ipcMain.handle('pet:get-look', () => petLook)
ipcMain.handle('pet:get-action-catalog', () => mergeActionCatalogs(actionCatalog, []))
ipcMain.handle('pet:actions-reload', () => reloadRegisteredActions())

/** 渲染进程挂载时主动拉取最近皮肤，避免首推丢失后一直停在默认皮肤。 */
ipcMain.handle('pet:get-skin', () => skinForwarder.get())

// 旧 renderer 可能仍通过 requestAction(string) 回送动作；按新 union 转发给同一播放桥。
ipcMain.on('pet:action-request', (event, raw: unknown) => {
  const message = normalizeActionMessage(raw)
  if (!message) return
  if ('action' in message && !actionCatalog.some((action) => action.id === message.action)) return
  sendActionMessage(BrowserWindow.fromWebContents(event.sender), message)
})

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
    return await sendChat(text, { target: 'companion', fetchImpl: (url, init) => fetch(url, init) })
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

/** 把桌宠带到前台：窗口没了就重建，隐藏了就显示。工作台「打开桌宠」和重复启动都走这里。 */
function showPet(): void {
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = startPetWindow()
    return
  }
  if (petWindow.isMinimized()) petWindow.restore()
  setPetHidden(false)
}

/** 登记 bigfishpet:// 到当前用户（HKCU），之后工作台链接才能拉起壳。失败只记日志。 */
function registerOpenProtocol(): void {
  try {
    const { exec, args } = protocolTarget({
      execPath: process.execPath,
      portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
      defaultApp: process.defaultApp,
      appArg: process.argv[1] ? resolve(process.argv[1]) : undefined,
    })
    if (!app.setAsDefaultProtocolClient(OPEN_PROTOCOL, exec, args)) {
      console.warn('[desktop-pet] 登记 bigfishpet:// 协议没成功，工作台打开按钮可能无效')
    }
  } catch (error) {
    console.warn('[desktop-pet] 登记协议出错', error)
  }
}

// 只留一个壳：再次启动（包括点工作台链接）只把已有窗口带到前台。
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) app.quit()
else app.on('second-instance', () => showPet())

if (gotInstanceLock) app
  .whenReady()
  .then(async () => {
    petSize = readPetSize()
    petSettings = { size: petSize, skin: '' }
    activeSkinId = ''
    sizeSync = { current: petSize, pending: null }
    registerAssetProtocol()
    registerOpenProtocol()
    skinCatalog = scanSkins(appFile('assets'))
    try {
      actionCatalog = mergeActionCatalogs(await readActionCatalog(appFile('assets'), activeSkinId), [])
    } catch (error) {
      // 动作表坏了不拦桌宠启动；菜单先空着，手动重载可保留/恢复上一份。
      reportActionError(`启动时动作没载入：${errorText(error)}`, null)
    }
    startPetWindow()
    createPetTray()
    // 窗口先建好再报到，服务端的 online 才真的代表「窗口起来了」。
    startPetHeartbeat()

    app.on('activate', () => {
      if (!petWindow || petWindow.isDestroyed()) {
        startPetWindow()
      } else {
        setPetHidden(false)
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
  tray?.destroy()
  tray = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
