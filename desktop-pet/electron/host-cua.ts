/**
 * host-cua.ts —— 桌宠只负责把附带的 cua-driver 复制到稳定目录，并上报路径。
 *
 * 不启动驱动、不执行任何驱动命令；遥测关闭由 dsh-fish 第一次解析驱动后做。
 * 复制先写临时目录再 rename，幂等；失败只返回明确 code，不让窗口起不来。
 */
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

export const HOST_CUA_VERSION = '0.55.0'

export interface HostCuaInfo {
  version: string
  exe: string
}

export interface InstallResult {
  ok: boolean
  code?: string
  version?: string
  exe?: string
  reused?: boolean
}

export function resolveInstallTarget({ localAppData, version = HOST_CUA_VERSION }: {
  localAppData: string
  version?: string
}): string {
  return path.join(localAppData, 'bigfish', 'host-cua', version)
}

export async function installBundledHostCua({
  bundledDir,
  localAppData,
  version = HOST_CUA_VERSION,
  exists = existsSync,
  readManifest = async (file: string) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
  },
  copyDir = async (from: string, to: string) => { await fs.cp(from, to, { recursive: true }) },
  renameDir = async (from: string, to: string) => { await fs.rename(from, to) },
  mkdir = async (dir: string) => { await fs.mkdir(dir, { recursive: true }) },
  rmDir = async (dir: string) => { await fs.rm(dir, { recursive: true, force: true }) },
}: {
  bundledDir: string
  localAppData: string
  version?: string
  exists?: (file: string) => boolean
  readManifest?: (file: string) => Promise<Record<string, unknown> | null>
  copyDir?: (from: string, to: string) => Promise<void>
  renameDir?: (from: string, to: string) => Promise<void>
  mkdir?: (dir: string) => Promise<void>
  rmDir?: (dir: string) => Promise<void>
}): Promise<InstallResult> {
  if (!localAppData) return { ok: false, code: 'no-local-app-data' }
  const bundledExe = path.join(bundledDir, 'cua-driver.exe')
  if (!exists(bundledExe)) return { ok: false, code: 'bundled-missing' }
  const manifest = await readManifest(path.join(bundledDir, 'manifest.json'))
  if (!manifest || typeof manifest !== 'object') return { ok: false, code: 'manifest-missing' }

  const target = resolveInstallTarget({ localAppData, version })
  const targetExe = path.join(target, 'cua-driver.exe')
  if (exists(targetExe)) return { ok: true, version, exe: targetExe, reused: true }

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    await rmDir(tmp)
    await mkdir(path.dirname(target))
    await copyDir(bundledDir, tmp)
    await renameDir(tmp, target)
  } catch (err) {
    await rmDir(tmp).catch(() => {})
    return { ok: false, code: 'copy-failed' }
  }
  return { ok: true, version, exe: targetExe, reused: false }
}
