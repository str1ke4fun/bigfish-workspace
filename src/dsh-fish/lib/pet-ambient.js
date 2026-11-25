/**
 * pet-ambient.js —— 桌宠氛围策略的纯数据层
 *
 * 这里只有数据：没有定时器、没有 IO、没有 import。服务端把壳上报的默认策略
 * 当作基线，叠加用户在每个在场模式（off / event / ambient / work）下的覆盖，
 * 再按壳最新的 hello 动作目录校验动作 id。真正的调度在桌面壳里。
 *
 * 形状：
 *   config   = { version: 1, revision, quietHours, modes: { [mode]: policy } }
 *   policy   = { enabled, items: [{ action, weight, enabled, cooldownSec, minIdleSec }], frequency }
 *   frequency= { intervalMinSec, intervalMaxSec, minGapSec, maxPerIdle, maxPerDay, settleSec, actionCooldownSec }
 *
 * 两条硬约束：
 *   - 纯函数：绝不改写传入的 config / defaults，返回的结果是深拷贝；
 *   - 每次成功改动 revision + 1，方便壳判断是否需要重新拉取。
 */

export const AMBIENT_MODES = ['off', 'event', 'ambient', 'work']

/** 归一化后缺失频率字段的保守回落值。 */
const DEFAULT_FREQUENCY = {
  intervalMinSec: 600,
  intervalMaxSec: 1800,
  minGapSec: 120,
  maxPerIdle: 2,
  maxPerDay: 8,
  settleSec: 120,
  actionCooldownSec: 3600,
}

const ITEM_FIELDS = ['weight', 'enabled', 'cooldownSec', 'minIdleSec']
const FREQUENCY_FIELDS = [
  'intervalMinSec', 'intervalMaxSec', 'minGapSec',
  'maxPerIdle', 'maxPerDay', 'settleSec', 'actionCooldownSec',
]
const OPS = new Set([
  'set-enabled', 'replace-mode', 'set-frequency',
  'add-item', 'set-item', 'remove-item', 'reset',
])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 数字或非空数字字符串；其它（含 null / ''）一律 NaN，交给调用方回落。 */
function toNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return Number.NaN
}

/** 非负数；非法返回 fallback。 */
function nonNegative(value, fallback) {
  const n = toNumber(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** 负数夹到 0，非法值返回 fallback。 */
function clampNonNegative(value, fallback) {
  const n = toNumber(value)
  if (!Number.isFinite(n)) return fallback
  return n < 0 ? 0 : n
}

/** 权重：非法或负数一律按 1；0 保留为 0（真要禁用请用 enabled:false）。 */
function normalizeWeight(value) {
  const n = toNumber(value)
  return Number.isFinite(n) && n >= 0 ? n : 1
}

function normalizeItem(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.action !== 'string' || raw.action.length === 0) return null
  return {
    action: raw.action,
    weight: normalizeWeight(raw.weight),
    enabled: raw.enabled !== false,
    cooldownSec: nonNegative(raw.cooldownSec, 0),
    minIdleSec: nonNegative(raw.minIdleSec, 0),
  }
}

function normalizeFrequency(raw, errors, label) {
  const source = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    errors.push(`${label}.frequency must be an object`)
  }
  const frequency = {}
  for (const field of FREQUENCY_FIELDS) {
    frequency[field] = nonNegative(source[field], DEFAULT_FREQUENCY[field])
  }
  // 最小间隔不能大于最大间隔；只给了一边时也保持一致。
  if (frequency.intervalMinSec > frequency.intervalMaxSec) {
    const min = frequency.intervalMinSec
    frequency.intervalMinSec = frequency.intervalMaxSec
    frequency.intervalMaxSec = min
  }
  return frequency
}

