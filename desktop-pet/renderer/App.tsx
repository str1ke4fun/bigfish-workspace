import { useEffect, useRef, useState } from 'react'
import {
  Pet,
  useControllablePet,
  type DshPetConfig,
  type Motion,
  type PetRef,
} from 'dsh-pet-component'
import { shouldIgnoreMouse } from '../electron/pointer'
import { decideEffects, emptySeen, type PetState, type Seen } from './controller'
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
    }
  }
}

const CONFIG_URL = 'pet-asset://local/config.json'
const ASSET_BASE = 'pet-asset://local/webm'
const PET_SIZE = 462
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
    return {
      lastActionId: typeof record.lastActionId === 'string' ? record.lastActionId : '',
      lastCommentAt: typeof record.lastCommentAt === 'string' ? record.lastCommentAt : '',
      activity: typeof record.activity === 'string' ? record.activity : null,
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
  const petRef = useRef<PetRef>(null)
  const pet = useControllablePet(petRef)

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

        if (effect.motion) pet.motion({ type: effect.motion, replay: true })
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

  // 右键菜单「演一个动作」：main 只发动作名，重播由这里保证。
  useEffect(() => {
    const unsubscribe = window.petBridge?.onAction?.((motion) => {
      pet.motion({ type: motion as Motion, replay: true })
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

    const publish = (): void => {
      window.petBridge?.setIgnoreMouse?.(shouldIgnoreMouse({ overPet, overUi, dragging: false }))
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

    window.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('mouseleave', reset)
    window.addEventListener('blur', reset)

    return () => {
      window.removeEventListener('mousemove', onMouseMove, true)
      document.removeEventListener('mouseleave', reset)
      window.removeEventListener('blur', reset)
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
      size={PET_SIZE}
      dialogue
      onDialogue={handleDialogue}
    />
  )
}

export default App
