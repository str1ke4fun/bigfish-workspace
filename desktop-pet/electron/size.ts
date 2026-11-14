/**
 * 宠物尺寸的纯计算：不 import Electron，测试可以直接跑。
 * `settings.ts` 负责读写，`window.ts` / `main.ts` 负责用这里的结果。
 */

export const PET_SIZE_MIN = 240
export const PET_SIZE_MAX = 560
export const PET_SIZE_DEFAULT = 400

/** 非法值回默认；越界夹到区间内。 */
export function clampPetSize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return PET_SIZE_DEFAULT
  return Math.round(Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, numeric)))
}

/** 宠物身体宽度 → 窗口尺寸；左右各留 19px，顶部给气泡留 80px。 */
export function windowSizeFor(size: number): { width: number; height: number } {
  const body = Math.max(1, size)
  return {
    width: Math.round(body + 38),
    height: Math.round((body * 9) / 16) + 80,
  }
}
