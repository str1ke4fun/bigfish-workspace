import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { herToday } from '../assets/pages/her-today.js'
import { herMemory } from '../assets/pages/her-memory.js'
import { herGrowth } from '../assets/pages/her-growth.js'
import { biliToday } from '../assets/pages/bili-today.js'
import { biliFootprint } from '../assets/pages/bili-footprint.js'
import { biliManage } from '../assets/pages/bili-manage.js'
import { systemSettings } from '../assets/pages/system-settings.js'
import { systemTools } from '../assets/pages/system-tools.js'
import { systemLogs } from '../assets/pages/system-logs.js'
import { systemData } from '../assets/pages/system-data.js'
import { systemPrinciples } from '../assets/pages/system-principles.js'
const src = (name) => readFileSync(new URL(`../assets/pages/${name}`, import.meta.url), 'utf8')

test('她·今天契约与数据源', () => {
  assert.equal(herToday.id, 'her-today')
  assert.equal(herToday.nav, 'her')
  assert.equal(herToday.slug, 'today')
  const s = src('her-today.js')
  for (const call of ["fish('status')", "fish('state')", "fish('bili/status')", "fish('tools')",
    "fish('events?limit=40')", "fish('beliefs')", "fish('home')", "fish('away')",
    "local('/api/status.log')", "fish('rules')"]) assert.match(s, new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(s, /inbox\s*\?\s*fish\('inbox'\)/)
  assert.match(s, /refresh\(\{\s*inbox:\s*false\s*\}\)/)
  assert.match(s, /postFish\('wake'/)
  assert.match(s, /postFish\('say'/)
  assert.match(s, /postFish\('decide'/)
  assert.doesNotMatch(s, /persona/)
  assert.doesNotMatch(s, /innerHTML/)
})

test('她·记忆只读且分五段', () => {
  const s = src('her-memory.js')
  assert.equal(herMemory.id, 'her-memory')
  assert.equal(herMemory.slug, 'memory')
  for (const call of ["fish('events?'", "fish('diary')", "fish('reports')", "fish('beliefs')", "fish('templates')"]) {
    assert.ok(s.includes(call), call)
  }
  assert.match(s, /事件[\s\S]*日记[\s\S]*日报[\s\S]*判断[\s\S]*模板/)
  assert.doesNotMatch(s, /postFish|local\(|innerHTML/)
})

test('她·成长只读，没有调人格滑杆', () => {
  const s = src('her-growth.js')
  assert.equal(herGrowth.id, 'her-growth')
  assert.equal(herGrowth.slug, 'growth')
  for (const k of ['pendingGate', 'stageForced', 'beliefCount', 'tension', 'solidCount', 'scarCount', 'stanceReady']) {
    assert.ok(s.includes(k), k)
  }
  assert.doesNotMatch(s, /postFish|local\(|innerHTML|type:\s*'range'/)
  assert.match(s, /这里没有数值滑杆/)
})
