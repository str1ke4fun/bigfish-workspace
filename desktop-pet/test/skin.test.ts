import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSkinForwarder,
  missingSkinMedia,
  noteLocalSize,
  resolveRemoteSize,
  scanSkins,
  shouldApplySettings,
  SIMPLE_SKIN_ID,
  validateSkin,
} from '../electron/skin.ts'

const ALL_MOTIONS = [
  'idle',
  'turn',
  'moving-left',
  'moving-right',
  'waving',
  'thinking',
  'working',
  'result',
  'waiting',
  'running',
  'review',
  'failed',
  'success',
  'error',
] as const

/** 每个动作用独立动画名，方便检查缺文件时精确定位。 */
function motionMap(): Record<string, string> {
  return Object.fromEntries(ALL_MOTIONS.map((motion) => [motion, motion]))
}

/** 在临时目录里放好一份完整皮肤；返回 skins 根目录。 */
function makeSkinFixture(t: { after: (fn: () => void) => void }, id: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pet-skin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const skinDir = join(root, 'skins', id)
  mkdirSync(join(skinDir, 'webm'), { recursive: true })
  const motions = motionMap()
  writeFileSync(join(skinDir, 'skin.json'), JSON.stringify({ name: `皮肤-${id}`, motions }))
  for (const name of Object.values(motions)) {
    writeFileSync(join(skinDir, 'webm', `${name}.webm`), 'x')
  }
  return root
}

test('skin.json 必须覆盖 14 个动作', () => {
  const motions = Object.fromEntries(ALL_MOTIONS.map((motion) => [motion, 'x']))
  assert.equal(validateSkin({ name: '测试', motions }).ok, true)
  assert.equal(validateSkin({ name: '缺动作', motions: { idle: 'x' } }).ok, false)
  assert.equal(validateSkin(null).ok, false)
})

test('皮肤 id 只允许小写字母数字与连字符', () => {
  assert.equal(SIMPLE_SKIN_ID.test('maid-blue'), true)
  assert.equal(SIMPLE_SKIN_ID.test('大肥鱼'), false)
  assert.equal(SIMPLE_SKIN_ID.test('../escape'), false)
})

test('同一设置重复下发不重复应用（避免抖动/重载）', () => {
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { size: 400, skin: '' }), false)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { size: 320 }), true)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { skin: 'maid-blue' }), true)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, {}), false)
})

test('scanSkins 默认皮肤在前，坏 JSON 跳过', (t) => {
  const root = makeSkinFixture(t, 'good')
  mkdirSync(join(root, 'skins', 'broken'), { recursive: true })
  writeFileSync(join(root, 'skins', 'broken', 'skin.json'), '{oops')

  assert.deepEqual(
    scanSkins(root).map((skin) => skin.id),
    ['', 'good'],
  )
})

test('皮肤缺 webm 时拒绝加载与上报', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pet-skin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const skinDir = join(root, 'skins', 'maid-blue')
  mkdirSync(join(skinDir, 'webm'), { recursive: true })
  const motions = motionMap()
  writeFileSync(join(skinDir, 'skin.json'), JSON.stringify({ name: '女仆', motions }))
  writeFileSync(join(skinDir, 'webm', 'idle.webm'), 'x')

  // 只放了 idle：其余 13 个动作都要报缺。
  const missing = missingSkinMedia(skinDir, motions)
  assert.deepEqual(
    missing,
    ALL_MOTIONS.filter((motion) => motion !== 'idle'),
  )
  // 缺文件的皮肤不能进 hello 清单，工作台也就不会提供切换。
  assert.deepEqual(scanSkins(root).map((skin) => skin.id), [''])

  for (const name of Object.values(motions)) {
    writeFileSync(join(skinDir, 'webm', `${name}.webm`), 'x')
  }
  assert.deepEqual(missingSkinMedia(skinDir, motions), [])
  assert.deepEqual(scanSkins(root).map((skin) => skin.id), ['', 'maid-blue'])
})

test('皮肤推送 forwarder：ready 补发，重复内容不重发', () => {
  const sent: unknown[] = []
  const forwarder = createSkinForwarder((payload) => {
    sent.push(payload)
  })

  // 还没有任何皮肤时，ready 不补发。
  forwarder.ready()
  assert.equal(sent.length, 0)

  const skin = {
    id: 'maid-blue',
    config: { motions: motionMap() },
    uri: 'pet-asset://local/skins/maid-blue/webm',
  }
  forwarder.onSkin(skin)
  assert.equal(sent.length, 1)
  assert.deepEqual(forwarder.get(), skin)

  // 同一份内容重复下发不重复推送。
  forwarder.onSkin({ ...skin })
  assert.equal(sent.length, 1)

  // 渲染进程订阅晚了（首推丢失）时，ready 补发最近一份。
  forwarder.ready()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], skin)
})

test('本地尺寸覆盖优先，服务端回声后清除', () => {
  // 右键改了 320：本地立即生效，并记下待服务端确认。
  const local = noteLocalSize(320)
  assert.deepEqual(local, { current: 320, pending: 320 })

  // 服务端还是旧的 400：不能把窗口拉回去。
  const ignored = resolveRemoteSize(local, 400)
  assert.equal(ignored.apply, null)
  assert.equal(ignored.state.current, 320)
  assert.equal(ignored.state.pending, 320)

  // 服务端回声 320：确认成功，清掉覆盖，不重复设置窗口。
  const echoed = resolveRemoteSize(ignored.state, 320)
  assert.equal(echoed.apply, null)
  assert.equal(echoed.state.pending, null)
  assert.equal(echoed.state.current, 320)

  // 没有覆盖时，远端变化正常生效。
  const remote = resolveRemoteSize(echoed.state, 462)
  assert.equal(remote.apply, 462)
  assert.equal(remote.state.current, 462)
  assert.equal(remote.state.pending, null)
})

test('再次本地改尺寸会替换待确认覆盖', () => {
  const first = noteLocalSize(320)
  const second = noteLocalSize(462)
  assert.deepEqual(second, { current: 462, pending: 462 })

  // 旧的服务端值不会顶掉第二次本地选择。
  assert.equal(resolveRemoteSize(second, 320).apply, null)
  // 只有服务端回声第二次的选择才算确认。
  assert.equal(resolveRemoteSize(second, 462).state.pending, null)
})
