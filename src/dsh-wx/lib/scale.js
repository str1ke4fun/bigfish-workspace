/**
 * AT-SPI 报的是逻辑像素，xdotool 要的是屏幕像素。两者差一个缩放：
 *   屏幕坐标 = 树坐标 × (Xvfb 的 dpi / 96)
 * 这台 Xvfb 是 100 dpi，系数 1.0417：x=1350 处偏 56px，28px 的按钮全点空。
 * （侧栏整行 240 宽，偏 28px 仍然点得中，所以这个偏差一直没被发现。）
 *
 * WX_SCALE 环境变量可以强行指定，用于核对或换了显示配置之后。
 */
import { execFileSync } from 'node:child_process'

export function screenScale(env = process.env) {
  const forced = Number(env.WX_SCALE)
  if (Number.isFinite(forced) && forced > 0.5 && forced < 4) return forced
  try {
    const out = execFileSync('xdpyinfo', [], { env, encoding: 'utf8', timeout: 5000 })
    const m = out.match(/resolution:\s*(\d+)x(\d+)/)
    if (m) return Number(m[1]) / 96
  } catch { /* 取不到就当 1 */ }
  return 1
}
