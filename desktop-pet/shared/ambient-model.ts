/**
 * 氛围策略在 Electron 主进程与 renderer 之间共享的纯数据契约。
 *
 * 形状与服务端 `config.pet.ambient` 对齐：
 *   catalog   = { version, quietHours, modes: { [mode]: policy } }
 *   policy    = { mode, enabled, items, frequency }
 *   item      = { action, weight, enabled, cooldownSec, minIdleSec }
 *   frequency = { intervalMinSec, intervalMaxSec, minGapSec, maxPerIdle,
 *                 maxPerDay, settleSec, actionCooldownSec }
 *
 * 这里不读文件、不 import Electron；`electron/ambient.ts` 负责把 JSON 读成
 * 这些结构，renderer 只消费本次选择出的 policy。
 */

/** presence 的四种模式，与服务端 `AMBIENT_MODES` 一致。 */
export const AMBIENT_MODES = ['off', 'event', 'ambient', 'work'] as const
export type AmbientMode = (typeof AMBIENT_MODES)[number]

const AMBIENT_MODE_SET: ReadonlySet<string> = new Set(AMBIENT_MODES)

export interface AmbientQuietHours {
  /** `HH:MM`，本地时间。 */
  start: string
  /** `HH:MM`，可早于 start 表示跨午夜。 */
  end: string
  afterJitterSec: number
}

export interface AmbientItem {
  action: string
  weight: number
  enabled: boolean
  cooldownSec: number
  minIdleSec: number
}

/** 用户覆盖里允许只给出部分 item 字段，缺失字段按规范默认补齐。 */
export interface AmbientItemInput {
  action: string
  weight?: number
  enabled?: boolean
  cooldownSec?: number
  minIdleSec?: number
}

export interface AmbientFrequency {
  intervalMinSec: number
  intervalMaxSec: number
  minGapSec: number
  maxPerIdle: number
  maxPerDay: number
  settleSec: number
  actionCooldownSec: number
}

export interface AmbientModePolicy {
  mode: string
  enabled: boolean
  items: AmbientItem[]
  frequency: AmbientFrequency
}

export interface AmbientCatalog {
  version: number
  quietHours: AmbientQuietHours | null
  modes: Record<string, AmbientModePolicy>
}

/** 服务端 `config.pet.ambient` 的覆盖形状；只覆盖显式给出的字段。 */
export interface AmbientModeOverride {
  enabled?: boolean
  items?: AmbientItemInput[] | null
  frequency?: Partial<AmbientFrequency> | null
}

export interface AmbientOverrides {
  version?: number
  revision?: number
  quietHours?: AmbientQuietHours | null
  modes?: Record<string, AmbientModeOverride | undefined> | null
}

/** 解析前/合并前的宽泛目录形状，方便测试与调用方直接传 JSON 对象。 */
export interface AmbientCatalogSource {
  version?: number
  quietHours?: AmbientQuietHours | null
  modes?: Record<string, unknown> | null
}

/** 缺省频率：minGapSec / settleSec / actionCooldownSec 有设计默认值，其余为 0。 */
export const DEFAULT_AMBIENT_FREQUENCY: AmbientFrequency = Object.freeze({
  intervalMinSec: 0,
  intervalMaxSec: 0,
  minGapSec: 300,
  maxPerIdle: 0,
  maxPerDay: 0,
  settleSec: 300,
  actionCooldownSec: 7200,
})

const FREQUENCY_FIELDS = [
  'intervalMinSec',
  'intervalMaxSec',
  'minGapSec',
  'maxPerIdle',
  'maxPerDay',
  'settleSec',
  'actionCooldownSec',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数字且有限；负数夹到 0；非法（null / 字符串 / NaN）回落到 fallback。 */
function nonNegative(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value < 0 ? 0 : value
}

/** 权重：非法或负数按 1；0 保留为 0（真要禁用请用 enabled:false）。 */
function normalizeWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 1
  return value
}

