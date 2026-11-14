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

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import type { SkinRef } from './skin-apply.ts'

export { resolveSkinApply, type SkinRef } from './skin-apply.ts'

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

export interface SkinPayload extends SkinRef {
  /** 主进程每次真正下发皮肤时递增；渲染进程用它区分「重放」与「用户重新选中」。 */
  revision: number
  config: unknown
  uri: string
}

/** 渲染进程可能晚于首推订阅；用缓存保证 ready 时能补发最近一份皮肤。 */
export interface SkinForwarder {
  /** 收到一份新皮肤：记下来并推送；内容完全相同则不重复推。 */
  onSkin: (payload: SkinPayload) => void
  /** 渲染进程就绪时补发最近一份，绕过去重。 */
  ready: () => void
  /** 供渲染进程挂载时主动拉取，避免首推丢失后一直停在默认皮肤。 */
  get: () => SkinPayload | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * 皮肤推送器的纯逻辑：不 import Electron，发送动作由调用方注入。
 *
 * 首推可能早于渲染进程注册 `onSkin`（和 `pet:state` 是同一个竞态），
 * 所以这里缓存最近一份；`ready()` 补发、`get()` 供挂载时主动拉取。
 */
export function createSkinForwarder(send: (payload: SkinPayload) => void): SkinForwarder {
  let latest: SkinPayload | null = null
  let lastSignature: string | null = null

  return {
    onSkin(payload: SkinPayload): void {
      latest = payload
      const signature = JSON.stringify(payload)
      if (signature === lastSignature) return
      lastSignature = signature
      send(payload)
    },
    ready(): void {
      if (latest) send(latest)
    },
    get(): SkinPayload | null {
      return latest
    },
  }
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
 * 检查 14 个动作引用的 `webm/<动画名>.webm` 是否都存在。
 *
 * 只校验 `skin.json` 不够：目录里缺素材时组件会在运行时才报错，坏皮肤会先顶掉
 * 能用的皮肤。返回缺失的动作名（按 `MOTIONS` 顺序），空数组表示齐全。
 * 动画名会先做目录内路径校验，`../` 之类的名字按缺失处理。
 */
export function missingSkinMedia(skinDir: string, motions: Record<string, unknown>): string[] {
  const webmDir = normalize(join(skinDir, 'webm'))
  const missing: string[] = []

  for (const motion of MOTIONS) {
    const name = motions[motion]
    if (typeof name !== 'string' || name.trim() === '') {
      missing.push(motion)
      continue
    }
    const file = normalize(join(webmDir, `${name}.webm`))
    if (!isInside(webmDir, file)) {
      missing.push(motion)
      continue
    }
    try {
      if (!statSync(file).isFile()) missing.push(motion)
    } catch {
      missing.push(motion)
    }
  }

  return missing
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

export interface SizeSyncState {
  /** 当前窗口实际尺寸。 */
  current: number
  /** 本地刚改、还没被服务端回声确认的尺寸；null = 没有待确认覆盖。 */
  pending: number | null
}

/** 右键本地改尺寸：立即生效，并记下待服务端 `settings.size` 回声确认。 */
export function noteLocalSize(size: number): SizeSyncState {
  return { current: size, pending: size }
}

/**
 * 决定一次远端 `settings.size` 是否要改窗口。
 *
 * - 没有 pending：远端与当前不同就应用；
 * - pending 与远端相同：服务端已回声，清掉覆盖，不重复设置窗口；
 * - pending 与远端不同：本地覆盖优先，忽略远端（`/pet/config` 写失败时窗口不会被拉回去）。
 */
export function resolveRemoteSize(
  state: SizeSyncState,
  remote: number,
): { state: SizeSyncState; apply: number | null } {
  if (state.pending !== null) {
    if (remote === state.pending) {
      return { state: { current: state.current, pending: null }, apply: null }
    }
    return { state, apply: null }
  }
  if (remote !== state.current) {
    return { state: { current: remote, pending: null }, apply: remote }
  }
  return { state, apply: null }
}

/**
 * 扫描 `<rootDir>/skins/*\/skin.json`。`rootDir` 是 `assets` 目录。
 *
 * 首项固定为默认皮肤；其余按目录名排序，保证每次上报的清单顺序稳定。
 * 非法目录名、读不到的文件、非法 JSON、未通过校验或缺动画文件的条目一律跳过，不抛错。
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
    const skinDir = join(skinsDir, id)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(skinDir, 'skin.json'), 'utf8'))
    } catch {
      continue
    }
    const validation = validateSkin(parsed)
    if (!validation.ok) continue
    if (missingSkinMedia(skinDir, validation.motions).length > 0) continue
    skins.push({ id, name: validation.name, config: parsed })
  }

  return skins
}
