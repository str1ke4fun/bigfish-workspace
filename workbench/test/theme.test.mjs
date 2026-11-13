import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8')

test('日间与夜间都定义了完整 token', () => {
  const css = read('theme.css')
  assert.match(css, /:root\s*\{[\s\S]*--bg:\s*#f4efe6/)
  assert.match(css, /html\[data-theme="night"\]\s*\{[\s\S]*--bg:\s*#141413/)
  for (const token of ['--surface', '--ink', '--dim', '--accent', '--on-accent', '--teal', '--gold', '--danger']) {
    assert.match(css, new RegExp(`${token}:`))
  }
  assert.match(css, /--card:\s*var\(--surface\)/)
  assert.match(css, /--fg:\s*var\(--ink\)/)
})

test('主题脚本先读本地选择，再跟随系统，异常时回落日间', () => {
  const code = read('theme-boot.js')
  const run = (localStorage, matches) => {
    const document = { documentElement: { dataset: {} } }
    const window = { matchMedia: () => ({ matches }) }
    vm.runInNewContext(code, { document, window, localStorage })
    return document.documentElement.dataset.theme
  }
  assert.equal(run({ getItem: () => 'night' }, false), 'night')
  assert.equal(run({ getItem: () => null }, true), 'night')
  assert.equal(run({ getItem: () => { throw new Error('denied') } }, true), 'day')
})
