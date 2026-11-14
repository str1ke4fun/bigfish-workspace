import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, PassThrough } from 'node:stream'
import { buildDdagrabArgs, parseJpegStream, parseCaptureStderr, detectHostCapture, startFrameStream } from '../lib/host-capture.js'

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
  assert.ok(ev.join(' ').includes('scdet'))
  assert.equal(ev.join(' ').includes('select='), false, '不能丢帧：静帧也要有帧可交给模型')
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

test('startFrameStream 把 YAVG/scene/冻结状态盖在帧上，而不是只丢 Buffer', async () => {
  const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])
  const child = new EventEmitter()
  child.pid = 123
  child.stdout = new PassThrough()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  const frames = []
  startFrameStream({
    spawn: () => child,
    ffmpegExe: '/x/ffmpeg.exe',
    mode: 'event',
    onFrame: (f) => frames.push(f),
  })
  child.stderr.emit('data', Buffer.from('lavfi.signalstats.YAVG=44.8\n'))
  child.stderr.emit('data', Buffer.from('lavfi.scd.score=2.31\n'))
  child.stdout.write(JPEG)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].yavg, 44.8)
  assert.equal(frames[0].scene, 2.31)
  assert.equal(frames[0].bytes, JPEG.length)
  assert.equal(frames[0].event, 'scene_change')
  assert.equal(frames[0].frozen, false)

  child.stderr.emit('data', Buffer.from('lavfi.freezedetect.freeze_start: 0\n'))
  child.stdout.write(JPEG)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(frames.length, 2)
  assert.equal(frames[1].frozen, true)
  assert.equal(frames[1].event, 'settlement')

  child.stderr.emit('data', Buffer.from('lavfi.freezedetect.freeze_end: 5\n'))
  child.stdout.write(JPEG)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(frames[2].frozen, false)
  assert.equal(frames[2].event, '')
})

test('detectHostCapture 没有 ffmpeg 时明确失败', () => {
  assert.equal(detectHostCapture({ ffmpegExe: '' }).ok, false)
  assert.equal(detectHostCapture({ ffmpegExe: '/no/such/ffmpeg' }).why, 'ffmpeg-missing')
})
