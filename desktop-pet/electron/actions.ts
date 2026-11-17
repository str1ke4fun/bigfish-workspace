/**
 * 动作注册表的纯解析与合并逻辑。
 *
 * `actions.json` 是开放数据：单条登记不合法时只丢弃该条，其余动作继续可用。
 * 文件读取留给调用方注入，测试不需要真实素材或临时目录。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 动作 id 与皮肤 id 使用同一套安全字符集。 */
export const ACTION_ID_RE = /^[a-z0-9-]{1,32}$/

export interface ActionDefinition {
  id: string
  label: string
  anim?: string
  seq?: string[]
  loop: boolean
  group: string
  /** 内部字段：播放该动作时应使用的素材基地址；hello/菜单不暴露。 */
  mediaUri?: string
}

export interface ParseActionsOptions {
  /** 该注册表对应的 `webm/` 目录。 */
  mediaDir: string
  /** 通常传 `existsSync`；测试可注入纯内存集合。 */
  exists: (file: string) => boolean
  log?: (message: string) => void
}

export interface ParseActionsResult {
  actions: ActionDefinition[]
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeAnimationName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false
  // Windows 文件名同时拒绝 `/`、`\`、盘符冒号与控制字符；在 POSIX 上也提前挡住
  // Windows 侧会被解释为路径分隔符/绝对路径的名字。
  return !/[\\/:*?"<>|\u0000-\u001f]/.test(name)
}

/** 把动作里的动画名解析为 `webm/<名>.webm`，越界时返回 null。 */
function actionMediaFile(mediaDir: string, animationName: string): string | null {
  if (!isSafeAnimationName(animationName)) return null

  const root = resolve(mediaDir)
  const file = resolve(root, `${animationName}.webm`)
  const rel = relative(root, file)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return file
}

function cloneAction(action: ActionDefinition): ActionDefinition {
  const copy: ActionDefinition = {
    id: action.id,
    label: action.label,
    loop: action.loop,
    group: action.group,
  }
  if (action.anim !== undefined) copy.anim = action.anim
  if (action.seq !== undefined) copy.seq = [...action.seq]
  if (action.mediaUri !== undefined) copy.mediaUri = action.mediaUri
  return copy
}

/**
 * 解析一份 `{ actions: [...] }` 注册表。
 *
 * 重复 id 由同文件中的后者覆盖前者；输出保留 id 首次出现的位置，确保菜单与
 * 目录推送不会因为覆盖而改变无关动作的顺序。坏条目逐条记入 `errors` 和 `log`。
 */
export function parseActions(raw: unknown, options: ParseActionsOptions): ParseActionsResult {
  const actions: ActionDefinition[] = []
  const errors: string[] = []

  function report(index: number, id: string, reason: string): void {
    const suffix = id === '' ? '' : ` (${id})`
    const message = `动作 #${index + 1}${suffix} 已丢弃：${reason}`
    errors.push(message)
    try {
      options.log?.(message)
    } catch {
      // 日志不能反过来破坏注册表解析。
    }
  }

  if (!isRecord(raw) || !Array.isArray(raw.actions)) {
    const message = '动作注册表必须是包含 actions 数组的对象。'
    errors.push(message)
    try {
      options.log?.(message)
    } catch {
      // 同上：坏日志器不改变解析结果。
    }
    return { actions, errors }
  }

  const byId = new Map<string, ActionDefinition>()

  raw.actions.forEach((entry, index) => {
    if (!isRecord(entry)) {
      report(index, '', '条目必须是对象。')
      return
    }

    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!ACTION_ID_RE.test(id)) {
      report(index, id, 'id 必须是 1–32 位小写字母、数字或连字符。')
      return
    }

    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (label === '') {
      report(index, id, 'label 必须是非空字符串。')
      return
    }

    const hasAnim = Object.hasOwn(entry, 'anim')
    const hasSeq = Object.hasOwn(entry, 'seq')
    if (hasAnim === hasSeq) {
      report(index, id, 'anim 与 seq 必须严格二选一。')
      return
    }

    let anim: string | undefined
    let seq: string[] | undefined
    if (hasAnim) {
      anim = typeof entry.anim === 'string' ? entry.anim.trim() : ''
      if (anim === '') {
        report(index, id, 'anim 必须是非空动画名。')
        return
      }
    } else {
      if (!Array.isArray(entry.seq) || entry.seq.length === 0) {
        report(index, id, 'seq 必须是非空数组。')
        return
      }
      seq = []
      for (const part of entry.seq) {
        const name = typeof part === 'string' ? part.trim() : ''
        if (name === '') {
          report(index, id, 'seq 的每一段都必须是非空动画名。')
          return
        }
        seq.push(name)
      }
    }

    let loop = false
    if (Object.hasOwn(entry, 'loop')) {
      if (typeof entry.loop !== 'boolean') {
        report(index, id, 'loop 必须是布尔值。')
        return
      }
      loop = entry.loop
    }

    let group = '其他'
    if (Object.hasOwn(entry, 'group')) {
      if (typeof entry.group !== 'string') {
        report(index, id, 'group 必须是字符串。')
        return
      }
      const normalized = entry.group.trim()
      if (normalized !== '') group = normalized
    }

    const animationNames = anim === undefined ? seq! : [anim]
    const files: string[] = []
    for (const name of animationNames) {
      const file = actionMediaFile(options.mediaDir, name)
      if (file === null) {
        report(index, id, `动画名路径越界：${name}`)
        return
      }
      files.push(file)
    }

    const missing: string[] = []
    try {
      animationNames.forEach((name, partIndex) => {
        if (!options.exists(files[partIndex])) missing.push(name)
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      report(index, id, `检查 webm 素材失败：${detail}`)
      return
    }
    if (missing.length > 0) {
      report(index, id, `缺 webm 素材：${missing.join(', ')}`)
      return
    }

    const action: ActionDefinition = { id, label, loop, group }
    if (anim !== undefined) action.anim = anim
    if (seq !== undefined) action.seq = seq
    byId.set(id, action)
  })

  actions.push(...byId.values())
  return { actions, errors }
}

/**
 * 合并默认注册表与皮肤注册表。
 *
 * 先默认、后皮肤；同 id 的皮肤条目覆盖默认条目，但保留该 id 首次出现的位置。
 * 返回深拷贝，调用方修改结果不会污染两份输入。
 */
export function mergeActionCatalogs(
  defaults: readonly ActionDefinition[],
  skin: readonly ActionDefinition[],
): ActionDefinition[] {
  const byId = new Map<string, ActionDefinition>()
  for (const action of defaults) byId.set(action.id, cloneAction(action))
  for (const action of skin) byId.set(action.id, cloneAction(action))
  return [...byId.values()]
}

/** 单段动作返回一项；序列动作返回按播放顺序排列的副本。 */
export function actionAnimationNames(action: ActionDefinition): string[] {
  if (action.anim !== undefined) return [action.anim]
  return action.seq === undefined ? [] : [...action.seq]
}
