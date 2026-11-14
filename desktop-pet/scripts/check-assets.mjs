#!/usr/bin/env node
// 构建前检查：assets/config.json 的每个 motions 名字都有对应的 assets/webm/<名字>.webm。
// 纯本地文件检查，不联网。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(
  readFileSync(path.join(root, 'assets', 'config.json'), 'utf8'),
)
const names = [...new Set(Object.values(config.animations?.motions ?? {}))]
const missing = names.filter(
  (name) => !existsSync(path.join(root, 'assets', 'webm', `${name}.webm`)),
)

if (missing.length > 0) {
  console.error(`assets missing: ${missing.length} files`)
  for (const name of missing) console.error(`  - ${name}.webm`)
  process.exit(1)
}

console.log(`assets ok: ${names.length} files`)
