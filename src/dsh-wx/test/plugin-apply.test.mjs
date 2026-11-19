// 插件 apply() 冒烟测试：真正的宿主是从这里激活插件的。
// 纯函数测试再多，也挡不住 apply() 内部的初始化顺序错误（2026-11-18 的
// `readMentions` TDZ 就是这样把 18 个微信工具一起卸掉的）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

const EXPECTED_TOOLS = [
  'wx_click',
  'wx_context',
  'wx_history',
  'wx_key',
  'wx_ocr',
  'wx_peek',
  'wx_see',
  'wx_send',
  'wx_sticker_collect',
  'wx_sticker_find',
  'wx_sticker_list',
  'wx_sticker_scan',
  'wx_sticker_search',
  'wx_sticker_send',
  'wx_sticker_tag',
  'wx_task_done',
  'wx_task_snooze',
  'wx_type',
]

function fakeCtx(registered) {
  return {
    get: () => undefined,
    on: () => () => {},
    tools: {
      register: (def) => {
        registered.push(def.name)
        return () => {}
      },
    },
  }
}

test('apply() 能挂上全部微信工具，不会在注册前因初始化顺序崩溃', () => {
  const registered = []
  let dispose
  assert.doesNotThrow(() => {
    dispose = apply(fakeCtx(registered), { pollSeconds: 3600 })
  })
  try {
    assert.deepEqual([...new Set(registered)].sort(), EXPECTED_TOOLS)
    assert.equal(registered.length, EXPECTED_TOOLS.length, '同一个工具不能重复注册')
  } finally {
    dispose?.()
  }
})
