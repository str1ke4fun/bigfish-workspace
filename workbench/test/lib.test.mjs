import test from 'node:test'
import assert from 'node:assert/strict'
import { parseList, asText, statusDot, humanChip, segment, emptyState, openHer } from '../assets/lib.js'

// 极简 DOM 垫片：这些辅助函数只建节点、设属性，不依赖浏览器布局。
class FakeNode {
  constructor(tag = '#text') {
    this.tagName = tag
    this.children = []
    this.attributes = {}
    this.dataset = {}
    this.style = {}
    this.className = ''
    this.textContent = ''
  }
  append(...kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid instanceof FakeNode) this.children.push(kid)
    }
  }
  setAttribute(key, value) {
    this.attributes[key] = value
    if (key === 'class') this.className = value
  }
  addEventListener() {}
}
globalThis.Node = FakeNode
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode('#text')
    node.textContent = String(text)
    return node
  },
}
const text = (node) => node.textContent + node.children.map(text).join('')

test('parseList 不把空输入变成 NaN', () => {
  assert.deepEqual(parseList('', [1, 2]), [])
  assert.deepEqual(parseList('1, 2', []), [1, 2])
  assert.deepEqual(parseList('a，b', null), ['a', 'b'])
  assert.deepEqual(parseList(null, []), [])
})

test('asText 不产生 [object Object]', () => {
  assert.equal(asText(null), '')
  assert.equal(asText({ a: 1 }), '{\n  "a": 1\n}')
})

test('statusDot 带状态类与可见文字', () => {
  const dot = statusDot('warn', '注意')
  assert.equal(dot.className, 'dot warn')
  const label = dot.children.find((n) => n.className === 'status-text')
  assert.equal(label?.textContent, '注意')
  assert.equal(statusDot('', '').className, 'dot')
})

test('humanChip 是可见的法律标记', () => {
  const chip = humanChip()
  assert.equal(chip.className, 'chip human')
  assert.equal(chip.textContent, '人工')
})

test('segment 切换选中态与 aria-selected', () => {
  let picked = ''
  const seg = segment([{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }], { value: 'a', onChange: (id) => { picked = id } })
  assert.equal(seg.root.attributes.role, 'tablist')
  const [a, b] = seg.root.children
  assert.equal(a.attributes.role, 'tab')
  assert.equal(a.attributes['aria-selected'], 'true')
  assert.equal(b.attributes['aria-selected'], 'false')
  seg.set('b')
  assert.equal(a.className, 'tab')
  assert.equal(b.className, 'tab on')
  assert.equal(a.attributes['aria-selected'], 'false')
  assert.equal(b.attributes['aria-selected'], 'true')
  assert.equal(picked, '')
})

test('emptyState 用一句话说明空态', () => {
  const node = emptyState('还没有事件')
  assert.equal(node.className, 'empty-state')
  assert.match(text(node), /还没有事件/)
})

test('openHer 成功时打开新窗口并回报地址', async () => {
  const opened = []
  const prevFetch = globalThis.fetch
  const prevOpen = globalThis.window
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ url: 'http://127.0.0.1:8710/?token=x' }),
  })
  globalThis.window = { open: (url, target) => opened.push([url, target]) }
  try {
    const r = await openHer()
    assert.deepEqual(r, { ok: true, url: 'http://127.0.0.1:8710/?token=x' })
    assert.deepEqual(opened, [['http://127.0.0.1:8710/?token=x', '_blank']])
  } finally {
    globalThis.fetch = prevFetch
    globalThis.window = prevOpen
  }
})

test('openHer 失败时把原因交回页面', async () => {
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => 'application/json' }, json: async () => ({ error: '宿主没起' }) })
  try {
    const r = await openHer()
    assert.equal(r.ok, false)
    assert.match(r.error, /宿主没起/)
  } finally {
    globalThis.fetch = prevFetch
  }
})
