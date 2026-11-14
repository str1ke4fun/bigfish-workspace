import { useEffect, useRef, useState } from 'react'
import { Pet, useControllablePet, type DshPetConfig, type PetRef } from 'dsh-pet-component'
import { decideEffects, emptySeen, type PetState, type Seen } from './controller'

declare global {
  interface Window {
    petBridge?: {
      onState(handler: (state: unknown) => void): () => void
      /** 通知主进程补发最近一次缓存状态；老 preload 没有时退回只等下一拍。 */
      ready?(): void
    }
  }
}

const CONFIG_URL = 'pet-asset://local/config.json'
const ASSET_BASE = 'pet-asset://local/webm'
const PET_SIZE = 462
const SEEN_STORAGE_KEY = 'desktop-pet:seen'
const BUBBLE_TIMEOUT_MS = 10_000

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

  if (error) return <p className="pet-error">桌宠配置没加载出来：{error}</p>
  if (!config) return null

  return <Pet ref={petRef} config={config} uri={{ default: ASSET_BASE }} size={PET_SIZE} />
}

export default App
