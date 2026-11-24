#!/usr/bin/env node
// 从上游 dsh-pet v0.4.9 同步其余动作素材到 assets/webm/。
// 默认用 git 稀疏克隆只取 dsh-pet/assets/webm，缓存放在系统临时目录，不删除任何目录。
// 已存在的本地文件默认保留（--force 覆盖），方便替换成自定义动画。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const UPSTREAM_REPO = 'https://github.com/PC2005-cloud/dsh-pet.git'
export const UPSTREAM_TAG = 'v0.4.9'
export const UPSTREAM_ASSETS_SUBPATH = 'dsh-pet/assets/webm'
export const CACHE_DIR = path.join(
  os.tmpdir(),
  'bigfish-pet-assets',
  `dsh-pet-${UPSTREAM_TAG}`,
)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv) {
  const options = { from: null, force: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--from') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--from 需要一个素材目录')
      }
      options.from = value
      index += 1
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return options
}

function usage() {
  return [
    '用法: node scripts/fetch-assets.mjs [--from <dsh-pet assets/webm 目录>] [--force]',
    '',
    '不带 --from 时，用 git 稀疏克隆上游 dsh-pet v0.4.9 到系统临时目录，再同步素材。',
    '默认保留 assets/webm/ 里已存在的文件；--force 会用上游文件覆盖。',
  ].join('\n')
}

function runChecked(command, args, cwd, stdio) {
  const result = spawnSync(command, args, { cwd, stdio })
  if (result.error) {
    throw new Error(`无法执行 ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败（退出码 ${result.status}）`)
  }
  return result
}

function run(command, args, cwd) {
  runChecked(command, args, cwd, 'inherit')
}

function isDirectory(target) {
  return existsSync(target) && statSync(target).isDirectory()
}

function webmCount(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.webm')).length
  } catch {
    return 0
  }
}

function ensureUpstream(cacheDir) {
  const assetsDir = path.join(cacheDir, UPSTREAM_ASSETS_SUBPATH)
  if (isDirectory(cacheDir) && !existsSync(path.join(cacheDir, '.git'))) {
    throw new Error(
      `缓存目录已存在但不是 git 仓库：${cacheDir}\n` +
        '请手动删除该目录后重试（脚本不会自动删除任何目录）。',
    )
  }

  if (!existsSync(path.join(cacheDir, '.git'))) {
    run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      UPSTREAM_TAG,
      '--filter=blob:none',
      '--sparse',
      UPSTREAM_REPO,
      cacheDir,
    ])
  } else {
    runChecked(
      'git',
      ['-C', cacheDir, 'rev-parse', '--verify', '--quiet', `refs/tags/${UPSTREAM_TAG}^{commit}`],
      root,
      'pipe',
    )
  }

  // 缓存可能已被清掉部分素材；重新声明稀疏路径会把缺的 blob 拉回来。
  run('git', ['-C', cacheDir, 'sparse-checkout', 'set', UPSTREAM_ASSETS_SUBPATH], root)

  if (!isDirectory(assetsDir) || webmCount(assetsDir) === 0) {
    throw new Error(
      `上游素材目录不可用：${assetsDir}\n` +
        '请手动删除缓存目录后重试（脚本不会自动删除任何目录）。',
    )
  }
  return assetsDir
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }

  const sourceDir = options.from
    ? path.resolve(options.from)
    : ensureUpstream(CACHE_DIR)

  if (!isDirectory(sourceDir)) {
    throw new Error(`素材目录不存在: ${sourceDir}`)
  }

  console.log(
    `素材来源：${options.from ? sourceDir : `${UPSTREAM_REPO} @ ${UPSTREAM_TAG} (${UPSTREAM_ASSETS_SUBPATH})`}`,
  )
  console.log('许可：CC BY-NC-SA 4.0；署名见 desktop-pet/assets/ATTRIBUTION.md')
  if (!options.from) console.log(`上游缓存：${CACHE_DIR}（脚本不会自动删除）`)

  const syncArgs = ['scripts/sync-assets.mjs', '--from', sourceDir]
  if (!options.force) syncArgs.push('--skip-existing')
  run(process.execPath, syncArgs, root)
  run(process.execPath, ['scripts/check-assets.mjs'], root)
  return 0
}

const invokedPath = process.argv[1]
const isMain =
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url

if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
