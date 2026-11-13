import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_HASH, DEFAULT_ROUTE, normalizeRoute, routeHash, splitRoute } from '../assets/router.js'

test('旧 hash 映射到新路由', () => {
  assert.deepEqual(LEGACY_HASH, {
    overview: 'her/today',
    memory: 'her/memory',
    bili: 'bili/today',
    env: 'system/settings',
    channels: 'channels/overview',
    tools: 'system/tools',
    data: 'system/data',
    principles: 'system/principles',
  })
  assert.equal(normalizeRoute('#overview'), 'her/today')
  assert.equal(normalizeRoute('#bili'), 'bili/today')
  assert.equal(normalizeRoute('#channels'), 'channels/overview')
  assert.equal(normalizeRoute('#env'), 'system/settings')
  assert.equal(normalizeRoute('#memory'), 'her/memory')
  assert.equal(normalizeRoute('#tools'), 'system/tools')
  assert.equal(normalizeRoute('#data'), 'system/data')
  assert.equal(normalizeRoute('#principles'), 'system/principles')
})

test('未知 hash 回落默认路由', () => {
  assert.equal(DEFAULT_ROUTE, 'her/today')
  assert.equal(normalizeRoute('#nope'), 'her/today')
  assert.equal(normalizeRoute(''), 'her/today')
  assert.equal(normalizeRoute('#her/'), 'her/today')
  assert.equal(normalizeRoute('#Her/Today'), 'her/today')
  assert.equal(normalizeRoute('#her/today/extra'), 'her/today')
})

test('routeHash 与 splitRoute 往返一致', () => {
  assert.equal(routeHash('bili', 'footprint'), '#bili/footprint')
  assert.deepEqual(splitRoute('channels/qq'), { nav: 'channels', slug: 'qq' })
  assert.deepEqual(splitRoute(normalizeRoute('#system/settings')), { nav: 'system', slug: 'settings' })
})
