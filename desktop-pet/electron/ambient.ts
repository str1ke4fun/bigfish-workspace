/**
 * 读取壳侧氛围目录。
 *
 * 文件位置（见设计文档 §4.3.1）：
 * ```text
 * assets/ambient.json                 默认策略（必需）
 * assets/skins/<id>/ambient.json      皮肤覆盖（可选）
 * ```
 *
 * 失败边界：
 * - 默认文件缺失、JSON 语法错误、根形状不对：抛错，让调用方保留上一份目录；
 * - 单条 item 的动作不在当前目录、字段不合法：只丢弃该条并记日志，其它继续可用；
 * - 皮肤文件缺失：正常回落到默认目录，不算错误。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTION_ID_RE } from './actions.ts'
import { SIMPLE_SKIN_ID } from './skin.ts'
import {
  AMBIENT_MODES,
  emptyAmbientCatalog,
  mergeAmbientCatalogs,
  normalizeAmbientFrequency,
  normalizeAmbientItem,
  normalizeQuietHours,
  type AmbientCatalog,
  type AmbientItem,
  type AmbientModePolicy,
} from '../shared/ambient-model.ts'

// 任务/调用方从本模块取解析器时，也能顺带拿到纯合并工具（与 Task 5 的用法一致）。
export { emptyAmbientCatalog, mergeAmbientCatalogs } from '../shared/ambient-model.ts'
export { filterAmbientCatalog, mergeAmbientMode, selectAmbientPolicy } from '../shared/ambient-model.ts'
export type {
  AmbientCatalog,
  AmbientFrequency,
  AmbientItem,
  AmbientModePolicy,
  AmbientOverrides,
} from '../shared/ambient-model.ts'

const AMBIENT_MODE_SET: ReadonlySet<string> = new Set(AMBIENT_MODES)

export interface ParseAmbientOptions {
  /** 当前动作目录；不在其中的 item 必须丢弃。 */
  actionIds: ReadonlySet<string>
  log?: (message: string) => void
}

export interface ParseAmbientResult {
  catalog: AmbientCatalog
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeLog(log: ((message: string) => void) | undefined, message: string): void {
  try {
    log?.(message)
  } catch {
    // 日志不能反过来破坏目录解析。
  }
}

function report(
  errors: string[],
  log: ((message: string) => void) | undefined,
  message: string,
): void {
  errors.push(message)
  safeLog(log, message)
}

function parseMode(
  raw: Record<string, unknown>,
  mode: string,
  actionIds: ReadonlySet<string>,
  errors: string[],
  log: ((message: string) => void) | undefined,
): AmbientModePolicy {
  const items: AmbientItem[] = []

  if (Array.isArray(raw.items)) {
    const order: string[] = []
    const byAction = new Map<string, AmbientItem>()

    raw.items.forEach((entry, index) => {
      const item = normalizeAmbientItem(entry)
      if (!item) {
        report(errors, log, `模式 ${mode} 的氛围条目 #${index + 1} 已丢弃：条目必须是包含 action 的对象。`)
        return
      }
      if (!ACTION_ID_RE.test(item.action) || !actionIds.has(item.action)) {
        report(errors, log, `模式 ${mode} 的氛围条目 #${index + 1} (${item.action}) 已丢弃：动作不在当前目录。`)
        return
      }
      if (isRecord(entry) && entry.weight !== undefined) {
        const weight = entry.weight
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
          safeLog(log, `模式 ${mode} 的氛围条目 #${index + 1} (${item.action}) weight 不合法，按 1 处理。`)
        }
      }

      // 重复 action：后者覆盖前者，保留首次出现的位置。
      if (!byAction.has(item.action)) order.push(item.action)
      else safeLog(log, `模式 ${mode} 的氛围条目 #${index + 1} (${item.action}) 重复，后者覆盖前者。`)
      byAction.set(item.action, item)
    })

    for (const action of order) items.push(byAction.get(action)!)
  } else if (raw.items !== undefined && raw.items !== null) {
    report(errors, log, `模式 ${mode}.items 必须是数组，已按空池处理。`)
  }

  if (raw.frequency !== undefined && raw.frequency !== null && !isRecord(raw.frequency)) {
    report(errors, log, `模式 ${mode}.frequency 必须是对象，已使用默认频率。`)
  }

  return {
    mode,
    enabled: raw.enabled !== false,
    items,
    frequency: normalizeAmbientFrequency(raw.frequency),
  }
}

/**
 * 解析一份 `ambient.json`。
 *
 * 根形状（对象且含 `modes` 对象）不合法时抛错；其余问题逐条记入 `errors`。
 * `actionIds` 用于丢弃当前动作目录里不存在的 item。
 */
export function parseAmbientCatalog(raw: unknown, options: ParseAmbientOptions): ParseAmbientResult {
  if (!isRecord(raw) || !isRecord(raw.modes)) {
    throw new Error('氛围目录必须是包含 modes 对象的对象。')
  }

  const errors: string[] = []
  const log = options?.log
  const actionIds = options?.actionIds ?? new Set<string>()
  const catalog = emptyAmbientCatalog()

  if (raw.version !== undefined && raw.version !== 1) {
    report(errors, log, `不支持的氛围目录版本：${String(raw.version)}，按 version=1 处理。`)
  }

  if (raw.quietHours !== undefined && raw.quietHours !== null) {
    catalog.quietHours = normalizeQuietHours(raw.quietHours)
    if (catalog.quietHours === null) report(errors, log, 'quietHours 不合法，已忽略。')
  }

  for (const [mode, modeRaw] of Object.entries(raw.modes)) {
    if (!AMBIENT_MODE_SET.has(mode)) {
      report(errors, log, `未知陪看模式 ${mode} 已忽略。`)
      continue
    }
    if (!isRecord(modeRaw)) {
      report(errors, log, `模式 ${mode} 必须是对象，已忽略。`)
      continue
    }
    catalog.modes[mode] = parseMode(modeRaw, mode, actionIds, errors, log)
  }

  return { catalog, errors }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

function isMissingFile(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

/**
 * 读取默认目录，再叠上皮肤目录（如果该皮肤提供了 `ambient.json`）。
 *
 * 默认文件必需；皮肤文件可选。JSON/根形状/皮肤 id 问题都会抛错，
 * 由调用方保留上一份目录；单条 item 的错误只记日志、不影响其它条目。
 */
export async function readAmbientCatalog(
  assetsRoot: string,
  skinId: string,
  actionIds: ReadonlySet<string>,
  log?: (message: string) => void,
): Promise<AmbientCatalog> {
  const id = typeof skinId === 'string' ? skinId : ''
  if (id !== '' && !SIMPLE_SKIN_ID.test(id)) {
    throw new Error(`皮肤 id 不合法：${id}`)
  }

  const defaults = parseAmbientCatalog(await readJson(join(assetsRoot, 'ambient.json')), {
    actionIds,
    log,
  })
  if (id === '') return defaults.catalog

  let skinRaw: unknown
  try {
    skinRaw = await readJson(join(assetsRoot, 'skins', id, 'ambient.json'))
  } catch (error) {
    if (isMissingFile(error)) return defaults.catalog
    throw error
  }

  const skin = parseAmbientCatalog(skinRaw, { actionIds, log })
  return mergeAmbientCatalogs(defaults.catalog, skin.catalog)
}
