import test from 'node:test'
import assert from 'node:assert/strict'
import { NAV, PAGES, resolveRoute, shellBadge } from '../assets/nav.js'

test('四页导航与二级页签数量', () => {
  assert.deepEqual(NAV.map((n) => n.id), ['her', 'bili', 'channels', 'system'])
  assert.deepEqual(NAV.map((n) => n.label), ['她', 'B 站', '通道', '系统'])
  assert.equal(NAV[0].pages.length, 4)
  assert.equal(NAV[1].pages.length, 3)
  assert.equal(NAV[2].pages.length, 3)
  assert.equal(NAV[3].pages.length, 5)
  assert.deepEqual(NAV[0].pages.map((p) => p.slug), ['today', 'memory', 'growth', 'presence'])
  assert.deepEqual(NAV[1].pages.map((p) => p.slug), ['today', 'footprint', 'manage'])
  assert.deepEqual(NAV[2].pages.map((p) => p.slug), ['overview', 'qq', 'wx'])
  assert.deepEqual(NAV[3].pages.map((p) => p.slug), ['settings', 'tools', 'logs', 'data', 'principles'])
})

test('每个页面模块都满足 page 契约，id 唯一', () => {
  assert.equal(new Set(PAGES.map((p) => p.id)).size, PAGES.length)
  for (const p of PAGES) {
    assert.equal(typeof p.id, 'string')
    assert.equal(typeof p.nav, 'string')
    assert.equal(typeof p.slug, 'string')
    assert.equal(typeof p.label, 'string')
    assert.equal(typeof p.order, 'number')
    assert.equal(typeof p.enter, 'function')
    assert.equal(typeof p.leave, 'function')
    assert.ok(NAV.some((n) => n.id === p.nav), `${p.id} 的 nav`)
  }
})

test('P0 共享挂载点让旧页面模块只建一次 DOM', () => {
  const host = (slug) => NAV.find((n) => n.id === 'her').pages.find((p) => p.slug === slug).host
  // 她组三页都已迁成独立页面（P1），不再借旧 overview 的共享根。
  assert.equal(host('today'), undefined)
  assert.equal(host('growth'), undefined)
  // B 站三页都已迁成独立页面（P1），不再借旧 bili 的共享根。
  const bili = NAV.find((n) => n.id === 'bili').pages
  assert.equal(bili.find((p) => p.slug === 'today').host, undefined)
  assert.equal(bili.find((p) => p.slug === 'footprint').host, undefined)
  assert.equal(bili.find((p) => p.slug === 'manage').host, undefined)
  // 通道三页都由注册表生成，各自建自己的根。
  for (const p of NAV.find((n) => n.id === 'channels').pages) assert.equal(p.host, undefined)
  // 系统组也全部迁成独立页面（P1），日志与数据不再借旧 data 的共享根。
  const sys = NAV.find((n) => n.id === 'system').pages
  assert.equal(sys.find((p) => p.slug === 'logs').host, undefined)
  assert.equal(sys.find((p) => p.slug === 'data').host, undefined)
})

test('路由解析旧地址与未知地址', () => {
  assert.equal(resolveRoute('#overview').page.id, 'her-today')
  assert.equal(resolveRoute('#memory').page.id, 'her-memory')
  assert.equal(resolveRoute('#bili').page.id, 'bili-today')
  assert.equal(resolveRoute('#env').page.id, 'system-settings')
  assert.equal(resolveRoute('#channels').page.id, 'channels-overview')
  assert.equal(resolveRoute('#tools').page.id, 'system-tools')
  assert.equal(resolveRoute('#data').page.id, 'system-data')
  assert.equal(resolveRoute('#principles').page.id, 'system-principles')
  assert.equal(resolveRoute('#channels/qq').page.id, 'channels-qq')
  assert.equal(resolveRoute('#nope').page.id, 'her-today')
  assert.equal(resolveRoute('#her/nope').page.id, 'her-today')
  assert.deepEqual(resolveRoute('#bili/footprint').nav, 'bili')
})

test('侧栏状态点：她、通道、B 站、系统', () => {
  assert.equal(shellBadge('her', { her: { running: false } }), 'bad')
  assert.equal(shellBadge('her', { her: { running: true, http: '200' } }), 'ok')
  assert.equal(shellBadge('her', { her: { running: true, http: 500 } }), 'bad')
  assert.equal(shellBadge('channels', {
    channels: { qq: { running: true, loggedIn: true }, wx: { running: false } },
  }), 'bad')
  assert.equal(shellBadge('channels', {
    channels: { qq: { running: true, loggedIn: false }, wx: { running: true, loggedIn: true } },
  }), 'warn')
  assert.equal(shellBadge('channels', {
    channels: { qq: { running: true, loggedIn: true }, wx: { running: true, loggedIn: true, health: { tree: { status: 'bad' } } } },
  }), 'warn')
  assert.equal(shellBadge('channels', {
    channels: { qq: { running: true, loggedIn: true }, wx: { running: true, loggedIn: true, health: { tree: { status: 'ok' } } } },
  }), 'ok')
  assert.equal(shellBadge('channels', null), null)
  assert.equal(shellBadge('bili', {}, { bili: 'warn' }), 'warn')
  assert.equal(shellBadge('bili', {}), null)
  assert.equal(shellBadge('system', {}), null)
})