function normalizePolicy(raw, errors = [], label = 'policy') {
  const source = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    errors.push(`${label} must be an object`)
  }
  const items = []
  if (Array.isArray(source.items)) {
    source.items.forEach((entry, index) => {
      const item = normalizeItem(entry)
      if (item) items.push(item)
      else errors.push(`${label}.items[${index}] is invalid`)
    })
  } else if (source.items !== undefined && source.items !== null) {
    errors.push(`${label}.items must be an array`)
  }
  return {
    enabled: source.enabled === true,
    items,
    frequency: normalizeFrequency(source.frequency, errors, label),
  }
}

function normalizeQuietHours(raw, errors) {
  if (raw === null || raw === undefined) return null
  if (!isPlainObject(raw)) {
    errors.push('quietHours must be an object or null')
    return null
  }
  const time = (value) => (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null)
  const start = time(raw.start)
  const end = time(raw.end)
  if (!start || !end) {
    errors.push('quietHours.start/end must be HH:MM')
    return null
  }
  return {
    start,
    end,
    afterJitterSec: nonNegative(raw.afterJitterSec, 0),
  }
}

function toIdSet(value) {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value)
  if (isPlainObject(value)) return new Set(Object.keys(value))
  return new Set()
}

export function emptyAmbientConfig() {
  return { version: 1, revision: 0, quietHours: null, modes: {} }
}

/** 把任意输入收拾成合法策略；坏字段尽量修正并登记到 errors，不抛异常。 */
export function normalizeAmbientConfig(raw) {
  const errors = []
  const config = emptyAmbientConfig()
  if (!isPlainObject(raw)) {
    if (raw !== null && raw !== undefined) errors.push('ambient config must be an object')
    return { config, errors }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    errors.push(`unsupported version: ${raw.version}`)
  }
  config.version = 1
  config.revision = nonNegative(raw.revision, 0)
  config.quietHours = normalizeQuietHours(raw.quietHours, errors)
  if (isPlainObject(raw.modes)) {
    for (const key of Object.keys(raw.modes)) {
      if (!AMBIENT_MODES.includes(key)) {
        errors.push(`unknown mode: ${key}`)
        continue
      }
      if (!isPlainObject(raw.modes[key])) {
        errors.push(`modes.${key} must be an object`)
        continue
      }
      config.modes[key] = normalizePolicy(raw.modes[key], errors, `modes.${key}`)
    }
  } else if (raw.modes !== undefined && raw.modes !== null) {
    errors.push('modes must be an object')
  }
  return { config, errors }
}

/**
 * 合并覆盖与默认：某模式只要 config 里有覆盖就用覆盖，否则回落 defaults。
 * 没有出现在任何一侧的模式不会出现在结果里（例如从没配置过的 off）。
 */
export function effectiveAmbientModes(config, defaults) {
  const modes = {}
  const keys = new Set()
  for (const source of [defaults, config]) {
    if (isPlainObject(source?.modes)) {
      for (const key of Object.keys(source.modes)) keys.add(key)
    }
  }
  for (const mode of keys) {
    if (!AMBIENT_MODES.includes(mode)) continue
    const override = isPlainObject(config?.modes) ? config.modes[mode] : undefined
    const raw = isPlainObject(override)
      ? override
      : isPlainObject(defaults?.modes) ? defaults.modes[mode] : undefined
    modes[mode] = normalizePolicy(raw, [], `modes.${mode}`)
  }
  return modes
}

function bad(why, errors) {
  return errors ? { ok: false, why, errors } : { ok: false, why }
}

/** 覆盖优先、默认兜底；两侧都没有（或都不是对象）就是没有基线。 */
function basePolicy(base, defaults, mode) {
  if (isPlainObject(base.modes[mode])) return base.modes[mode]
  if (isPlainObject(defaults?.modes) && isPlainObject(defaults.modes[mode])) {
    return defaults.modes[mode]
  }
  return undefined
}

/**
 * 执行一个策略变更操作。返回新配置，输入永远不被改写。
 *
 * 成功：{ ok: true, config, errors }（errors 里可能是被丢弃的未知动作等提示）
 * 失败：{ ok: false, why, errors? }
 */
