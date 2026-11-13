import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { buildDdagrabArgs, parseJpegStream, parseCaptureStderr, detectHostCapture } from '../lib/host-capture.js'

test('buildDdagrabArgs 生成整屏/裁剪/事件参数', () => {
  const args = buildDdagrabArgs({ outputIdx: 1, fps: 0.2, mode: 'ambient' })
  const flat = args.join(' ')
  assert.ok(flat.includes('ddagrab=output_idx=1:framerate=0.2'))
  assert.ok(flat.includes('scale=1280:-2'))
  assert.ok(flat.includes('signalstats'))
  const crop = buildDdagrabArgs({ crop: { w: 100, h: 50, x: 10, y: 20 } })
  assert.ok(crop.join(' ').includes('crop=100:50:10:20'))
  const ev = buildDdagrabArgs({ mode: 'event' })
  assert.ok(ev.join(' ').includes('freezedetect'))
  assert.ok(ev.join(' ').includes('scene'))
})

test('parseJpegStream 按 SOI/EOI 切出两帧，跨 chunk 不丢', async () => {
  const frames = []
  const s = Readable.from([
    Buffer.from([0xff, 0xd8, 1]),
    Buffer.from([2, 0xff, 0xd9, 0xff, 0xd8, 3, 0xff, 0xd9]),
  ])
  parseJpegStream(s, (b) => frames.push(b.length))
  await new Promise((r) => s.on('end', r))
  assert.deepEqual(frames, [6, 5])
})

test('parseCaptureStderr 认 YAVG/scene/freeze', () => {
  assert.deepEqual(parseCaptureStderr('lavfi.signalstats.YAVG=44.8'), { yavg: 44.8 })
  assert.deepEqual(parseCaptureStderr('lavfi.scene_score=0.31'), { scene: 0.31 })
  assert.deepEqual(parseCaptureStderr('freeze_start: 1.2'), { freeze: 'start' })
  assert.equal(parseCaptureStderr('noise'), null)
})

test('detectHostCapture 没有 ffmpeg 时明确失败', () => {
  assert.equal(detectHostCapture({ ffmpegExe: '' }).ok, false)
  assert.equal(detectHostCapture({ ffmpegExe: '/no/such/ffmpeg' }).why, 'ffmpeg-missing')
})
