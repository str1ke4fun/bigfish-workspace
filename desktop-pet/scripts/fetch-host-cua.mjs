#!/usr/bin/env node
// 拉取固定版本的 cua-driver Windows 文件到 desktop-pet/host-cua/。
// 不把 80MB 二进制提交进 Git；构建/首次打包前跑一次。
//
// 来源：dsh-cua-driver@0.1.2 的 vendor（cua-driver 0.55.0 Windows x64）。
// 文件按 SHA256 校验；已存在且 manifest 一致时跳过。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOST_CUA_VERSION = '0.55.0'
export const HOST_CUA_TARBALL = 'https://registry.npmjs.org/dsh-cua-driver/-/dsh-cua-driver-0.1.2.tgz'
export const HOST_CUA_SHA256 = '0a3a46c6e84006444c34122a5600d1f53c240087f94589d3beb26b776c7b20d3'
export const VENDOR_DIR = 'package/vendor/cua-driver-rs-0.55.0-windows-x86_64'
export const HOST_FILES = [
  'cua-driver.exe',
  'cua-driver-uia.exe',
  'cua-cursor-theme.exe',
  'cua_driver_sdk.dll',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'host-cua')
const manifestPath = path.join(targetDir, 'manifest.json')

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function readManifest() {
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { return null }
}

function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（${r.status}）`)
}

async function main() {
  const force = process.argv.includes('--force')
  const existing = readManifest()
  if (!force && existing?.version === HOST_CUA_VERSION && existing?.sha256 === HOST_CUA_SHA256) {
    const have = HOST_FILES.every((name) => existsSync(path.join(targetDir, name)))
    if (have) {
      console.log(`cua-driver ${HOST_CUA_VERSION} 已存在，跳过。`)
      return
    }
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bigfish-host-cua-'))
  try {
    const tgz = path.join(tmp, 'dsh-cua-driver.tgz')
    console.log(`下载 ${HOST_CUA_TARBALL}`)
    const res = await fetch(HOST_CUA_TARBALL, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const got = sha256(buf)
    if (got !== HOST_CUA_SHA256) throw new Error(`SHA256 不匹配：${got}`)
    await fs.writeFile(tgz, buf)

    const extract = path.join(tmp, 'extract')
    await fs.mkdir(extract, { recursive: true })
    run('tar', ['-xzf', tgz, '-C', extract, VENDOR_DIR])

    const vendor = path.join(extract, ...VENDOR_DIR.split('/'))
    await fs.rm(targetDir, { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    for (const name of HOST_FILES) {
      const src = path.join(vendor, name)
      if (!existsSync(src)) throw new Error(`压缩包里缺 ${name}`)
      await fs.copyFile(src, path.join(targetDir, name))
    }
    await fs.writeFile(manifestPath, JSON.stringify({
      version: HOST_CUA_VERSION,
      source: HOST_CUA_TARBALL,
      sha256: HOST_CUA_SHA256,
      files: HOST_FILES,
      at: new Date().toISOString(),
    }, null, 2))
    console.log(`已写入 ${targetDir}`)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exit(1)
})
