import type { AnimationSlot, DshPetConfig } from 'dsh-pet-component'
import type { PlaybackAction, PlaybackSlot, PlaybackState, PetMotion } from './controller'

type BorrowAction = string | Pick<PlaybackAction, 'anim' | 'seq'>

interface SlotSnapshot {
  hadMotions: boolean
  hadSlot: boolean
  value: AnimationSlot | undefined
}

/** 借用 config 到原 mapping 的对应关系只活在这份克隆对象上，不污染 App 的 base config。 */
const snapshots = new WeakMap<DshPetConfig, Map<PlaybackSlot, SlotSnapshot>>()

function animationFor(action: BorrowAction): string {
  const name = typeof action === 'string' ? action : action.anim ?? action.seq?.[0]
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('借用动作缺少动画名')
  }
  return name
}

/**
 * 返回只改写一个借用槽 mapping 的 config 克隆。
 *
 * 其余字段和 `animations` 保持同引用；`motions` 单独复制，避免污染 base config。
 * 原槽值记在克隆对象的 WeakMap 快照里，`restoreActionConfig` 据此精确恢复。
 */
export function borrowActionConfig(
  config: DshPetConfig,
  action: BorrowAction,
  slot: PlaybackSlot,
): DshPetConfig {
  const motions = { ...(config.motions ?? {}) }
  const next: DshPetConfig = { ...config, motions }
  next.motions![slot] = animationFor(action)

  const nextSnapshots = new Map(snapshots.get(config) ?? [])
  nextSnapshots.set(slot, {
    hadMotions: Object.hasOwn(config, 'motions'),
    hadSlot: config.motions !== undefined && Object.hasOwn(config.motions, slot),
    value: config.motions?.[slot],
  })
  snapshots.set(next, nextSnapshots)
  return next
}

/** 恢复一次借用前的 mapping；没有借用快照时安全清掉该槽的临时映射。 */
export function restoreActionConfig(config: DshPetConfig, slot: PlaybackSlot): DshPetConfig {
  const next: DshPetConfig = { ...config }
  const snapshot = snapshots.get(config)?.get(slot)

  if (snapshot === undefined) {
    if (config.motions !== undefined) {
      const motions = { ...config.motions }
      delete motions[slot]
      next.motions = motions
    }
    return next
  }

  if (!snapshot.hadMotions) {
    delete next.motions
    return next
  }

  const motions = { ...(config.motions ?? {}) }
  if (snapshot.hadSlot) motions[slot] = snapshot.value
  else delete motions[slot]
  next.motions = motions
  return next
}

/** 循环被命令面借走后，声明式 prop 必须停在安全值，不能让 activity 更新清掉 loop override。 */
export function petMotionProp(
  playback: PlaybackState | null | undefined,
  latestSteady: PetMotion,
): PetMotion {
  return playback?.status === 'holding-loop' ? playback.frozenSteady : latestSteady
}
