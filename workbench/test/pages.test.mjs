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

test('B站·今天不自动扫评论，只做两个快捷开关', () => {
  const s = src('bili-today.js')
  assert.equal(biliToday.id, 'bili-today')
  assert.equal(biliToday.slug, 'today')
  for (const call of ["fish('bili/status')", "fish('comment')", "fish('comment-body?",
    "fish('history?days=", "fish('outings')", "fish('risk')", "fish('owner')", "fish('config')",
    "postFish('wake?focus=browse'", "postFish('risk'"]) assert.ok(s.includes(call), call)
  assert.match(s, /comment\s*=\s*true/)
  assert.match(s, /comment:\s*false/)
  assert.match(s, /browse:\s*\{\s*enabled/)
  assert.match(s, /comment:\s*\{\s*enabled/)
  assert.doesNotMatch(s, /browse\.perDay|comment\.perDay|persona|innerHTML/)
})

test('B站·足迹只读，视频与评论分段', () => {
  const s = src('bili-footprint.js')
  assert.equal(biliFootprint.id, 'bili-footprint')
  assert.equal(biliFootprint.slug, 'footprint')
  for (const call of ["fish('history?days=", "fish('footprint?days=", "fish('comment-body?",
    "fish('bili/status')"]) assert.ok(s.includes(call), call)
  // 封面 / 抽帧是图片响应，走 /api/fish/cover|sheet/<bvid>，不是 JSON 助手。
  assert.match(s, /\/api\/fish\/cover\//)
  assert.match(s, /\/api\/fish\/sheet\//)
  assert.match(s, /视频足迹[\s\S]*评论足迹/)
  assert.doesNotMatch(s, /postFish|local\(|innerHTML/)
})

test('B站·管理收拢 B 站配置，不回显 cookie', () => {
  const s = src('bili-manage.js')
  assert.equal(biliManage.id, 'bili-manage')
  assert.equal(biliManage.slug, 'manage')
  for (const k of ['browse.perDay', 'browse.topN', 'browse.deepRead', 'browse.danmaku',
    'browse.keywords', 'browse.window', 'browse.voices', 'video.perDay', 'video.frames',
    'comment.perDay', 'comment.replyPerDay', 'comment.scanEveryMin', 'comment.atOwner',
    'avoid.keywords', 'avoid.upMids', 'avoid.minDuration', "fish('bili/status')"]) assert.ok(s.includes(k), k)
  assert.doesNotMatch(s, /growthDays|notify\.enabled|memory\.docBudget|persona|lastShown|lastScanAt/)
  assert.match(s, /type:\s*'password'/)
  assert.match(s, /if\s*\(cookie\)/)
  assert.match(s, /postFish\('owner'/)
  assert.match(s, /postFish\('risk'/)
  assert.doesNotMatch(s, /innerHTML/)
})

test('配置表单对缺失 / 错误类型是 Null-safe 的', () => {
  const s = readFileSync(new URL('../assets/config-form.js', import.meta.url), 'utf8')
  assert.match(s, /Array\.isArray/)
  assert.match(s, /typeof\s+value\s*===\s*'boolean'/)
  assert.match(s, /parseList/)
  assert.doesNotMatch(s, /innerHTML/)
})

test('系统·设置只留成长 / 通知 / 对话 / 记忆', () => {
  const s = src('system-settings.js')
  assert.equal(systemSettings.id, 'system-settings')
  assert.equal(systemSettings.slug, 'settings')
  for (const k of ['growthDays', 'wakesPerDay', 'daily', 'diary', 'absenceAfterDays',
    'notify.enabled', 'chat.rotateAfter', 'chat.replyChars',
    'memory.docBudget', 'memory.beliefsShown', 'memory.sleepEveryDays']) assert.ok(s.includes(k), k)
  assert.doesNotMatch(s, /browse\.|video\.|comment\.|avoid\.|owner\.|tools\.restrict|observe\.|persona/)
  assert.match(s, /配置搬家/)
})
test('工具白名单只在系统·工具与规则', () => {
  const s = src('system-tools.js')
  assert.equal(systemTools.id, 'system-tools')
  assert.equal(systemTools.slug, 'tools')
  for (const k of ['tools.restrict', 'tools.allow', "fish('tools')", "fish('rules')", "fish('selfcheck?net=1')"]) {
    assert.ok(s.includes(k), k)
  }
  assert.match(s, /重启 DSH 后生效/)
  assert.doesNotMatch(s, /persona|innerHTML/)
})
