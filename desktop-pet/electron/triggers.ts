/**
 * 触发表的纯解析、合并与读取逻辑。
 *
 * 触发表是独立于动作目录的开放数据：单条 trigger 不合法时只丢弃该条，
 * 文件整体读不了或 JSON/根结构损坏时抛错，让调用方保留上一份有效目录。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTION_ID_RE } from './actions.ts'
import { SIMPLE_SKIN_ID } from './skin.ts'

export interface TriggerDefinition {
  when: string
  pool: string[]
  /** 缺省等权；解析后始终与 pool 等长。 */
  w: number[]
  once: boolean
  minGapSec: number
  inAmbient: boolean
}

export interface ParseTriggersOptions {
  actionIds: ReadonlySet<string> | readonly string[]
  log?: (message: string) => void
}

export interface ParseTriggersResult {
  triggers: TriggerDefinition[]
  errors: string[]
}

export type ReadTriggerCatalog = (
  assetsRoot: string,
  skinId: string,
  actionIds: ReadonlySet<string> | readonly string[],
  log?: (message: string) => void,
) => Promise<TriggerDefinition[]>

const ACTIVITY_KINDS = new Set(['waiting', 'error', 'working', 'thinking', 'result', 'success'])
const SCENE_KINDS = new Set(['rest', 'out'])
const SCENE_PHASES = new Set(['enter', 'exit'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidMonthDay(value: string): boolean {
  const match = /^(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const month = Number(match[1])
  const day = Number(match[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  // 2000 是闰年，因此 02-29 合法，02-30/02-31 等仍会被拒绝。
  const date = new Date(Date.UTC(2000, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** 接受二期定义过的固定事件名，以及 activity/scene/date 的受控命名空间。 */
export function isTriggerWhen(value: string): boolean {
  if (value === 'speak' || value === 'bili_replied' || value === 'ambient') return true

  if (value.startsWith('activity:')) {
    return ACTIVITY_KINDS.has(value.slice('activity:'.length))
  }

  if (value.startsWith('scene:')) {
    const [, kind, phase, ...rest] = value.split(':')
    return rest.length === 0 && SCENE_KINDS.has(kind) && SCENE_PHASES.has(phase)
  }

  if (value.startsWith('date:')) {
    return isValidMonthDay(value.slice('date:'.length))
  }

  return false
}

function cloneTrigger(trigger: TriggerDefinition): TriggerDefinition {
  return {
    when: trigger.when,
    pool: [...trigger.pool],
    w: [...trigger.w],
    once: trigger.once,
    minGapSec: trigger.minGapSec,
    inAmbient: trigger.inAmbient,
  }
}

function normalizeActionIds(actionIds: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return actionIds instanceof Set ? actionIds : new Set(actionIds)
}

/**
 * 解析 `{ triggers: [...] }`。坏条目逐条报警并丢弃；同文件重复 `when` 由后者覆盖，
 * 但保留首次出现的位置，和动作目录的覆盖语义一致。
 */
export function parseTriggers(raw: unknown, options: ParseTriggersOptions): ParseTriggersResult {
  const triggers: TriggerDefinition[] = []
  const errors: string[] = []
  const actionIds = normalizeActionIds(options.actionIds)

  function report(index: number, reason: string): void {
    const message = `trigger #${index + 1} 已丢弃：${reason}`
    errors.push(message)
    try {
      options.log?.(message)
    } catch {
      // 日志器出错不能影响目录解析。
    }
  }

  if (!isRecord(raw) || !Array.isArray(raw.triggers)) {
    const message = '触发表必须是包含 triggers 数组的对象。'
    errors.push(message)
    try {
      options.log?.(message)
    } catch {
      // 同上。
    }
    return { triggers, errors }
  }

  const byWhen = new Map<string, TriggerDefinition>()

  raw.triggers.forEach((entry, index) => {
    if (!isRecord(entry)) {
      report(index, '条目必须是对象。')
      return
    }

    const when = typeof entry.when === 'string' ? entry.when.trim() : ''
    if (!isTriggerWhen(when)) {
      report(index, 'when 不是受支持的事件名。')
      return
    }

    if (!Array.isArray(entry.pool) || entry.pool.length === 0) {
      report(index, 'pool 必须是非空动作 id 数组。')
      return
    }

    const pool: string[] = []
    const poolIds = new Set<string>()
    for (const value of entry.pool) {
      const actionId = typeof value === 'string' ? value.trim() : ''
      if (!ACTION_ID_RE.test(actionId)) {
        report(index, 'pool 里必须都是合法动作 id。')
        return
      }
      if (poolIds.has(actionId)) {
        report(index, 'pool 不能包含重复动作 id。')
        return
      }
      if (!actionIds.has(actionId)) {
        report(index, `pool 指向不存在的动作：${actionId}`)
        return
      }
      poolIds.add(actionId)
      pool.push(actionId)
    }

    let w: number[]
    if (Object.hasOwn(entry, 'w')) {
      if (!Array.isArray(entry.w) || entry.w.length !== pool.length) {
        report(index, 'w 必须是与 pool 等长的数组。')
        return
      }
      if (!entry.w.every((weight) => typeof weight === 'number' && Number.isFinite(weight) && weight >= 0)) {
        report(index, 'w 必须全为非负有限数。')
        return
      }
      if (entry.w.reduce((sum, weight) => sum + weight, 0) <= 0) {
        report(index, 'w 总和必须大于 0。')
        return
      }
      w = [...entry.w]
    } else {
      w = Array.from({ length: pool.length }, () => 1)
    }

    let once = false
    if (Object.hasOwn(entry, 'once')) {
      if (typeof entry.once !== 'boolean') {
        report(index, 'once 必须是布尔值。')
        return
      }
      once = entry.once
    }

    let minGapSec = 0
    if (Object.hasOwn(entry, 'minGapSec')) {
      if (typeof entry.minGapSec !== 'number' || !Number.isFinite(entry.minGapSec) || entry.minGapSec < 0) {
        report(index, 'minGapSec 必须是非负有限数。')
        return
      }
      minGapSec = entry.minGapSec
    }

    let inAmbient = false
    if (Object.hasOwn(entry, 'inAmbient')) {
      if (typeof entry.inAmbient !== 'boolean') {
        report(index, 'inAmbient 必须是布尔值。')
        return
      }
      inAmbient = entry.inAmbient
    }

    byWhen.set(when, { when, pool, w, once, minGapSec, inAmbient })
  })

  triggers.push(...byWhen.values())
  return { triggers, errors }
}

/** 合并默认与皮肤触发表；同 when 覆盖并保留默认位置，新 when 追加。 */
export function mergeTriggers(
  defaults: readonly TriggerDefinition[],
  skin: readonly TriggerDefinition[],
): TriggerDefinition[] {
  const byWhen = new Map<string, TriggerDefinition>()
  for (const item of defaults) byWhen.set(item.when, cloneTrigger(item))
  for (const item of skin) byWhen.set(item.when, cloneTrigger(item))
  return [...byWhen.values()]
}

/** 用当前动作目录裁剪 fallback 池；保留仍存在动作的对应权重，空池/零权重池整条丢弃。 */
export function filterTriggerCatalog(
  triggers: readonly TriggerDefinition[],
  actionIds: ReadonlySet<string> | readonly string[],
): TriggerDefinition[] {
  const available = normalizeActionIds(actionIds)
  const filtered: TriggerDefinition[] = []

  for (const trigger of triggers) {
    if (trigger.pool.length !== trigger.w.length) continue

    const pool: string[] = []
    const w: number[] = []
    for (let index = 0; index < trigger.pool.length; index += 1) {
      const actionId = trigger.pool[index]
      if (!available.has(actionId)) continue
      pool.push(actionId)
      w.push(trigger.w[index])
    }

    if (pool.length === 0) continue
    if (w.some((weight) => !Number.isFinite(weight) || weight < 0)) continue
    if (w.reduce((sum, weight) => sum + weight, 0) <= 0) continue
    filtered.push({ ...cloneTrigger(trigger), pool, w })
  }

  return filtered
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

function missingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readTriggerFile(
  file: string,
  label: string,
  actionIds: ReadonlySet<string> | readonly string[],
  log?: (message: string) => void,
  optional = false,
): Promise<TriggerDefinition[]> {
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    // 默认表是运行时基线，缺失时必须让调用方保留上一份；皮肤表可以省略。
    if (optional && missingFile(error)) return []
    throw new Error(`${label}触发表读不了：${errorText(error)}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    throw new Error(`${label}触发表 JSON 不合法：${errorText(error)}`)
  }
  if (!isRecord(raw) || !Array.isArray(raw.triggers)) {
    throw new Error(`${label}触发表必须是包含 triggers 数组的对象。`)
  }

  return parseTriggers(raw, {
    actionIds,
    log: log ?? ((message) => console.warn(`[desktop-pet] ${label}${message}`)),
  }).triggers
}

/** 读默认 triggers.json，再用当前皮肤 triggers.json 覆盖同 when 条目。 */
export async function readTriggerCatalog(
  assetsRoot: string,
  skinId: string,
  actionIds: ReadonlySet<string> | readonly string[],
  log?: (message: string) => void,
): Promise<TriggerDefinition[]> {
  if (skinId !== '' && !SIMPLE_SKIN_ID.test(skinId)) {
    throw new Error('皮肤 id 不合法，无法读取触发表。')
  }

  const defaults = await readTriggerFile(join(assetsRoot, 'triggers.json'), '默认', actionIds, log)
  if (skinId === '') return mergeTriggers(defaults, [])

  const skin = await readTriggerFile(
    join(assetsRoot, 'skins', skinId, 'triggers.json'),
    `皮肤 ${skinId} 的`,
    actionIds,
    log,
    true,
  )
  return mergeTriggers(defaults, skin)
}
