/**
 * foreground.js —— 前台窗口探测、显示器映射与裁剪（presence v1 工作模式）
 *
 * 关键事实（2026-11-13 实测）：
 *   - 必须先 `SetProcessDpiAwarenessContext(-4)`（per-monitor V2），否则副屏 150%
 *     会把 1920×1080 报成 2880×1620，crop 直接失败；
 *   - 跨屏窗口按与各显示器重叠面积取最大的一块，只裁这一块；
 *   - 进程名小写比较，denylist 优先。
 *
 * 纯函数可单测；PowerShell 常驻进程由 startForegroundWatcher 管理。
 */

import { spawn as nodeSpawn } from 'node:child_process'

/** 取窗口中心命中的显示器；中心不在任何屏时按重叠面积取最大。 */
export function pickMonitor(rect, monitors = []) {
  const r = rect || {}
  const cx = (Number(r.left) + Number(r.right)) / 2
  const cy = (Number(r.top) + Number(r.bottom)) / 2
  if (monitors.length === 0) return { index: -1, monitor: null }
  for (let i = 0; i < monitors.length; i++) {
    const m = monitors[i]
    if (cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) return { index: i, monitor: m }
  }
  let best = { index: 0, monitor: monitors[0], area: -1 }
  for (let i = 0; i < monitors.length; i++) {
    const m = monitors[i]
    const x1 = Math.max(r.left, m.x)
    const y1 = Math.max(r.top, m.y)
    const x2 = Math.min(r.right, m.x + m.w)
    const y2 = Math.min(r.bottom, m.y + m.h)
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
    if (area > best.area) best = { index: i, monitor: m, area }
  }
  return { index: best.index, monitor: best.monitor }
}

/** 把窗口矩形夹到显示器边界内；越界/最小化返回 0 尺寸。 */
export function cropForWindow(rect, monitor) {
  const r = rect || {}
  const m = monitor || {}
  const x = Math.max(0, Number(r.left) - Number(m.x))
  const y = Math.max(0, Number(r.top) - Number(m.y))
  const w = Math.min(Number(r.right) - Number(r.left), Number(m.w) - x)
  const h = Math.min(Number(r.bottom) - Number(r.top), Number(m.h) - y)
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0, x: 0, y: 0 }
  return { w: Math.floor(w), h: Math.floor(h), x: Math.floor(x), y: Math.floor(y) }
}

/** 进程名是否允许采集；deny 优先，大小写不敏感，去 .exe 比较。 */
export function isAllowed(name, allow = [], deny = []) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\.exe$/i, '')
  const n = norm(name)
  if (!n) return false
  if (deny.some((d) => norm(d) === n)) return false
  return allow.some((a) => norm(a) === n)
}

/** 常驻 PowerShell 脚本：先 per-monitor V2，再循环输出 JSON 行。 */
export function buildForegroundScript({ intervalMs = 2000 } = {}) {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }
"@
[Dpi]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
while ($true) {
  $h = [W]::GetForegroundWindow()
  $pid2 = 0
  [W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  $r = New-Object W+RECT
  [W]::GetWindowRect($h, [ref]$r) | Out-Null
  $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  $mons = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ device=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; w=$_.Bounds.Width; h=$_.Bounds.Height } })
  @{ hwnd=$h.ToInt64(); pid=$pid2; name=$p.ProcessName; rect=@{ left=$r.Left; top=$r.Top; right=$r.Right; bottom=$r.Bottom }; monitors=$mons } | ConvertTo-Json -Compress -Depth 4
  Start-Sleep -Milliseconds ${Math.max(250, Number(intervalMs) || 2000)}
}
`.trim()
}

/** 解析 PowerShell 输出的一行 JSON；坏行返回 null。 */
export function parseForegroundSample(line) {
  try {
    const o = JSON.parse(String(line ?? ''))
    if (!o || !o.rect) return null
    const rect = o.rect
    if (![rect.left, rect.top, rect.right, rect.bottom].every((n) => Number.isFinite(Number(n)))) return null
    return {
      hwnd: Number(o.hwnd) || 0,
      pid: Number(o.pid) || 0,
      name: String(o.name ?? ''),
      rect: { left: Number(rect.left), top: Number(rect.top), right: Number(rect.right), bottom: Number(rect.bottom) },
      monitors: Array.isArray(o.monitors) ? o.monitors : [],
    }
  } catch {
    return null
  }
}

/** 启动常驻 PowerShell watcher；stop() kill 并等待。 */
export function startForegroundWatcher({
  spawn = nodeSpawn, powershellExe = 'powershell.exe', intervalMs = 2000,
  onSample, onError, log,
} = {}) {
  let child
  try {
    child = spawn(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', buildForegroundScript({ intervalMs })], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    onError?.({ ok: false, why: String(err?.message ?? err) })
    return { stop: async () => {} }
  }
  let buf = ''
  child.stdout?.on?.('data', (chunk) => {
    buf += String(chunk)
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const sample = parseForegroundSample(line)
      if (sample) onSample?.(sample)
    }
  })
  child.on?.('error', (err) => onError?.({ ok: false, why: String(err?.message ?? err) }))
  let stopped = false
  return {
    async stop() {
      if (stopped) return
      stopped = true
      try { child.kill() } catch { /* ignore */ }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 500)
        t.unref?.()
        child.once?.('exit', () => { clearTimeout(t); resolve() })
      })
    },
  }
}
