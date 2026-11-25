/**
 * host-window.js —— P0 按窗口抓帧（Windows PrintWindow）
 *
 * 不依赖 cua-driver、不依赖桌宠：dsh-fish 通过 WSL interop 调 Windows
 * PowerShell，用 PrintWindow(hwnd, hdc, 2) 抓指定窗口。目标不需要在前台。
 *
 * 边界：
 *   - 列表脚本在 Windows 侧先按 allow/deny 过滤，被拒应用的标题不进入 WSL；
 *   - 只读抓帧，不点击、不置顶、不抢焦点；
 *   - 最小化窗口仍可能返回黑图，由上层按 code 如实报告。
 *
 * 零依赖：只用 node:child_process。
 */

import { spawn as nodeSpawn } from 'node:child_process'

export const DEFAULT_HOST_APPS = Object.freeze([
  'Code.exe', 'WindowsTerminal.exe', 'notepad.exe', 'chrome.exe',
])

export const DEFAULT_HOST_DENY = Object.freeze([
  'Weixin.exe', 'WeChat.exe', 'Feishu.exe', 'Lark.exe',
  'KeePass.exe', '1Password.exe', 'Bitwarden.exe',
])

const TITLE_LIMIT = 200
const WINDOW_LIMIT = 200

const norm = (s) => String(s ?? '').toLowerCase().replace(/\.exe$/i, '')

/** 进程名是否允许采集；deny 优先，大小写不敏感，去 .exe 比较。 */
export function isHostAppAllowed(app, { allow = DEFAULT_HOST_APPS, deny = DEFAULT_HOST_DENY } = {}) {
  const n = norm(app)
  if (!n) return false
  if ((Array.isArray(deny) ? deny : []).some((d) => norm(d) === n)) return false
  return (Array.isArray(allow) ? allow : []).some((a) => norm(a) === n)
}

function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

function psArray(list) {
  const items = (Array.isArray(list) ? list : []).map((s) => psQuote(s)).join(',')
  return `@(${items})`
}

const PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HostCuaWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
try { [HostCuaWin]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null } catch { }
function Get-AppName([int]$procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName + '.exe' } catch { return '' }
}
function Get-WinTitle([IntPtr]$h) {
  $n = [HostCuaWin]::GetWindowTextLength($h)
  if ($n -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($n + 1)
  [HostCuaWin]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  return $sb.ToString()
}
function Test-Allowed([string]$app, [string[]]$allow, [string[]]$deny) {
  $a = ($app -replace '\\.exe$', '').ToLowerInvariant()
  foreach ($d in $deny) { if ((($d -replace '\\.exe$', '').ToLowerInvariant()) -eq $a) { return $false } }
  foreach ($x in $allow) { if ((($x -replace '\\.exe$', '').ToLowerInvariant()) -eq $a) { return $true } }
  return $false
}
`

export function buildWindowListScript({ allow = DEFAULT_HOST_APPS, deny = DEFAULT_HOST_DENY } = {}) {
  return `${PRELUDE}
$allow = ${psArray(allow)}
$deny = ${psArray(deny)}
$items = New-Object System.Collections.ArrayList
$cb = [HostCuaWin+EnumWindowsProc]{
  param($h, $l)
  if (-not [HostCuaWin]::IsWindowVisible($h)) { return $true }
  $procId = 0
  [HostCuaWin]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  if ($procId -le 0) { return $true }
  $app = Get-AppName $procId
  if (-not (Test-Allowed $app $allow $deny)) { return $true }
  $title = Get-WinTitle $h
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $r = New-Object 'HostCuaWin+RECT'
  [HostCuaWin]::GetWindowRect($h, [ref]$r) | Out-Null
  [void]$items.Add(@{
    hwnd = $h.ToInt64(); pid = [int]$procId; app = $app; title = $title;
    minimized = [HostCuaWin]::IsIconic($h);
    rect = @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }
  })
  return $true
}
[HostCuaWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
ConvertTo-Json -InputObject @($items) -Compress -Depth 4
`.trim()
}

export function buildWindowCaptureScript({ hwnd, maxDimension = 1600 } = {}) {
  const id = Number(hwnd)
  const max = Number.isFinite(Number(maxDimension)) && Number(maxDimension) > 0 ? Math.round(Number(maxDimension)) : 0
  return `${PRELUDE}
$hwnd = [IntPtr][long]${Number.isFinite(id) ? id : 0}
if ($hwnd -eq [IntPtr]::Zero) { '{"ok":false,"code":"bad-hwnd"}'; exit 0 }
$procId = 0
[HostCuaWin]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$app = Get-AppName $procId
$title = Get-WinTitle $hwnd
$r = New-Object 'HostCuaWin+RECT'
[HostCuaWin]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { '{"ok":false,"code":"bad-rect"}'; exit 0 }
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
try { $ok = [HostCuaWin]::PrintWindow($hwnd, $hdc, 2) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }
if (-not $ok) { $bmp.Dispose(); '{"ok":false,"code":"printwindow-failed"}'; exit 0 }
$maxDim = ${max}
if ($maxDim -gt 0 -and [Math]::Max($w, $h) -gt $maxDim) {
  $scale = $maxDim / [Math]::Max($w, $h)
  $nw = [Math]::Max(1, [int][Math]::Round($w * $scale))
  $nh = [Math]::Max(1, [int][Math]::Round($h * $scale))
  $scaled = New-Object System.Drawing.Bitmap -ArgumentList $nw, $nh
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp, 0, 0, $nw, $nh)
  $sg.Dispose()
  $bmp.Dispose()
  $bmp = $scaled
  $w = $nw
  $h = $nh
}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$b64 = [Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()
$bmp.Dispose()
$obj = @{ ok = $true; app = $app; title = $title; width = $w; height = $h; png = $b64 }
ConvertTo-Json -InputObject $obj -Compress -Depth 3
`.trim()
}

/** 解析 PowerShell 最后一行 JSON；前面的警告/空行忽略。 */
function lastJson(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]) } catch { /* 继续往前找 */ }
  }
  return null
}

export function parseWindowList(stdout) {
  const parsed = lastJson(stdout)
  if (!Array.isArray(parsed)) return { ok: false, code: 'bad-json' }
  const windows = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.hwnd ?? '')
    const pid = Number(item.pid)
    const app = String(item.app ?? '')
    const title = String(item.title ?? '').trim().slice(0, TITLE_LIMIT)
    if (!id || id === '0' || !Number.isFinite(pid) || pid <= 0 || !app || !title) continue
    windows.push({
      id,
      pid,
      app,
      title,
      minimized: item.minimized === true,
      rect: item.rect && typeof item.rect === 'object' ? {
        left: Number(item.rect.left) || 0,
        top: Number(item.rect.top) || 0,
        right: Number(item.rect.right) || 0,
        bottom: Number(item.rect.bottom) || 0,
      } : null,
    })
    if (windows.length >= WINDOW_LIMIT) break
  }
  return { ok: true, windows }
}

export function parseWindowCapture(stdout) {
  const parsed = lastJson(stdout)
  if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'bad-json' }
  if (parsed.ok !== true) return { ok: false, code: String(parsed.code ?? 'capture-failed') }
  const png = String(parsed.png ?? '')
  if (!png) return { ok: false, code: 'empty-image' }
  let buf
  try { buf = Buffer.from(png, 'base64') } catch { return { ok: false, code: 'bad-image' } }
  if (!buf || buf.length === 0) return { ok: false, code: 'empty-image' }
  return {
    ok: true,
    app: String(parsed.app ?? ''),
    title: String(parsed.title ?? '').trim().slice(0, TITLE_LIMIT),
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
    buf,
  }
}

/** Windows 路径 → WSL /mnt 路径；不是盘符路径就原样返回。 */
export function winPathToWsl(winPath) {
  const s = String(winPath ?? '').trim()
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(s)
  if (!m) return s
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/**
 * 创建 PrintWindow 运行器。测试可注入 spawn。
 * @returns {{ list: (opts?: {allow?: string[], deny?: string[]}) => Promise<object>, capture: (hwnd: number|string) => Promise<object> }}
 */
export function createPrintWindow({
  spawn = nodeSpawn,
  powershellExe = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  timeoutMs = 15_000,
  log = () => {},
} = {}) {
  function run(script) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(powershellExe, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        log('[host-window] PowerShell 超时')
        resolve({ code: -2, stdout, stderr: `${stderr}\nhost-window: timeout` })
      }, timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on?.('data', (d) => { stdout += String(d) })
      child.stderr?.on?.('data', (d) => { stderr += String(d) })
      child.on?.('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: `${stderr}\n${String(err?.message ?? err)}` })
      })
      child.on?.('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: Number(code) ?? -1, stdout, stderr })
      })
    })
  }

  async function list({ allow = DEFAULT_HOST_APPS, deny = DEFAULT_HOST_DENY } = {}) {
    const r = await run(buildWindowListScript({ allow, deny }))
    if (r.code !== 0) {
      log(`[host-window] 列表失败 code=${r.code} ${String(r.stderr).slice(0, 300)}`)
      return { ok: false, code: 'powershell-exit', detail: String(r.stderr).slice(0, 300) }
    }
    return parseWindowList(r.stdout)
  }

  async function capture(hwnd) {
    const r = await run(buildWindowCaptureScript({ hwnd }))
    if (r.code !== 0) {
      log(`[host-window] 抓帧失败 code=${r.code} ${String(r.stderr).slice(0, 300)}`)
      return { ok: false, code: 'powershell-exit', detail: String(r.stderr).slice(0, 300) }
    }
    return parseWindowCapture(r.stdout)
  }

  return { list, capture }
}
