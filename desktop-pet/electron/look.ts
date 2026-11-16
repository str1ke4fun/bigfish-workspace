/**
 * 气泡外观（透明度/宽度）的纯逻辑：和 `size` 一样，本地改动先生效，
 * 服务端回声前不让旧值把它拉回去。不 import Electron，测试直接在 Node 里跑。
 */
import { clampBubbleOpacity, clampBubbleWidth } from '../renderer/bubble-pages.ts'

export interface BubbleLook {
  /** 不透明度 %（40–100）。 */
  opacity: number
  /** 最大宽度 px（220–420）；0 = 跟随桌宠大小。 */
  width: number
}

export interface LookSyncState {
  current: BubbleLook
  pending: BubbleLook | null
}

export const DEFAULT_LOOK: BubbleLook = { opacity: 90, width: 0 }

const same = (a: BubbleLook, b: BubbleLook): boolean => a.opacity === b.opacity && a.width === b.width

/** 从 `/pet/state` 取外观；字段缺失（老服务端）返回 null，不当成一次变化。 */
export function readRemoteLook(state: unknown): BubbleLook | null {
  if (!state || typeof state !== 'object') return null
  const settings = (state as Record<string, unknown>).settings
  if (!settings || typeof settings !== 'object') return null
  const record = settings as Record<string, unknown>
  if (typeof record.bubbleOpacity !== 'number' && typeof record.bubbleWidth !== 'number') return null
  return { opacity: clampBubbleOpacity(record.bubbleOpacity), width: clampBubbleWidth(record.bubbleWidth) }
}

export function noteLocalLook(look: BubbleLook): LookSyncState {
  return { current: look, pending: look }
}

export function resolveRemoteLook(
  state: LookSyncState,
  remote: BubbleLook,
): { state: LookSyncState; apply: BubbleLook | null } {
  if (state.pending !== null) {
    if (same(remote, state.pending)) return { state: { current: state.current, pending: null }, apply: null }
    return { state, apply: null }
  }
  if (!same(remote, state.current)) return { state: { current: remote, pending: null }, apply: remote }
  return { state, apply: null }
}
