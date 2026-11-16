import { useEffect, useRef, useState } from 'react'
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
  type PetMotion,
  type PetState,
  type Seen,
} from './controller'
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
      onAction?(handler: (motion: string) => void): () => void
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

export function App() {
  const [config, setConfig] = useState<DshPetConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 声明式稳态：activity / presence；一次性动作播完后由组件自动回落到它。 */
  const [steady, setSteady] = useState<PetMotion>('idle')
  const [size, setSize] = useState(PET_SIZE_DEFAULT)
  /** 服务端下发的皮肤；null = 默认皮肤（继续用 assets/config.json + assets/webm）。 */
  const [skin, setSkin] = useState<ActiveSkin | null>(null)
  const activeConfig = skin?.config ?? config
  const activeUri = skin?.uri ?? ASSET_BASE
  const petRef = useRef<PetRef>(null)
  /** 当前/上一个皮肤用 ref 同步记录，事件回调里读到的永远是最新值。 */
  const skinRef = useRef<ActiveSkin | null>(null)
  const previousSkinRef = useRef<ActiveSkin | null>(null)
  /** 运行期失败过的皮肤；防止 ready/getSkin 的重放立刻把回退撤销并形成循环。 */
  const failedSkinRef = useRef<SkinRef | null>(null)
  const pet = useControllablePet(petRef)
  const petApiRef = useRef(pet)
  petApiRef.current = pet
  const [look, setLook] = useState({ opacity: BUBBLE_OPACITY_DEFAULT, width: 0 })
  /** 长回复逐句翻：同一个气泡原地换字，新消息取消上一轮。 */
  const pagerRef = useRef<ReturnType<typeof createPager> | null>(null)
  if (!pagerRef.current) {
    pagerRef.current = createPager({
      show: (text, _index, motion) => {
        petApiRef.current.bubble(pageBubble(text))
        // 动作只在首句播一次（一次性，播完回落稳态），不挂在常驻气泡上。
        const options = motion ? performedMotion(motion) : null
        if (options) petApiRef.current.motion(options)
      },
      close: () => petApiRef.current.bubble.close(PAGE_BUBBLE_ID),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
  }

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
  }, [])

  // 主进程拒绝载入皮肤（坏 JSON、缺动画文件、读盘失败）时保留当前皮肤并弹同一只提示：
  // 不依赖组件运行时的 onError，否则坏皮肤会在界面上完全静默。
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = window.petBridge?.onSkinError?.((raw) => {
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
        const effect = decideEffects(seen, raw as PetState, Date.now())
        seen = effect.seen
        saveSeen(seen)

        // 稳态走声明式 prop；一次性动作走命令面且显式 loop:false，播完自动回落稳态。
        setSteady(effect.steady)
        if (effect.motion) pet.motion({ type: effect.motion, loop: false, replay: true })
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
  }, [activeConfig, pet])

  // 右键菜单「演一个动作」：main 只发动作名；这里统一成一次性播放，播完回落稳态。
  useEffect(() => {
    const unsubscribe = window.petBridge?.onAction?.((motion) => {
      const options = performedMotion(motion)
      if (options) pet.motion(options)
    })
    return () => {
      unsubscribe?.()
    }
  }, [pet])

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
  }, [activeConfig])

  /**
   * 皮肤运行期出错（素材损坏/解码失败等）：回退到上一个皮肤并弹气泡。
   * 主进程发送前已检查 14 个文件是否存在，这里兜住运行期才暴露的问题。
   */
  const handlePetError = (cause: unknown): void => {
    const current = skinRef.current
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

    pet.bubble({ id: CHAT_BUBBLE_ID, title: '正在想…', loading: true, motion: 'thinking' })

    void requestChat(text)
      .then((result) => {
        if (result.ok && result.herReply.trim() !== '') {
          // 加载气泡是常驻的，必须自己收掉；reply 会另开说话气泡。
          pet.bubble.close(CHAT_BUBBLE_ID)
          pagerRef.current?.play(result.herReply, 'waving')
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
      config={activeConfig}
      uri={activeUri}
      size={size}
      motion={steady}
      dialogue
      onDialogue={handleDialogue}
      onError={handlePetError}
    />
  )
}

export default App
