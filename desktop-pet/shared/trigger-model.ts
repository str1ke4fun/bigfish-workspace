/** 触发表在 Electron 主进程与 renderer 之间共享的纯数据契约。 */
export interface TriggerDefinition {
  when: string
  pool: string[]
  /** 缺省等权；解析后始终与 pool 等长。 */
  w: number[]
  once: boolean
  minGapSec: number
  inAmbient: boolean
}

/** 池内按权重选动作；随机源可注入，越界或非法输入返回 null。 */
export function pickTriggerAction(
  trigger: Pick<TriggerDefinition, 'pool' | 'w'>,
  rng: () => number = Math.random,
): string | null {
  if (trigger.pool.length === 0 || trigger.pool.length !== trigger.w.length) return null
  if (trigger.w.some((weight) => !Number.isFinite(weight) || weight < 0)) return null

  let total = 0
  for (const weight of trigger.w) total += weight
  if (!(total > 0)) return null

  const sample = rng()
  if (typeof sample !== 'number' || !Number.isFinite(sample)) return null
  const target = Math.min(1, Math.max(0, sample)) * total
  let cumulative = 0
  let lastPositive: string | null = null

  for (let index = 0; index < trigger.pool.length; index += 1) {
    const weight = trigger.w[index]
    if (weight <= 0) continue
    lastPositive = trigger.pool[index]
    cumulative += weight
    if (target < cumulative) return trigger.pool[index]
  }

  return lastPositive
}
