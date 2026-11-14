/**
 * 皮肤清单与设置应用的纯逻辑。
 *
 * 不 import Electron，也不直接读应用路径：`scanSkins` 的根目录由调用方传入，
 * 这样本地皮肤目录的解析、校验与幂等判断都能在 `node --test` 里直接跑。
 *
 * 皮肤目录（见设计文档 §7.2）：
 * ```text
 * assets/skins/
 *   <id>/
 *     skin.json   # { name, motions: { ...14 个动作... }, size? }
 *     webm/*.webm
 * ```
 * 默认皮肤不在 `skins/` 下，清单首项固定为 `{ id: '', name: '默认' }`。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 14 个动作名，与 `dsh-pet-component` 的 `MOTIONS` 一致（`dragging` 是手势态，不算）。 */
export const MOTIONS = [
  'idle',
  'turn',
  'moving-left',
  'moving-right',
  'waving',
  'thinking',
  'working',
  'result',
  'waiting',
  'running',
  'review',
  'failed',
  'success',
  'error',
] as const

/** 皮肤 id 只允许小写字母、数字与连字符；同时挡掉 `../escape` 之类的路径穿越。 */
export const SIMPLE_SKIN_ID = /^[a-z0-9-]{1,32}$/

export interface PetSettings {
  size: number
  skin: string
}

export type SkinValidation =
  | { ok: true; name: string; motions: Record<string, unknown> }
  | { ok: false; why: string }

export interface ScannedSkin {
  id: string
  name: string
  config: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验 `skin.json`：必须是对象、`name` 为非空字符串、`motions` 覆盖全部 14 个动作
 * 且每个值都是非空字符串。失败时给出可直接写进日志的原因。
 */
export function validateSkin(json: unknown): SkinValidation {
  if (!isRecord(json)) return { ok: false, why: 'skin.json 必须是对象。' }

  const name = typeof json.name === 'string' ? json.name.trim() : ''
  if (name === '') return { ok: false, why: 'name 必须是非空字符串。' }

  if (!isRecord(json.motions)) return { ok: false, why: 'motions 必须是对象。' }

  const motions = json.motions
  const missing = MOTIONS.filter((motion) => {
    const value = motions[motion]
    return typeof value !== 'string' || value.trim() === ''
  })
  if (missing.length > 0) {
    return { ok: false, why: `motions 缺少动作：${missing.join(', ')}` }
  }

  return { ok: true, name, motions }
}

/**
 * 服务的 `settings` 是否带来了新值。
 *
 * 只比较 `next` 显式给出的字段：轮询每 2 秒就会重复下发同一份设置，
 * 相同值不能触发重新加载（否则窗口尺寸和皮肤会不停抖动/重载）。
 */
export function shouldApplySettings(
  current: PetSettings,
  next: { size?: number; skin?: string },
): boolean {
  if (typeof next.size === 'number' && next.size !== current.size) return true
  if (typeof next.skin === 'string' && next.skin !== current.skin) return true
  return false
}

/**
 * 扫描 `<rootDir>/skins/*\/skin.json`。`rootDir` 是 `assets` 目录。
 *
 * 首项固定为默认皮肤；其余按目录名排序，保证每次上报的清单顺序稳定。
 * 非法目录名、读不到的文件、非法 JSON、未通过校验的条目一律跳过，不抛错。
 */
export function scanSkins(rootDir: string): ScannedSkin[] {
  const skins: ScannedSkin[] = [{ id: '', name: '默认', config: null }]
  const skinsDir = join(rootDir, 'skins')

  let entries: string[]
  try {
    entries = readdirSync(skinsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SIMPLE_SKIN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return skins
  }

  for (const id of entries) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(skinsDir, id, 'skin.json'), 'utf8'))
    } catch {
      continue
    }
    const validation = validateSkin(parsed)
    if (!validation.ok) continue
    skins.push({ id, name: validation.name, config: parsed })
  }

  return skins
}