/** 单条 item；缺少 action 或不是对象时返回 null，由调用方决定丢弃并记日志。 */
export function normalizeAmbientItem(raw: unknown): AmbientItem | null {
  if (!isRecord(raw)) return null
  const action = typeof raw.action === 'string' ? raw.action : ''
  if (action === '') return null
  return {
    action,
    weight: normalizeWeight(raw.weight),
    enabled: raw.enabled !== false,
    cooldownSec: nonNegative(raw.cooldownSec, 0),
    minIdleSec: nonNegative(raw.minIdleSec, 0),
  }
}

/** 同一 action 出现多次时后者覆盖前者，但保留首次出现的位置。 */
export function normalizeAmbientItems(raw: unknown): AmbientItem[] {
  if (!Array.isArray(raw)) return []
  const order: string[] = []
  const byAction = new Map<string, AmbientItem>()
  for (const entry of raw) {
    const item = normalizeAmbientItem(entry)
    if (!item) continue
    if (!byAction.has(item.action)) order.push(item.action)
    byAction.set(item.action, item)
  }
  return order.map((action) => byAction.get(action)!)
}

function normalizeIntervalOrder(frequency: AmbientFrequency): void {
  if (frequency.intervalMinSec > frequency.intervalMaxSec) {
    const min = frequency.intervalMinSec
    frequency.intervalMinSec = frequency.intervalMaxSec
    frequency.intervalMaxSec = min
  }
}

/** 解析一份完整频率对象：缺失字段用默认值，负数夹到 0，min > max 交换。 */
export function normalizeAmbientFrequency(raw: unknown): AmbientFrequency {
  const source = isRecord(raw) ? raw : {}
  const frequency = {} as AmbientFrequency
  for (const field of FREQUENCY_FIELDS) {
    frequency[field] = nonNegative(source[field], DEFAULT_AMBIENT_FREQUENCY[field])
  }
  normalizeIntervalOrder(frequency)
  return frequency
}

/** 在已有频率上只覆盖显式给出的字段；负数夹到 0，随后重新保证 min ≤ max。 */
function mergeAmbientFrequency(base: AmbientFrequency, raw: unknown): AmbientFrequency {
  const source = isRecord(raw) ? raw : {}
  const frequency: AmbientFrequency = { ...base }
  for (const field of FREQUENCY_FIELDS) {
    if (source[field] === undefined) continue
    frequency[field] = nonNegative(source[field], base[field])
  }
  normalizeIntervalOrder(frequency)
  return frequency
}

function isClock(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return false
  return Number(match[1]) <= 23 && Number(match[2]) <= 59
}

/** 安静时段；形状不合法时整体返回 null（不半保留坏字段）。 */
export function normalizeQuietHours(raw: unknown): AmbientQuietHours | null {
  if (!isRecord(raw)) return null
  if (!isClock(raw.start) || !isClock(raw.end)) return null
  return {
    start: raw.start,
    end: raw.end,
    afterJitterSec: nonNegative(raw.afterJitterSec, 0),
  }
}

/** 空目录；没有文件或还没载入时 renderer 用它保持“无策略”状态。 */
export function emptyAmbientCatalog(): AmbientCatalog {
  return { version: 1, quietHours: null, modes: {} }
}

/** 把任意一个 mode 对象规范化成完整策略，`mode` 固定为目录键。 */
export function normalizeAmbientMode(raw: unknown, mode: string): AmbientModePolicy {
  const source = isRecord(raw) ? raw : {}
  return {
    mode,
    enabled: source.enabled !== false,
    items: normalizeAmbientItems(source.items),
    frequency: normalizeAmbientFrequency(source.frequency),
  }
}

/**
 * 把用户覆盖叠到一条已选出的策略上：
 * - `items` 整体替换（不是逐项合并）；
 * - `frequency` 逐字段覆盖；
 * - `enabled` 显式布尔时覆盖。
 *
 * 不修改 `base`。
 */
