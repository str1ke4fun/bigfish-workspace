import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Pet,
  useControllablePet,
  type DshPetConfig,
  type PetRef,
} from 'dsh-pet-component'
import { shouldIgnoreMouse } from '../electron/pointer'
import { resolveSkinApply, type SkinRef } from '../electron/skin-apply'
import {
  decideEffects,
  emptySeen,
  performedMotion,
  reducePlayback,
  type PerformedMotion,
  type PlaybackAction,
  type PlaybackEvent,
  type PlaybackSlot,
  type PlaybackState,
  type PetMotion,
  type PetState,
  type Seen,
} from './controller'
import {
  borrowActionConfig,
  chatReplyPlaybackDecision,
  chatThinkingPlan,
  createPlaybackCallbackArbiter,
  pendingServerActionAfterPlaybackEvent,
  petErrorTarget,
  petMotionProp,
  petUriProp,
  restoreCompletedEvent,
  restoreActionConfig,
} from './playback-adapter'
import type { ChatResult } from './chat'
import {
  BUBBLE_OPACITY_DEFAULT,
  clampBubbleOpacity,
  clampBubbleWidth,
  createPager,
  defaultBubbleWidth,
  PAGE_BUBBLE_ID,
  pageBubble,
} from './bubble-pages'

declare global {
  interface Window {
    petBridge?: {
      onState(handler: (state: unknown) => void): () => void
      onAction?(handler: (payload: { motion: string } | { action: string } | string) => void): () => void
      onActionCatalog?(handler: (catalog: unknown) => void): () => void
      getActionCatalog?(): Promise<unknown>
      onActionStop?(handler: () => void): () => void
      onActionError?(handler: (error: unknown) => void): () => void
      setIgnoreMouse?(ignore: boolean): void
      /** 通知主进程补发最近一次缓存状态；老 preload 没有时退回只等下一拍。 */
      ready?(): void
      /** 把用户原话交给主进程请求 /api/fish/say；老 preload 没有时提示说不了。 */
      requestChat?(text: string): Promise<ChatResult>
      /** 拖拽窗口：在宠物身体上按下/松开时通知主进程。 */
      startDrag?(): void
      endDrag?(): void
      /** 当前宠物尺寸与尺寸变化。 */
      getSize?(): Promise<number>
      onSize?(handler: (size: number) => void): () => void
      /** 服务端设置切换皮肤后，主进程推来校验过的 config 与素材基地址。 */
      onSkin?(handler: (skin: unknown) => void): () => void
      /** 挂载时主动拉取最近皮肤，避免首推早于订阅时丢失。 */
      getSkin?(): Promise<unknown>
      /** 主进程拒绝载入皮肤时推来 { id, why }；渲染进程据此弹提示。 */
      onSkinError?(handler: (error: unknown) => void): () => void
      /** 气泡外观：透明度 % 与最大宽度 px（0 = 跟随大小）。 */
      getLook?(): Promise<{ opacity: number; width: number }>
      onLook?(handler: (look: { opacity: number; width: number }) => void): () => void
    }
  }
}

const CONFIG_URL = 'pet-asset://local/config.json'
const ASSET_BASE = 'pet-asset://local/webm'
const PET_SIZE_DEFAULT = 400
const SEEN_STORAGE_KEY = 'desktop-pet:seen'
const BUBBLE_TIMEOUT_MS = 10_000
/** 对话的加载/失败气泡共用一个 key：失败时原地更新，不叠第二只气泡。 */
const CHAT_BUBBLE_ID = 'chat'
/** 气泡层指针事件是 none，只能按几何矩形判断；对话框与错误提示同理。 */
const UI_SELECTORS = '.dsh-pet__bubbles, .dsh-pet__dialogue, .pet-error'

function isPointerOverUi(x: number, y: number): boolean {
  for (const node of document.querySelectorAll<HTMLElement>(UI_SELECTORS)) {
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
  }
  return false
}

