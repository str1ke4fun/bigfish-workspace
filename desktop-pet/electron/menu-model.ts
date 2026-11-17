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
}

export interface MenuCallbacks {
  motion: (motion: string) => void
  action: (id: string) => void
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

  const registeredGroups = new Map<string, MenuItemModel[]>()
  for (const action of actions) {
    const group = action.group.trim() || '其他'
    let groupItems = registeredGroups.get(group)
    if (!groupItems) {
      groupItems = []
      registeredGroups.set(group, groupItems)
    }
    groupItems.push({ label: action.label, click: () => callbacks.action(action.id) })
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