export function applyAmbientOp(config, defaults, op, options = {}) {
  const actionIds = toIdSet(options?.actionIds)

  if (!isPlainObject(op)) return bad('INVALID_OP')
  if (typeof op.op !== 'string' || !OPS.has(op.op)) return bad('UNKNOWN_OP')
  if (typeof op.mode !== 'string' || !AMBIENT_MODES.includes(op.mode)) return bad('UNKNOWN_MODE')

  const { config: base } = normalizeAmbientConfig(config)
  const mode = op.mode
  const errors = []

  if (op.op === 'reset') {
    if (basePolicy(base, defaults, mode) === undefined) return bad('NO_BASE_POLICY', errors)
    delete base.modes[mode]
    base.revision = nonNegative(base.revision, 0) + 1
    return { ok: true, config: base, errors }
  }

  let policy
  if (op.op === 'replace-mode') {
    if (!isPlainObject(op.policy)) return bad('INVALID_OP', errors)
    policy = normalizePolicy(op.policy, errors, `modes.${mode}`)
    const known = []
    for (const item of policy.items) {
      if (actionIds.has(item.action)) known.push(item)
      else errors.push(`unknown item action: ${item.action}`)
    }
    policy.items = known
  } else {
    const source = basePolicy(base, defaults, mode)
    if (source === undefined) return bad('NO_BASE_POLICY', errors)
    policy = normalizePolicy(source, errors, `modes.${mode}`)

    if (op.op === 'set-enabled') {
      if (typeof op.enabled !== 'boolean') return bad('INVALID_OP', errors)
      policy.enabled = op.enabled
    } else if (op.op === 'set-frequency') {
      if (!isPlainObject(op.patch)) return bad('INVALID_OP', errors)
      for (const field of FREQUENCY_FIELDS) {
        if (op.patch[field] !== undefined) {
          policy.frequency[field] = clampNonNegative(op.patch[field], policy.frequency[field])
        }
      }
      if (policy.frequency.intervalMinSec > policy.frequency.intervalMaxSec) {
        const min = policy.frequency.intervalMinSec
        policy.frequency.intervalMinSec = policy.frequency.intervalMaxSec
        policy.frequency.intervalMaxSec = min
      }
    } else if (op.op === 'add-item') {
      if (typeof op.action !== 'string' || !actionIds.has(op.action)) {
        return bad('UNKNOWN_ACTION', errors)
      }
      if (policy.items.some((item) => item.action === op.action)) {
        return bad('DUPLICATE_ITEM', errors)
      }
      const item = {
        action: op.action,
        weight: normalizeWeight(op.weight),
        enabled: op.enabled !== false,
        cooldownSec: nonNegative(op.cooldownSec, 0),
        minIdleSec: nonNegative(op.minIdleSec, 0),
      }
      policy.items.push(item)
    } else if (op.op === 'set-item') {
      if (!isPlainObject(op.patch)) return bad('INVALID_OP', errors)
      if (typeof op.action !== 'string' || !actionIds.has(op.action)) {
        return bad('UNKNOWN_ACTION', errors)
      }
      const item = policy.items.find((entry) => entry.action === op.action)
      if (!item) return bad('ITEM_NOT_FOUND', errors)
      for (const field of ITEM_FIELDS) {
        if (op.patch[field] === undefined) continue
        if (field === 'weight') item.weight = normalizeWeight(op.patch.weight)
        else if (field === 'enabled') item.enabled = op.patch.enabled !== false
        else item[field] = clampNonNegative(op.patch[field], item[field])
      }
    } else if (op.op === 'remove-item') {
      if (typeof op.action !== 'string') return bad('UNKNOWN_ACTION', errors)
      const index = policy.items.findIndex((entry) => entry.action === op.action)
      if (index < 0) return bad('ITEM_NOT_FOUND', errors)
      policy.items.splice(index, 1)
    }
  }

  if (policy.enabled && policy.items.length === 0) {
    return bad('EMPTY_POOL', errors)
  }

  base.modes[mode] = policy
  base.version = 1
  base.revision = nonNegative(base.revision, 0) + 1
  return { ok: true, config: base, errors }
}
