import { useEffect, useRef, useState } from 'react'
import {
  Pet,
  useControllablePet,
  type DshPetConfig,
  type PetRef,
} from 'dsh-pet-component'
import { shouldIgnoreMouse } from '../electron/pointer'
import {
  decideEffects,
  emptySeen,
  performedMotion,
  type PetMotion,
  type PetState,
  type Seen,
} from './controller'
import type { ChatResult } from './chat'

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

export function App() {
  const [config, setConfig] = useState<DshPetConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 声明式稳态：activity / presence；一次性动作播完后由组件自动回落到它。 */
  const [steady, setSteady] = useState<PetMotion>('idle')
  const [size, setSize] = useState(PET_SIZE_DEFAULT)
  const petRef = useRef<PetRef>(null)
  const pet = useControllablePet(petRef)

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

  // 气泡宽度跟着宠物尺寸走，避免小宠物配大水泡。
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--pet-bubble-max',
      `${Math.round(Math.min(360, Math.max(240, size * 0.75)))}px`,
    )
  }, [size])

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
    if (!config) return
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
          pet.bubble({
            id: effect.bubble.id,
            description: effect.bubble.text,
            motion: effect.bubble.motion,
            timeout: BUBBLE_TIMEOUT_MS,
          })
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
  }, [config, pet])

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
    if (!config) return

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
  }, [config])

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
          pet.reply(result.herReply)
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

  if (error) return <p className="pet-error">桌宠配置没加载出来：{error}</p>
  if (!config) return null

  return (
    <Pet
      ref={petRef}
      config={config}
      uri={{ default: ASSET_BASE }}
      size={size}
      motion={steady}
      dialogue
      onDialogue={handleDialogue}
    />
  )
}

export default App