export function mergeAmbientMode(
  base: AmbientModePolicy,
  override: AmbientModeOverride | null | undefined,
): AmbientModePolicy {
  const policy = normalizeAmbientMode(base, base.mode)
  if (!isRecord(override)) return policy

  const enabled = typeof override.enabled === 'boolean' ? override.enabled : policy.enabled
  const items = Array.isArray(override.items)
    ? normalizeAmbientItems(override.items)
    : policy.items
  const frequency = isRecord(override.frequency)
    ? mergeAmbientFrequency(policy.frequency, override.frequency)
    : { ...policy.frequency }
  return { mode: policy.mode, enabled, items, frequency }
}

/**
 * 合并默认目录与皮肤目录：皮肤按 mode 整块替换，缺失 mode 保留默认。
 * 两份输入都不会被改写。
 */
export function mergeAmbientCatalogs(
  defaults: AmbientCatalogSource | null | undefined,
  skin: AmbientCatalogSource | null | undefined,
): AmbientCatalog {
  const base = isRecord(defaults) ? defaults : {}
  const overlay = isRecord(skin) ? skin : {}
  const baseModes = isRecord(base.modes) ? base.modes : {}
  const skinModes = isRecord(overlay.modes) ? overlay.modes : {}

  const modes: Record<string, AmbientModePolicy> = {}
  for (const mode of Object.keys(baseModes)) {
    modes[mode] = normalizeAmbientMode(baseModes[mode], mode)
  }
  for (const mode of Object.keys(skinModes)) {
    modes[mode] = normalizeAmbientMode(skinModes[mode], mode)
  }

  const quietSource = overlay.quietHours ?? base.quietHours
  const version = typeof overlay.version === 'number' && Number.isFinite(overlay.version)
    ? overlay.version
    : typeof base.version === 'number' && Number.isFinite(base.version)
      ? base.version
      : 1

  return { version, quietHours: normalizeQuietHours(quietSource), modes }
}

/** 按当前动作目录裁掉不存在的 item；空池保留，`enabled` 保持原样。 */
export function filterAmbientCatalog(
  catalog: AmbientCatalogSource | null | undefined,
  actionIds: ReadonlySet<string>,
): AmbientCatalog {
  const source = isRecord(catalog) ? catalog : {}
  const sourceModes = isRecord(source.modes) ? source.modes : {}
  const modes: Record<string, AmbientModePolicy> = {}

  for (const mode of Object.keys(sourceModes)) {
    const policy = normalizeAmbientMode(sourceModes[mode], mode)
    modes[mode] = {
      ...policy,
      items: policy.items.filter((item) => actionIds.has(item.action)),
    }
  }

  const version = typeof source.version === 'number' && Number.isFinite(source.version)
    ? source.version
    : 1
  return { version, quietHours: normalizeQuietHours(source.quietHours), modes }
}

/**
 * 按 presence 选出要交给引擎的策略。
 *
 * - `presenceOn !== true`：固定用 `off`；
 * - `presenceOn === true` 但 mode 缺失/不是四种合法模式：返回 null（fail closed）；
 * - 目录里没有对应 mode，或合并覆盖后仍没有：返回 null。
 */
export function selectAmbientPolicy(
  catalog: AmbientCatalogSource | null | undefined,
  overrides: AmbientOverrides | null | undefined,
  mode: string | null | undefined,
  presenceOn: boolean,
): AmbientModePolicy | null {
  const modeKey = presenceOn === true ? mode : 'off'
  if (typeof modeKey !== 'string' || !AMBIENT_MODE_SET.has(modeKey)) return null

  const source = isRecord(catalog) ? catalog : {}
  const modes = isRecord(source.modes) ? source.modes : {}
  const rawBase = modes[modeKey]
  if (!isRecord(rawBase)) return null

  const base = normalizeAmbientMode(rawBase, modeKey)
  const overrideModes = isRecord(overrides) && isRecord(overrides.modes) ? overrides.modes : {}
  const override = overrideModes[modeKey]
  const selected = isRecord(override) ? mergeAmbientMode(base, override) : base
  return { ...selected, mode: modeKey }
}
