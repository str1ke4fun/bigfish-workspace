import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clampPetSize, PET_SIZE_DEFAULT } from './size'

let cached: number | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** 读不到/损坏都回默认值，不阻塞启动。 */
export function readPetSize(): number {
  if (cached !== null) return cached
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    cached = clampPetSize(record.size)
  } catch {
    cached = PET_SIZE_DEFAULT
  }
  return cached
}

export function savePetSize(size: number): number {
  const next = clampPetSize(size)
  cached = next
  try {
    writeFileSync(settingsFile(), JSON.stringify({ size: next }), 'utf8')
  } catch (error) {
    console.warn('[desktop-pet] 保存尺寸失败', error)
  }
  return next
}
