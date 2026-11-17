#!/usr/bin/env node
// 只把 assets/config.json 与 assets/actions.json 引用的动画复制到 assets/webm/。
// assets/webm/ 不进 Git，构建前用 --from 指向本地 dsh-pet 素材目录。
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
const outDir = path.join(root, 'assets', 'webm')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`${label} 读取或解析失败: ${file}\n  ${detail}`)
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeName(name) {
  if (name === '' || name === '.' || name === '..') return false
  return !/[\\/:*?"<>|\u0000-\u001f]/.test(name)
}

function referencedAnimations(config, registry) {
  const names = []
  const seen = new Set()

  function add(name, source) {
    if (typeof name !== 'string' || name.trim() === '') {
      fail(`${source} 包含空动画名。`)
    }
    const normalized = name.trim()
    if (!isSafeName(normalized)) fail(`${source} 包含不安全动画名: ${normalized}`)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      names.push(normalized)
    }
  }

  const animations = isRecord(config) && isRecord(config.animations) ? config.animations : {}
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    for (const name of Array.isArray(animations[key]) ? animations[key] : []) {
      add(name, `config.json animations.${key}`)
    }
  }
  const moves = isRecord(animations.moves) ? animations.moves : {}
  for (const action of Array.isArray(moves.actions) ? moves.actions : []) {
    if (!isRecord(action)) fail('config.json animations.moves.actions 包含非对象条目。')
    add(action.name, 'config.json animations.moves.actions')
  }
  const motions = isRecord(animations.motions) ? animations.motions : {}
  for (const name of Object.values(motions)) add(name, 'config.json animations.motions')

  if (!isRecord(registry) || !Array.isArray(registry.actions)) {
    fail('actions.json 必须是包含 actions 数组的对象。')
  }
  registry.actions.forEach((action, index) => {
    if (!isRecord(action)) fail(`actions.json 第 ${index + 1} 条不是对象。`)
    const source = `actions.json ${typeof action.id === 'string' ? action.id : `#${index + 1}`}`
    const hasAnim = Object.hasOwn(action, 'anim')
    const hasSeq = Object.hasOwn(action, 'seq')
    if (hasAnim === hasSeq) fail(`${source} 的 anim 与 seq 必须严格二选一。`)

    if (hasAnim) {
      add(action.anim, `${source} anim`)
      return
    }
    if (!Array.isArray(action.seq) || action.seq.length === 0) {
      fail(`${source} 的 seq 必须是非空数组。`)
    }
    action.seq.forEach((name, part) => add(name, `${source} seq[${part}]`))
  })

  return names
}

const fromIndex = process.argv.indexOf('--from')
const from = fromIndex === -1 ? undefined : process.argv[fromIndex + 1]
if (!from) {
  fail('用法: node scripts/sync-assets.mjs --from <dsh-pet assets/webm 目录>')
}

const fromDir = path.resolve(from)
if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) {
  fail(`素材目录不存在: ${fromDir}`)
}

const config = readJson(path.join(root, 'assets', 'config.json'), 'config.json')
const registry = readJson(path.join(root, 'assets', 'actions.json'), 'actions.json')
const names = referencedAnimations(config, registry)
const missing = names.filter((name) => !existsSync(path.join(fromDir, `${name}.webm`)))

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
