/**
 * 右键菜单与托盘菜单共用的菜单模型：纯数据 + 回调，不 import Electron。
 * main.ts 再把它翻成 Electron 的 MenuItemConstructorOptions。
 */

import type { ActionDefinition } from './actions'

export interface MenuState {
  size: number
  opacity: number
  /** 0 = 跟随大小。 */
  width: number
  hidden: boolean
  /** null = 服务端没回话，托盘里不显示陪看项。 */
  presence: { on: boolean; mode: string | null } | null
  /** 服务端当前场景；null = 不在休息/出门。 */
  scene: { kind: 'rest' | 'out' } | null
  /** 长唤醒到期时刻；null = 没有在长唤醒。 */
  awakeUntil: number | null
}

export interface MenuCallbacks {
  motion: (motion: string) => void
  action: (id: string) => void
  /** 休息动作先改服务端 scene，再播放同一个注册动作。 */
  rest: (id: string, action: PetRestAction) => void
  stop: () => void
  reload: () => void
  size: (size: number) => void
  opacity: (opacity: number) => void
  width: (width: number) => void
  toggleHidden: () => void
  resetPosition: () => void
  presence: (mode: 'off' | 'event' | 'ambient' | 'work') => void
  openWorkbench: () => void
  quit: () => void
}

export type PetRestAction = 'sleep' | 'wake' | 'awake'

export interface MenuItemModel {
  label?: string
  separator?: boolean
  checked?: boolean
  click?: () => void
  submenu?: MenuItemModel[]
}

const COMMON_MOTIONS: ReadonlyArray<[string, string]> = [
  ['挥手', 'waving'],
  ['思考', 'thinking'],
  ['忙碌', 'working'],
  ['看结果', 'result'],
  ['等待', 'waiting'],
  ['庆祝', 'success'],
  ['沮丧', 'error'],
]
const STATE_MOTIONS: ReadonlyArray<[string, string]> = [
  ['待机', 'idle'],
  ['张望', 'turn'],
  ['向左走', 'moving-left'],
  ['向右走', 'moving-right'],
  ['跑动', 'running'],
  ['清点', 'review'],
  ['失败', 'failed'],
]
const SIZES: ReadonlyArray<[string, number]> = [['小', 320], ['中', 400], ['大', 462]]
const OPACITIES: ReadonlyArray<number> = [90, 70, 50]
const WIDTHS: ReadonlyArray<[string, number]> = [['跟随大小', 0], ['小', 260], ['中', 320], ['大', 400]]
const PRESENCE_MODES: ReadonlyArray<[string, 'event' | 'ambient' | 'work']> = [
  ['事件', 'event'],
  ['氛围', 'ambient'],
  ['工作', 'work'],
]

/** 默认素材与用户皮肤都可能改 action id；休息组内的语义文案仍是稳定的 UI 契约。 */
export function petRestAction(action: ActionDefinition): PetRestAction | null {
  if (action.id === 'sleep' || action.id === 'asset-091') return 'sleep'
  if (action.id === 'wake' || action.id === 'asset-093') return 'wake'
  if (action.group.trim() !== '休息') return null

  const label = action.label.trim()
  if (label.includes('起来') || label.includes('醒')) return 'wake'
  if (label.includes('睡') || label.includes('眠')) return 'sleep'
  return null
}

/** 长唤醒/回去睡复用休息组里已注册的动作；没有就只改状态（空 id）。 */
function restActionId(actions: readonly ActionDefinition[], want: PetRestAction): string {
  for (const action of actions) {
    if (petRestAction(action) === want) return action.id
  }
  return ''
}

export function buildMenuModel(
  state: MenuState,
  actions: readonly ActionDefinition[],
  callbacks: MenuCallbacks,
  kind: 'context' | 'tray',
): MenuItemModel[] {
  const items: MenuItemModel[] = []

  if (kind === 'tray') {
    items.push({ label: state.hidden ? '显示桌宠' : '隐藏桌宠', click: callbacks.toggleHidden })
    items.push({ label: '回到右下角', click: callbacks.resetPosition })
    items.push({ separator: true })
  }

  // 长唤醒只在休息中出现；收回项只在长唤醒中出现。两者互斥，避免菜单常驻噪音。
  if (state.scene?.kind === 'rest') {
    items.push({
      label: '起来陪我',
      click: () => callbacks.rest(restActionId(actions, 'wake'), 'awake'),
    })
  }
  if (typeof state.awakeUntil === 'number' && Number.isFinite(state.awakeUntil)) {
    items.push({
      label: '回去睡吧',
      click: () => callbacks.rest(restActionId(actions, 'sleep'), 'sleep'),
    })
  }

  const registeredGroups = new Map<string, MenuItemModel[]>()
  for (const action of actions) {
    const group = action.group.trim() || '其他'
    let groupItems = registeredGroups.get(group)
    if (!groupItems) {
      groupItems = []
      registeredGroups.set(group, groupItems)
    }
    const restAction = petRestAction(action)
    groupItems.push({
      label: action.label,
      click: () => restAction === null
        ? callbacks.action(action.id)
        : callbacks.rest(action.id, restAction),
    })
  }

  items.push({
    label: '演一个动作',
    submenu: [
      {
        label: '常用',
        submenu: COMMON_MOTIONS.map(([label, motion]) => ({ label, click: () => callbacks.motion(motion) })),
      },
      {
        label: '状态',
        submenu: STATE_MOTIONS.map(([label, motion]) => ({ label, click: () => callbacks.motion(motion) })),
      },
      ...[...registeredGroups].map(([label, submenu]) => ({ label, submenu })),
      { label: '停下当前动作', click: callbacks.stop },
      { label: '重新载入动作', click: callbacks.reload },
    ],
  })
  items.push({
    label: '大小',
    submenu: SIZES.map(([label, size]) => ({
      label,
      checked: state.size === size,
      click: () => callbacks.size(size),
    })),
  })
  items.push({
    label: '气泡',
    submenu: [
      ...OPACITIES.map((value) => ({
        label: `透明 ${value}%`,
        checked: state.opacity === value,
        click: () => callbacks.opacity(value),
      })),
      { separator: true },
      ...WIDTHS.map(([label, value]) => ({
        label: `宽度 ${label}`,
        checked: state.width === value,
        click: () => callbacks.width(value),
      })),
    ],
  })

  if (kind === 'tray') {
    if (state.presence) {
      const { on, mode } = state.presence
      items.push({
        label: '陪你看屏幕',
        submenu: [
          ...PRESENCE_MODES.map(([label, value]) => ({
            label,
            checked: on && mode === value,
            click: () => callbacks.presence(value),
          })),
          { separator: true },
          { label: '关闭', checked: !on, click: () => callbacks.presence('off') },
        ],
      })
    }
    items.push({ label: '打开工作台', click: callbacks.openWorkbench })
  } else {
    items.push({ separator: true })
    items.push({ label: '隐藏桌宠', click: callbacks.toggleHidden })
  }

  if (kind === 'tray') items.push({ separator: true })
  items.push({ label: '退出', click: callbacks.quit })
  return items
}
