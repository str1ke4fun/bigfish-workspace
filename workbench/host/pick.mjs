/**
 * pick.mjs —— Linux/WSL 上的 host。
 *
 * Windows 桌面工作台已退役：不再经 wsl.exe 转发，也不再有第二个 8788。
 * 工作台只在本机 Linux（含 WSL）直跑。
 */
import { linuxHost } from './linux.mjs'

export function createHost(o = {}) {
  return linuxHost(o)
}
