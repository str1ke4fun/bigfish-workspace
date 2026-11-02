// 主机的「说话」只认人手打的消息；宿主注入的快照不算。
// 2026-11-02 22:26：重启后的第一轮带 runtime-context，被当成主机说话，微信回复被闸了 30 分钟。
// 跑：node test-host-source.mjs
import assert from 'node:assert/strict'
import { isHostChatSource } from './lib/index.js'

assert.equal(isHostChatSource({ kind: 'user' }), true, '人手打的消息算主机说话')

for (const kind of ['runtime-context', 'time-context', 'model-selection', 'skill-catalog']) {
  assert.equal(isHostChatSource({ kind }), false, kind + ' 是宿主快照，不该算主机说话')
}

assert.equal(isHostChatSource(undefined), false, '没有 source 时不当成主机说话')
assert.equal(isHostChatSource({}), false, '没有 kind 时不当成主机说话')

console.log('host-source ok')