function loadSeen(): Seen {
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY)
    if (!raw) return emptySeen()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptySeen()
    const record = parsed as Record<string, unknown>
    // 只恢复去重游标；旧版本存过的 activity 字段直接忽略（它不是「已播放」）。
    return {
      lastActionId: typeof record.lastActionId === 'string' ? record.lastActionId : '',
      lastCommentAt: typeof record.lastCommentAt === 'string' ? record.lastCommentAt : '',
    }
  } catch {
    return emptySeen()
  }
}

function saveSeen(seen: Seen): void {
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen))
  } catch {
    // 无痕模式、配额满等场景：去重退化为本次会话内有效，不影响播放。
  }
}

/** 主进程推来的皮肤：config 是已校验过的 skin.json，uri 是素材基地址。 */
interface ActiveSkin extends SkinRef {
  config: DshPetConfig
  uri: string
}

interface WirePetAction {
  id: string
  motion?: string
  action?: string
  text?: string
  at: number
  ttlMs: number
}

interface WirePetState extends Omit<PetState, 'action'> {
  action: WirePetAction | null
}

type PlaybackCommand =
  | { type: 'clear' }
  | {
      type: 'play'
      motion: PlaybackSlot
      loop: boolean
      replay: true
      generation: number
      animation: string
      mediaUri: string
    }
  | { type: 'motion'; options: PerformedMotion }

interface PendingPlaybackBatch {
  id: number
  /** null = 命令应跟随当前皮肤 config；对象 = 必须等这份借用克隆 commit。 */
  config: DshPetConfig | null
  commands: PlaybackCommand[]
}

/** 容忍老 preload / 坏消息：字段不全的皮肤直接丢掉，绝不让渲染进程崩掉。 */
function parseSkin(raw: unknown): ActiveSkin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const message = raw as Record<string, unknown>
  if (typeof message.id !== 'string') return null
  if (typeof message.revision !== 'number' || !Number.isFinite(message.revision)) return null
  if (typeof message.uri !== 'string' || message.uri === '') return null
  if (!message.config || typeof message.config !== 'object' || Array.isArray(message.config)) return null
  return {
    id: message.id,
    revision: message.revision,
    config: message.config as DshPetConfig,
    uri: message.uri,
  }
}

/** 主进程拒绝皮肤时只带 { id, why }；why 为空时由调用方给兜底文案。 */
function skinErrorReason(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ''
  const why = (raw as Record<string, unknown>).why
  return typeof why === 'string' ? why.trim() : ''
}

function actionErrorReason(raw: unknown): string {
  return skinErrorReason(raw)
}

function parseActionMessage(raw: unknown): { kind: 'motion' | 'action'; value: string } | null {
  if (typeof raw === 'string') {
    const value = raw.trim()
    return value === '' ? null : { kind: 'motion', value }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const message = raw as Record<string, unknown>
  const hasMotion = Object.hasOwn(message, 'motion')
  const hasAction = Object.hasOwn(message, 'action')
  if (hasMotion === hasAction) return null
  const kind = hasMotion ? 'motion' : 'action'
  const value = message[kind]
  if (typeof value !== 'string' || value.trim() === '') return null
  return { kind, value: value.trim() }
}

/** 主进程已校验的完整动作目录再做一次渲染侧窄化，坏条目不会污染播放器。 */
function parseActionCatalog(raw: unknown): PlaybackAction[] {
  if (!Array.isArray(raw)) return []
  const actions: PlaybackAction[] = []
  const ids = new Set<string>()
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const group = typeof entry.group === 'string' ? entry.group.trim() : ''
    if (id === '' || label === '' || group === '' || ids.has(id)) continue

    const anim = typeof entry.anim === 'string' ? entry.anim.trim() : undefined
    const rawSeq = entry.seq
    const seq = Array.isArray(rawSeq)
      ? rawSeq.map((part) => (typeof part === 'string' ? part.trim() : '')).filter((part) => part !== '')
      : undefined
    if ((anim === undefined) === (seq === undefined)) continue
    if (anim !== undefined && anim === '') continue
    if (seq !== undefined && (!Array.isArray(rawSeq) || seq.length !== rawSeq.length)) continue

    const action: PlaybackAction = {
      id,
      label,
      loop: entry.loop === true,
      group,
    }
    if (anim !== undefined) action.anim = anim
    if (seq !== undefined) action.seq = seq
    if (typeof entry.mediaUri === 'string' && entry.mediaUri.trim() !== '') {
      action.mediaUri = entry.mediaUri.trim()
    }
    actions.push(action)
    ids.add(id)
  }
  return actions
}

