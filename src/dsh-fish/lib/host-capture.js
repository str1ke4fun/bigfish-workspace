/**
 * host-capture.js —— Windows 桌面抓帧（presence v1）
 *
 * 既有事实（2026-11-13 本机实测）：
 *   - ffmpeg `ddagrab`（DXGI Desktop Duplication）能抓 GPU 合成窗口；
 *   - `gdigrab -i hwnd=` 对 Windows Terminal / Electron 是全黑（YAVG=0），只能兜底；
 *   - 直接从 stdout 读 JPEG（SOI FF D8 / EOI FF D9），不写临时文件。
 *
 * 这个模块只做纯函数与子进程生命周期；模式状态、冷却、会话在 screen.js。
 * 零依赖；spawn 可注入，测试不碰真实屏幕。
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 生成 ddagrab 参数。crop 存在时只保留窗口矩形；event 模式加 scene/freeze 过滤。 */
export function buildDdagrabArgs({
  outputIdx = 0, fps = 1, crop = null, mode = 'event', scaleWidth = 1280,
  sceneThreshold = 0.12, freezeSeconds = 4,
} = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'info',
    '-init_hw_device', 'd3d11va',
    '-f', 'lavfi', '-i', `ddagrab=output_idx=${outputIdx}:framerate=${fps}`,
  ]
  const vf = ['hwdownload', 'format=bgra']
  if (crop && crop.w > 0 && crop.h > 0) vf.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`)
  vf.push(`scale=${scaleWidth}:-2`)
  if (mode === 'event') {
    vf.push(`freezedetect=n=0.003:d=${freezeSeconds}`)
    vf.push(`select='gt(scene,${sceneThreshold})'`)
  }
  // signalstats 用来算 YAVG（黑帧/锁屏检测）；metadata=print 写到 stderr。
  vf.push('signalstats', 'metadata=print')
  args.push('-vf', vf.join(','), '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-')
  return args
}

/** 从可读流里按 SOI/EOI 切 JPEG；跨 chunk 不丢。返回 stop 函数（当前无额外清理）。 */
export function parseJpegStream(readable, onFrame) {
  let buf = Buffer.alloc(0)
  const emit = (frame) => { try { onFrame(frame) } catch { /* 单帧失败不拖垮流 */ } }
  const onData = (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]))
      if (start < 0) { if (buf.length > 2) buf = buf.subarray(buf.length - 1); return }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
      if (end < 0) { if (start > 0) buf = buf.subarray(start); return }
      emit(buf.subarray(start, end + 2))
      buf = buf.subarray(end + 2)
    }
  }
  readable.on?.('data', onData)
  readable.on?.('error', () => { /* 只转发不抛 */ })
  return () => readable.off?.('data', onData)
}

/** 解析 ffmpeg stderr 里的 YAVG / scene / freeze。 */
export function parseCaptureStderr(line) {
  const s = String(line ?? '')
  let m = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(s)
  if (m) return { yavg: Number(m[1]) }
  m = /lavfi\.scene_score=([0-9.]+)/.exec(s)
  if (m) return { scene: Number(m[1]) }
  m = /freeze_(start|end):\s*([0-9.]+)?/i.exec(s)
  if (m) return { freeze: m[1].toLowerCase() }
  return null
}

/** 探测有没有可用的 Windows ffmpeg（只做存在性检查，不跑真实抓帧）。 */
export function detectHostCapture({ ffmpegExe = '' } = {}) {
  if (!ffmpegExe) return { ok: false, backend: null, ffmpegExe: '', why: 'no-ffmpeg' }
  if (!existsSync(ffmpegExe)) return { ok: false, backend: null, ffmpegExe, why: 'ffmpeg-missing' }
  return { ok: true, backend: 'ddagrab', ffmpegExe, why: '' }
}

/**
 * 启动抓帧流。
 * @returns {{stop:()=>Promise<void>, pid?:number}}
 */
export function startFrameStream({
  spawn = nodeSpawn, ffmpegExe, outputIdx = 0, fps = 1, crop = null, mode = 'event',
  scaleWidth = 1280, sceneThreshold = 0.12, freezeSeconds = 4,
  onFrame, onEvent, onError, log,
} = {}) {
  const args = buildDdagrabArgs({ outputIdx, fps, crop, mode, scaleWidth, sceneThreshold, freezeSeconds })
  let child
  try {
    child = spawn(ffmpegExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    onError?.({ ok: false, why: String(err?.message ?? err) })
    return { stop: async () => {}, pid: 0 }
  }
  const offJpeg = parseJpegStream(child.stdout, onFrame)
  let stderrBuf = ''
  child.stderr?.on?.('data', (chunk) => {
    stderrBuf += String(chunk)
    const lines = stderrBuf.split(/\r?\n/)
    stderrBuf = lines.pop() ?? ''
    for (const line of lines) {
      const ev = parseCaptureStderr(line)
      if (ev) onEvent?.(ev)
    }
  })
  child.on?.('error', (err) => onError?.({ ok: false, why: String(err?.message ?? err) }))
  child.on?.('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      onError?.({ ok: false, why: `ffmpeg exit ${code ?? signal}` })
    }
  })
  let stopped = false
  return {
    pid: child.pid,
    async stop() {
      if (stopped) return
      stopped = true
      try { offJpeg() } catch { /* ignore */ }
      try { child.kill() } catch { /* ignore */ }
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          resolve()
        }, 1000)
        t.unref?.()
        child.once?.('exit', () => { clearTimeout(t); resolve() })
      })
    },
  }
}
