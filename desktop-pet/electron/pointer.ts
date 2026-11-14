/**
 * 点击穿透与窗口位置的纯函数。
 *
 * 这一层刻意不 import Electron：`test/pointer.test.ts` 在普通 Node 下直接跑，
 * `window.ts` / `App.tsx` 只把 Electron / DOM 的测量结果喂进来。
 */

export type WindowRect = {
  x: number
  y: number
  width: number
  height: number
}

export type PointerContext = {
  /** 指针在宠物身体命中框内 */
  overPet: boolean
  /** 指针在气泡、对话输入框等渲染层 UI 上 */
  overUi: boolean
  /** 正在拖拽宠物（v1 恒为 false） */
  dragging: boolean
}

/** 只有身体、UI、拖拽三者都不在时，整窗才穿透。 */
export function shouldIgnoreMouse({ overPet, overUi, dragging }: PointerContext): boolean {
  return !(overPet || overUi || dragging)
}

function intersectionArea(a: WindowRect, b: WindowRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

function inside(rect: WindowRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/**
 * 把窗口位置夹进某个显示器的工作区。
 *
 * 选屏顺序：窗口中心所在屏 → 与窗口重叠面积最大的屏 → `primary`（缺省数组第一个，
 * 调用方应把主屏放在第一位）。显示器尺寸小于窗口时，退化为对齐工作区左上角，
 * 保证窗口至少有一部分可见。
 */
export function clampToDisplays<T>(
  bounds: WindowRect,
  displays: readonly T[],
  workAreaOf: (display: T) => WindowRect,
  primary?: T,
): { x: number; y: number } {
  if (displays.length === 0) return { x: Math.round(bounds.x), y: Math.round(bounds.y) }

  const areas = displays.map(workAreaOf)
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2

  let index = areas.findIndex((area) => inside(area, centerX, centerY))
  if (index < 0) {
    let bestArea = 0
    for (let i = 0; i < areas.length; i += 1) {
      const area = intersectionArea(bounds, areas[i])
      if (area > bestArea) {
        bestArea = area
        index = i
      }
    }
  }
  if (index < 0) {
    const primaryIndex = primary === undefined ? 0 : displays.indexOf(primary)
    index = primaryIndex >= 0 ? primaryIndex : 0
  }

  const work = areas[index]
  const maxX = work.x + work.width - bounds.width
  const maxY = work.y + work.height - bounds.height
  const x = Math.min(Math.max(bounds.x, work.x), Math.max(work.x, maxX))
  const y = Math.min(Math.max(bounds.y, work.y), Math.max(work.y, maxY))
  return { x: Math.round(x), y: Math.round(y) }
}