export function App() {
  const [config, setConfig] = useState<DshPetConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 声明式稳态：activity / presence；一次性动作播完后由组件自动回落到它。 */
  const [steady, setSteady] = useState<PetMotion>('idle')
  const [size, setSize] = useState(PET_SIZE_DEFAULT)
  /** 服务端下发的皮肤；null = 默认皮肤（继续用 assets/config.json + assets/webm）。 */
  const [skin, setSkin] = useState<ActiveSkin | null>(null)
  /** 主进程最近一次成功提交的完整注册表；App 是播放侧唯一所有者。 */
  const [actionCatalog, setActionCatalog] = useState<PlaybackAction[]>([])
  const [playback, setPlayback] = useState<PlaybackState | null>(null)
  /** 借出 waving 时使用的 config 克隆；null = 直接使用当前皮肤 config。 */
  const [playbackConfig, setPlaybackConfig] = useState<DshPetConfig | null>(null)
  const [pendingBatch, setPendingBatch] = useState<PendingPlaybackBatch | null>(null)
  const activeConfig = skin?.config ?? config
  const activeUri = skin?.uri ?? ASSET_BASE
  const renderedConfig = playbackConfig ?? activeConfig
  const renderedMotion = petMotionProp(playback, steady)
  const renderedUri = petUriProp(playback, actionCatalog, activeUri)
  const petRef = useRef<PetRef>(null)
  /** 当前/上一个皮肤用 ref 同步记录，事件回调里读到的永远是最新值。 */
  const skinRef = useRef<ActiveSkin | null>(null)
  const previousSkinRef = useRef<ActiveSkin | null>(null)
  /** 运行期失败过的皮肤；防止 ready/getSkin 的重放立刻把回退撤销并形成循环。 */
  const failedSkinRef = useRef<SkinRef | null>(null)
  const pet = useControllablePet(petRef)
  const petApiRef = useRef(pet)
  petApiRef.current = pet
  const activeConfigRef = useRef<DshPetConfig | null>(activeConfig)
  activeConfigRef.current = activeConfig
  const actionCatalogRef = useRef<PlaybackAction[]>(actionCatalog)
  actionCatalogRef.current = actionCatalog
  const playbackRef = useRef<PlaybackState | null>(playback)
  playbackRef.current = playback
  const playbackConfigRef = useRef<DshPetConfig | null>(playbackConfig)
  playbackConfigRef.current = playbackConfig
  const latestSteadyRef = useRef<PetMotion>(steady)
  latestSteadyRef.current = steady
  /** 新命令先等待对应素材出现，再把后续动作回调绑定到它的 generation。 */
  const playbackCallbacks = useRef(createPlaybackCallbackArbiter()).current
  const playLegacyMotionRef = useRef<(value: string) => void>(() => {})
  /** state 可能早于 catalog 到达；等目录补上同一 id 后再启动，不丢 `/pet/act` 动作。 */
  const pendingServerActionRef = useRef<string | null>(null)
  /** 迟到的对话请求不得关闭/抢占更新请求的气泡与动作。 */
  const chatRequestGenerationRef = useRef(0)
  const batchIdRef = useRef(0)
  const executedBatchRef = useRef(0)
  const [look, setLook] = useState({ opacity: BUBBLE_OPACITY_DEFAULT, width: 0 })
  /** 长回复逐句翻：同一个气泡原地换字，新消息取消上一轮。 */
  const pagerRef = useRef<ReturnType<typeof createPager> | null>(null)
  if (!pagerRef.current) {
    pagerRef.current = createPager({
      show: (text, _index, motion) => {
        petApiRef.current.bubble(pageBubble(text))
        // 动作只在首句播一次（一次性，播完回落稳态），不挂在常驻气泡上。
        if (motion) playLegacyMotionRef.current(motion)
      },
      close: () => petApiRef.current.bubble.close(PAGE_BUBBLE_ID),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
  }

  const queuePlaybackCommands = useCallback(
    (config: DshPetConfig | null, commands: PlaybackCommand[]): void => {
      const expectedConfig = config ?? activeConfigRef.current
      if (!expectedConfig || commands.length === 0) return
      const id = batchIdRef.current + 1
      batchIdRef.current = id
      playbackConfigRef.current = config
      setPlaybackConfig(config)
      setPendingBatch({ id, config, commands })
    },
    [],
  )

  const dispatchPlayback = useCallback(
    (
      event: PlaybackEvent,
      options: { forceBase?: boolean; extraCommands?: PlaybackCommand[] } = {},
    ): void => {
      pendingServerActionRef.current = pendingServerActionAfterPlaybackEvent(
        pendingServerActionRef.current,
        event,
      )
      const result = reducePlayback(playbackRef.current, event, {
        actions: actionCatalogRef.current,
        steady: latestSteadyRef.current,
        now: Date.now(),
      })
      playbackRef.current = result.state
      setPlayback(result.state)

      let nextConfig = playbackConfigRef.current
      const commands: PlaybackCommand[] = []
      for (const effect of result.effects) {
        if (effect.type === 'bind-slot') {
          const base = activeConfigRef.current
          if (base) nextConfig = borrowActionConfig(base, effect.animation, effect.slot)
          continue
        }
        if (effect.type === 'play-motion') {
          const expectedAnimation = result.state.expectedAnimation
          if (expectedAnimation === null) continue
          const mediaUri = actionCatalogRef.current.find(
            (action) => action.id === result.state.actionId,
          )?.mediaUri ?? skinRef.current?.uri ?? ASSET_BASE
          commands.push({
            type: 'play',
            motion: effect.motion,
            loop: effect.loop,
            replay: true,
            generation: result.state.generation,
            animation: expectedAnimation,
            mediaUri,
          })
          continue
        }
        if (effect.type === 'clear-motion') {
          commands.push({ type: 'clear' })
          continue
        }
        if (effect.type === 'restore-slot') {
          if (nextConfig) nextConfig = restoreActionConfig(nextConfig, effect.slot)
        }
      }
      if (options.forceBase === true) nextConfig = null
      commands.push(...(options.extraCommands ?? []))
      if (options.forceBase === true && !commands.some((command) => command.type === 'clear')) {
        commands.unshift({ type: 'clear' })
      }

      if (nextConfig !== playbackConfigRef.current) {
        playbackConfigRef.current = nextConfig
        setPlaybackConfig(nextConfig)
      }
      if (commands.length > 0) queuePlaybackCommands(nextConfig, commands)
    },
    [queuePlaybackCommands],
  )

  const playLegacyMotion = useCallback(
    (value: string): void => {
      const options = performedMotion(value)
      if (!options) return
      const current = playbackRef.current
      if (current !== null && current.status !== 'idle') {
        dispatchPlayback(
          { type: 'stopAction' },
          { forceBase: true, extraCommands: [{ type: 'motion', options }] },
        )
        return
      }
      pendingServerActionRef.current = null
      playbackCallbacks.disarm()
      petApiRef.current.motion(options)
    },
    [dispatchPlayback, playbackCallbacks],
  )
  playLegacyMotionRef.current = playLegacyMotion

  const handleMotionChange = useCallback(
    (motion: PetMotion | 'dragging'): void => {
      const event = playbackCallbacks.motionChanged(motion)
      if (event !== null) dispatchPlayback(event)
    },
    [dispatchPlayback, playbackCallbacks],
  )

  const handleAnimationChange = useCallback(
    (animation: { name: string; once: boolean; src?: string | null; row?: number; column?: number } | null): void => {
      const event = playbackCallbacks.animationChanged(animation)
      if (event !== null) dispatchPlayback(event)
    },
    [dispatchPlayback, playbackCallbacks],
  )

  // config 先随 React commit 落到 <Pet>，再执行命令面；否则 pet.motion 会命中旧的 waving 映射。
  useEffect(() => {
    const batch = pendingBatch
    if (!batch || batch.id !== batchIdRef.current || renderedConfig === null) return
    if (batch.config !== null && renderedConfig !== batch.config) return
    if (batch.id <= executedBatchRef.current) return
    executedBatchRef.current = batch.id

    for (const command of batch.commands) {
      if (command.type === 'clear') {
        playbackCallbacks.disarm()
        petApiRef.current.clear()
        continue
      }
      if (command.type === 'play') {
        playbackCallbacks.arm(command.generation, command.animation, command.mediaUri)
        petApiRef.current.motion({
          type: command.motion,
          loop: command.loop,
          replay: command.replay,
        })
        continue
      }
      playbackCallbacks.disarm()
      petApiRef.current.motion(command.options)
    }

    const restoreCompletion = restoreCompletedEvent(playbackRef.current)
    if (restoreCompletion !== null) dispatchPlayback(restoreCompletion)
    setPendingBatch((current) => current?.id === batch.id ? null : current)
  }, [dispatchPlayback, pendingBatch, playbackCallbacks, renderedConfig])

  // 先订阅再主动拉一次，覆盖主进程 catalog 已提交但首推早于 renderer 挂载的竞态。
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const receive = (raw: unknown): void => {
      const next = parseActionCatalog(raw)
      actionCatalogRef.current = next
      setActionCatalog(next)
      const pendingAction = pendingServerActionRef.current
      if (pendingAction !== null && next.some((action) => action.id === pendingAction)) {
        pendingServerActionRef.current = null
        dispatchPlayback({ type: 'startAction', actionId: pendingAction })
      }
      const current = playbackRef.current
      if (current?.actionId && !next.some((action) => action.id === current.actionId)) {
        dispatchPlayback({ type: 'stopAction' }, { forceBase: true })
      }
    }

    try {
      unsubscribe = window.petBridge?.onActionCatalog?.(receive)
    } catch {
      unsubscribe = undefined
    }
    void window.petBridge
      ?.getActionCatalog?.()
      .then((raw) => {
        if (!cancelled) receive(raw)
      })
      .catch(() => {
        // 老 preload 没有 catalog API：现有 motion 菜单仍按旧路径播放。
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [dispatchPlayback])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = window.petBridge?.onActionStop?.(() => {
        dispatchPlayback({ type: 'stopAction' }, { forceBase: true })
      })
    } catch {
      unsubscribe = undefined
    }
    return () => unsubscribe?.()
  }, [dispatchPlayback])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = window.petBridge?.onAction?.((raw) => {
        const message = parseActionMessage(raw)
        if (!message) return
        if (message.kind === 'motion') {
          playLegacyMotion(message.value)
          return
        }
        dispatchPlayback({ type: 'startAction', actionId: message.value })
      })
    } catch {
      unsubscribe = undefined
    }
    return () => unsubscribe?.()
  }, [dispatchPlayback, playLegacyMotion])

  useEffect(() => {
    const bridge = window.petBridge
    void bridge?.getLook?.().then((value) => {
      if (value) setLook({ opacity: clampBubbleOpacity(value.opacity), width: clampBubbleWidth(value.width) })
    })
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = bridge?.onLook?.((value) =>
        setLook({ opacity: clampBubbleOpacity(value.opacity), width: clampBubbleWidth(value.width) }),
      )
    } catch {
      unsubscribe = undefined
    }
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    const bridge = window.petBridge
    let unsubscribe: (() => void) | undefined
    void bridge?.getSize?.().then((value) => {
      if (typeof value === 'number') setSize(value)
    })
    try {
      unsubscribe = bridge?.onSize?.((value) => {
        if (typeof value === 'number') setSize(value)
      })
    } catch {
      // 老 preload 没有 onSize：保持默认尺寸即可。
    }
    return () => unsubscribe?.()
  }, [])

  // 气泡宽度默认跟着宠物尺寸走；手动设了宽度就用手动值。透明度同理。
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--pet-bubble-max', `${look.width > 0 ? look.width : defaultBubbleWidth(size)}px`)
    root.setProperty('--pet-bubble-opacity', String(look.opacity / 100))
  }, [size, look])

  // 皮肤切换：主进程已经校验过 skin.json（含 14 个动画文件）并读好内容。
  // 先订阅再主动拉一次，覆盖「主进程首推早于本 effect 注册」的竞态。
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const receive = (raw: unknown): void => {
      const next = parseSkin(raw)
      if (!next) return
      const current = skinRef.current
      // 失败皮肤的重放（同一 revision）必须忽略；换皮肤或新 revision 才重新应用。
      if (resolveSkinApply(current, next, failedSkinRef.current) === 'ignore') return
      dispatchPlayback({ type: 'skinChanged' }, { forceBase: true })
      failedSkinRef.current = null
      previousSkinRef.current = current
      skinRef.current = next
      setSkin(next)
    }

    try {
      unsubscribe = window.petBridge?.onSkin?.(receive)
    } catch {
      unsubscribe = undefined
    }
    void window.petBridge
      ?.getSkin?.()
      .then((raw) => {
        if (!cancelled) receive(raw)
      })
      .catch(() => {
        // 老 preload 没有 getSkin：只能等后续推送。
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [dispatchPlayback])

  // 主进程拒绝载入皮肤（坏 JSON、缺动画文件、读盘失败）时保留当前皮肤并弹同一只提示：
  // 不依赖组件运行时的 onError，否则坏皮肤会在界面上完全静默。
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = window.petBridge?.onSkinError?.((raw) => {
        dispatchPlayback({ type: 'skinChanged' }, { forceBase: true })
        pet.bubble({
          id: 'skin-error',
          title: '皮肤没载入',
          description: skinErrorReason(raw) || '先继续用上一个皮肤。',
          variant: 'danger',
          timeout: 5000,
        })
      })
    } catch {
      unsubscribe = undefined
    }
    return () => unsubscribe?.()
  }, [dispatchPlayback, pet])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = window.petBridge?.onActionError?.((raw) => {
        pet.bubble({
          id: 'action-error',
          title: '动作没载入',
          description: actionErrorReason(raw) || '继续使用上一份动作目录。',
          variant: 'danger',
          timeout: 5000,
        })
      })
    } catch {
      unsubscribe = undefined
    }
    return () => unsubscribe?.()
  }, [pet])

  useEffect(() => {
    let cancelled = false

    fetch(CONFIG_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<DshPetConfig>
      })
      .then((loaded) => {
        if (!cancelled) setConfig(loaded)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeConfig) return
    let seen = loadSeen()
    let unsubscribe: (() => void) | undefined

    try {
      unsubscribe = window.petBridge?.onState((raw) => {
        const state = raw as WirePetState
        const now = Date.now()
        const previousActionId = seen.lastActionId
        const effect = decideEffects(seen, state as PetState, now)
        seen = effect.seen
        saveSeen(seen)

        // 稳态走声明式 prop；activity 更新只更新 ref，循环期间由 adapter 冻结实际 prop。
        latestSteadyRef.current = effect.steady
        setSteady(effect.steady)
        const action = state?.action ?? null
        const actionAlive = action !== null && now - action.at < action.ttlMs
        const customAction = actionAlive && typeof action?.action === 'string' ? action.action : null
        if (action !== null && customAction !== null && action.id !== previousActionId) {
          if (actionCatalogRef.current.some((entry) => entry.id === customAction)) {
            pendingServerActionRef.current = null
            dispatchPlayback({ type: 'startAction', actionId: customAction })
          } else {
            pendingServerActionRef.current = customAction
          }
        } else if (effect.motion && !effect.bubble) {
          playLegacyMotion(effect.motion)
        }
        if (!actionAlive) pendingServerActionRef.current = null
        if (effect.bubble) {
          pagerRef.current?.play(effect.bubble.text, effect.bubble.motion)
        }
      })
      // 订阅已经挂上：让 main 补发首拍缓存，避免它早于订阅被丢掉。
      window.petBridge?.ready?.()
    } catch {
      unsubscribe = undefined
    }

    return () => {
      unsubscribe?.()
    }
  }, [activeConfig, dispatchPlayback, pet, playLegacyMotion])

  // 点击穿透：默认整窗穿透，指针落到身体/UI 上才翻成可交互。
  useEffect(() => {
    if (!activeConfig) return

    let overPet = false
    let overUi = false
    let dragging = false

    const publish = (): void => {
      window.petBridge?.setIgnoreMouse?.(shouldIgnoreMouse({ overPet, overUi, dragging }))
    }

    const update = (x: number, y: number): void => {
      const body = petRef.current?.geometry?.body
      const nextOverPet =
        body !== undefined && x >= body.left && x <= body.right && y >= body.top && y <= body.bottom
      const nextOverUi = isPointerOverUi(x, y)
      if (nextOverPet === overPet && nextOverUi === overUi) return
      overPet = nextOverPet
      overUi = nextOverUi
      publish()
    }

    const onMouseMove = (event: MouseEvent): void => update(event.clientX, event.clientY)
    const reset = (): void => {
      if (!overPet && !overUi) return
      overPet = false
      overUi = false
      publish()
    }

    const inBody = (x: number, y: number): boolean => {
      const body = petRef.current?.geometry?.body
      return (
        body !== undefined && x >= body.left && x <= body.right && y >= body.top && y <= body.bottom
      )
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !inBody(event.clientX, event.clientY)) return
      dragging = true
      overPet = true
      publish()
      dispatchPlayback({ type: 'dragStarted' }, { forceBase: true })
      window.petBridge?.startDrag?.()
    }

    const endDrag = (): void => {
      if (!dragging) return
      dragging = false
      window.petBridge?.endDrag?.()
      publish()
    }

    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', endDrag, true)
    document.addEventListener('mouseleave', reset)
    window.addEventListener('blur', endDrag)

    return () => {
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
      document.removeEventListener('mouseleave', reset)
      window.removeEventListener('blur', endDrag)
      window.petBridge?.setIgnoreMouse?.(true)
    }
  }, [activeConfig, dispatchPlayback])

  /**
   * 运行期素材错误先看当前命令面：借用槽里的注册表动作失败只停动作；
   * 只有稳态皮肤自身失败才回退到上一个皮肤。
   */
  const handlePetError = (cause: unknown): void => {
    if (petErrorTarget(playbackRef.current) === 'action') {
      dispatchPlayback({ type: 'stopAction' }, { forceBase: true })
      console.warn('[desktop-pet] 动作素材播不了，已停止当前动作', cause)
      pet.bubble({
        id: 'action-error',
        title: '动作没载入',
        description: '这段动作素材播不了，先停下当前动作。',
        variant: 'danger',
        timeout: 5000,
      })
      return
    }

    const current = skinRef.current
    dispatchPlayback({ type: 'skinChanged' }, { forceBase: true })
    if (!current) return

    // 记下失败的是哪一份 revision：之后 ready/getSkin 补发它时会被忽略。
    failedSkinRef.current = { id: current.id, revision: current.revision }
    const previous = previousSkinRef.current
    previousSkinRef.current = null
    skinRef.current = previous
    setSkin(previous)
    console.warn('[desktop-pet] 皮肤运行出错，已回退上一个皮肤', cause)
    pet.bubble({
      id: 'skin-error',
      title: '皮肤没载入',
      description: previous ? '先换回上一个皮肤。' : '先换回默认皮肤。',
      variant: 'danger',
      timeout: 5000,
    })
  }

  /**
   * 对话气泡的三种收尾，绝不把失败显示成成功：
   * - 有回话：收掉加载气泡，走 `pet.reply` 的说话链路；
   * - 送到了但她没开口：用普通气泡如实说一句；
   * - 没送到：标题「没送到」+ note，4 秒后收起。
   */
  const handleDialogue = (text: string): void => {
    const requestGeneration = ++chatRequestGenerationRef.current
    const requestChat = window.petBridge?.requestChat
    if (!requestChat) {
      pet.bubble({
        id: CHAT_BUBBLE_ID,
        title: '没送到',
        description: '这个版本还不会说话。',
        variant: 'danger',
        timeout: 4000,
      })
      return
    }

    const thinking = chatThinkingPlan(playbackRef.current)
    if (thinking.preemptMotion) playLegacyMotion(thinking.preemptMotion)
    const playbackGeneration = playbackRef.current?.generation ?? 0
    pet.bubble({
      id: CHAT_BUBBLE_ID,
      title: '正在想…',
      loading: true,
      motion: thinking.bubbleMotion,
    })

    void requestChat(text)
      .then((result) => {
        const reply = chatReplyPlaybackDecision({
          requestGeneration,
          latestRequestGeneration: chatRequestGenerationRef.current,
          playbackGeneration,
          playback: playbackRef.current,
        })
        if (!reply.current) return
        if (result.ok && result.herReply.trim() !== '') {
          // 加载气泡是常驻的，必须自己收掉；reply 会另开说话气泡。
          pet.bubble.close(CHAT_BUBBLE_ID)
          pagerRef.current?.play(result.herReply, reply.motion)
          return
        }
        if (result.ok) {
          // 组件按「只换显式给出的字段」合并：loading / motion 必须显式清掉，
          // 否则失败气泡会一直转圈、还挂着 thinking。
          pet.bubble({
            id: CHAT_BUBBLE_ID,
            title: '她这次没说话',
            description: result.note || '话送到了。',
            loading: false,
            motion: undefined,
            timeout: 4000,
          })
          return
        }
        pet.bubble({
          id: CHAT_BUBBLE_ID,
          title: '没送到',
          description: result.note || '接口没回话。',
          loading: false,
          motion: undefined,
          variant: 'danger',
          timeout: 4000,
        })
      })
      .catch(() => {
        if (chatRequestGenerationRef.current !== requestGeneration) return
        pet.bubble({
          id: CHAT_BUBBLE_ID,
          title: '没送到',
          description: '桥接出错了。',
          loading: false,
          motion: undefined,
          variant: 'danger',
          timeout: 4000,
        })
      })
  }

  if (!activeConfig) {
    if (error) return <p className="pet-error">桌宠配置没加载出来：{error}</p>
    return null
  }

  return (
    <Pet
      ref={petRef}
      config={renderedConfig ?? activeConfig}
      uri={renderedUri}
      size={size}
      motion={renderedMotion}
      dialogue
      onDialogue={handleDialogue}
      onAnimationChange={handleAnimationChange}
      onMotionChange={handleMotionChange}
      onError={handlePetError}
    />
  )
}

export default App
