import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUTES, matchRoute, segmentAllowed, methodEnabled, enabledMethods, upstreamPath,
} from '../fish/routes.mjs'

test('路由表本身没有重复路径，字段合法', () => {
  const seen = new Set()
  for (const route of ROUTES) {
    assert.equal(seen.has(route.path), false, `重复路径：${route.path}`)
    seen.add(route.path)
    assert.ok(['fish', 'bili'].includes(route.upstream), `${route.path} upstream`)
    const methods = Object.keys(route.methods ?? {})
    assert.ok(methods.length > 0, `${route.path} 没有方法`)
    for (const method of methods) {
      assert.ok(['P0', 'P1', 'P2'].includes(route.methods[method]), `${route.path} ${method} 阶段`)
    }
    if (route.maxBody !== undefined) assert.ok(route.maxBody > 0, `${route.path} maxBody`)
    if (route.timeoutMs !== undefined) assert.ok(route.timeoutMs > 0, `${route.path} timeout`)
  }
})

test('P0 只开放 status 的 GET', () => {
  const enabled = ROUTES.filter((r) => enabledMethods(r, ['P0']).length > 0)
  assert.deepEqual(enabled.map((r) => r.path), ['status'])
  const status = ROUTES.find((r) => r.path === 'status')
  assert.equal(methodEnabled(status, 'GET', ['P0']), true)
  assert.equal(methodEnabled(status, 'POST', ['P0']), false)
})

test('写方法要 P2 才开放，只读方法 P1 开放', () => {
  const config = ROUTES.find((r) => r.path === 'config')
  assert.equal(methodEnabled(config, 'GET', ['P1']), true)
  assert.equal(methodEnabled(config, 'POST', ['P1']), false)
  assert.equal(methodEnabled(config, 'POST', ['P1', 'P2']), true)

  const status = ROUTES.find((r) => r.path === 'status')
  assert.equal(methodEnabled(status, 'GET', ['P0', 'P1']), true)
})

test('静态路径与多段路径精确匹配，多余段返回 null', () => {
  assert.equal(matchRoute('status').route.path, 'status')
  assert.equal(matchRoute('status/extra'), null)
  assert.equal(matchRoute('log/export').route.path, 'log/export')
  assert.equal(matchRoute('log').route.path, 'log')
  assert.equal(matchRoute(''), null)
  assert.equal(matchRoute('nope'), null)
})

test('动态路径只接受一个合法段', () => {
  const ok = matchRoute('cover/BV1xx411c7mD')
  assert.equal(ok.route.path, 'cover')
  assert.equal(ok.suffix, '/BV1xx411c7mD')

  for (const bad of [
    'cover/BV1xx411c7mD/extra',
    'cover/..%2fsecret',
    'cover/BV1xx411c7mD%2f..',
    'cover/%2e%2e',
    'cover/BV1xx411c7mD\\x',
    'cover/short',
  ]) {
    assert.equal(matchRoute(bad), null, bad)
  }
  assert.equal(matchRoute('media/principle-a.svg').route.path, 'media')
  assert.equal(matchRoute('sheet/BV1xx411c7mD').route.upstream, 'bili')
})

test('segmentAllowed 拒绝编码与穿越', () => {
  const pattern = /^BV[0-9A-Za-z]{10}$/
  assert.equal(segmentAllowed('BV1xx411c7mD', pattern), true)
  assert.equal(segmentAllowed('BV1xx411c7m', pattern), false)
  assert.equal(segmentAllowed('BV1xx411c7mD%2f', pattern), false)
  assert.equal(segmentAllowed('..%2fBV1xx411c7mD', pattern), false)
  assert.equal(segmentAllowed('a/b', pattern), false)
  assert.equal(segmentAllowed('a\\b', pattern), false)
})

test('upstreamPath 按拆包前后前缀生成', () => {
  const status = ROUTES.find((r) => r.path === 'status')
  assert.equal(upstreamPath(status, '', ''), '/dsh-fish/status')
  const sheet = ROUTES.find((r) => r.path === 'sheet')
  assert.equal(upstreamPath(sheet, '/BV1xx411c7mD', '?x=1'), '/dsh-bili/sheet/BV1xx411c7mD?x=1')
})
