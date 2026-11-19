// 无障碍树桥接是运行时文件：以前放在 ~/cu-test，修好的长消息截断不跟 Git 走。
// 这里把它钉在仓库里：tree 命令必须跑 lib/wx-elements.mjs，正文不能再截 80 字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')

test('wx.sh tree 使用仓库里的桥接脚本，不再 cd 到 ~/cu-test', () => {
  const sh = read('wx.sh')
  const block = sh.match(/^\s*tree\)\n([\s\S]*?)^\s*;;/m)?.[1] ?? ''
  assert.match(block, /node "\$LIB_DIR\/wx-elements\.mjs"/)
  assert.doesNotMatch(block, /cd \/home\/str1k3\/cu-test/)
})

test('桥接脚本保留长消息正文，不再截在 80 字', () => {
  const bridge = read('wx-elements.mjs')
  assert.match(bridge, /消息 "\$\{q\(label\(e\)\)\.slice\(0, 4000\)\}"/)
  assert.doesNotMatch(bridge, /消息 "\$\{q\(label\(e\)\)\.slice\(0, 80\)\}"/)
})
