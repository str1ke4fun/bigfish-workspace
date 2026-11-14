#!/usr/bin/env node
// 只把 assets/config.json 引用的动画从本地 dsh-pet 素材目录复制到 assets/webm/。
// assets/webm/ 不进 Git，构建前用它同步素材。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'assets', 'config.json')
const outDir = path.join(root, 'assets', 'webm')

function referencedAnimations(config) {
  const animations = config.animations ?? {}
  const names = []
  const add = (name) => {
    if (typeof name === 'string' && !names.includes(name)) names.push(name)
  }

  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    for (const name of animations[key] ?? []) add(name)
  }
  for (const action of animations.moves?.actions ?? []) add(action.name)
  for (const name of Object.values(animations.motions ?? {})) add(name)

  return names
}

const fromIndex = process.argv.indexOf('--from')
const from = fromIndex === -1 ? undefined : process.argv[fromIndex + 1]
if (!from) {
  console.error('用法: node scripts/sync-assets.mjs --from <dsh-pet assets/webm 目录>')
  process.exit(1)
}

const fromDir = path.resolve(from)
if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) {
  console.error(`素材目录不存在: ${fromDir}`)
  process.exit(1)
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const names = referencedAnimations(config)
const missing = names.filter(
  (name) => !existsSync(path.join(fromDir, `${name}.webm`)),
)

if (missing.length > 0) {
  console.error(`缺少 ${missing.length} 个动画文件:`)
  for (const name of missing) console.error(`  - ${name}.webm`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
for (const name of names) {
  copyFileSync(path.join(fromDir, `${name}.webm`), path.join(outDir, `${name}.webm`))
}

console.log(`synced ${names.length} files -> assets/webm`)
