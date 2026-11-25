#!/usr/bin/env node
/**
 * 宿主 CUA 验收脚本
 *
 * 用法：
 *   node scripts/cua-acceptance/run.mjs --live
 *   node scripts/cua-acceptance/run.mjs --live --allow-foreground
 *   node scripts/cua-acceptance/run.mjs --live --allow-foreground --check-service
 *
 * 设计：docs/superpowers/specs/2026-11-25-cua-acceptance-harness-design.md
 *
 * 安全边界：
 * - 必须显式 --live；不会误跑。
 * - 前台交付只在 --allow-foreground 下用于 VS Code 闭环，会抢焦点。
 * - 自建隔离 hostCua 实例，不改线上服务 mode；不删除任何文件。
 * - 标记文本只含时间戳，不含真实内容/凭据。
 */

import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createHostCua } from '../../src/dsh-fish/lib/host-cua.js'
import { createPrintWindow, winPathToWsl } from '../../src/dsh-fish/lib/host-window.js'
import { registerLookWindow } from '../../src/dsh-fish/lib/look-window.js'
import { registerHostCuaTools } from '../../src/dsh-fish/lib/host-cua-tools.js'
import { looksLikeSecret, sanitizeForeign } from '../../src/dsh-fish/lib/guard.js'
import { isStableDriverPath } from '../../src/dsh-fish/lib/host-cua-detail.js'

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

function parseArgs(argv) {
  const out = {
    live: false, foreground: false, checkService: false,
    outDir: '', target: 'Code.exe', service: 'http://127.0.0.1:8788',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--live') out.live = true
    else if (a === '--allow-foreground') out.foreground = true
    else if (a === '--check-service') out.checkService = true
    else if (a === '--out') out.outDir = argv[++i] ?? ''
    else if (a === '--target') out.target = argv[++i] ?? 'Code.exe'
    else if (a === '--service') out.service = argv[++i] ?? out.service
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('node scripts/cua-acceptance/run.mjs --live [--allow-foreground] [--check-service] [--out DIR] [--target Code.exe]')
  process.exit(0)
}
if (!args.live) {
  console.error('拒绝执行：需要显式 --live（会启动真实驱动并操作真实窗口）')
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = args.outDir ? join(process.cwd(), args.outDir) : join(homedir(), '.dsh-fish', 'cua-acceptance', stamp)
const runtimeRoot = join(outDir, 'runtime')
const winScratchDir = `C:\\Users\\ASUS\\AppData\\Local\\Temp\\cua-acceptance\\${stamp}`
const wslScratchDir = `/mnt/c/Users/ASUS/AppData/Local/Temp/cua-acceptance/${stamp}`
const scratchName = 'scratch.txt'
const winScratchFile = `${winScratchDir}\\${scratchName}`
const wslScratchFile = `${wslScratchDir}/${scratchName}`

const results = []
const log = (...a) => console.log('[cua-acceptance]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const codeOf = (e) => String(e?.code ?? e?.message ?? e ?? '')

async function check(id, phase, expected, fn, { optional = false } = {}) {
  const started = Date.now()
  try {
    const actual = await fn()
    const status = optional ? 'observed' : 'passed'
    results.push({ id, phase, expected, actual, status, ms: Date.now() - started })
    console.log(`  ${status === 'passed' ? 'PASS' : 'OBS '} ${id} — ${typeof actual === 'string' ? actual : JSON.stringify(actual)?.slice(0, 300)}`)
    return true
  } catch (err) {
    const actual = { code: codeOf(err), message: String(err?.message ?? err).slice(0, 500) }
    const status = optional ? 'observed' : 'failed'
    results.push({ id, phase, expected, actual, status, ms: Date.now() - started })
    console.log(`  ${status === 'observed' ? 'OBS ' : 'FAIL'} ${id} — ${actual.code}: ${actual.message}`)
    return false
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message)
}

function runCommand(command, cmdArgs, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, cmdArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
      resolve({ code: -2, stdout, stderr: `${stderr}\n(timeout)` })
    }, timeoutMs)
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

const PS_FOREGROUND = `
Add-Type -Namespace CuaAcc -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);'
$h = [CuaAcc.W]::GetForegroundWindow()
$pid2 = 0
[CuaAcc.W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
@{ hwnd = $h.ToInt64(); pid = $pid2; name = $p.ProcessName } | ConvertTo-Json -Compress
`

async function foregroundInfo() {
  const r = await runCommand(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_FOREGROUND])
  if (r.code !== 0) return { ok: false, raw: String(r.stderr).slice(0, 200) }
  try { return { ok: true, ...JSON.parse(r.stdout.trim()) } } catch { return { ok: false, raw: String(r.stdout).slice(0, 200) } }
}

function windowsOf(result) {
  const w = result?.structuredContent?.windows
  return Array.isArray(w) ? w : []
}
const winId = (w) => String(w?.window_id ?? w?.windowId ?? w?.id ?? '')
const winApp = (w) => String(w?.app_name ?? w?.app ?? '')
const winTitle = (w) => String(w?.title ?? w?.window_title ?? '')

async function main() {
  log(`输出目录：${outDir}`)
  await fs.mkdir(runtimeRoot, { recursive: true })
  await fs.mkdir(join(outDir, 'windows'), { recursive: true })
  await fs.mkdir(wslScratchDir, { recursive: true })

  // ---------- P0 预检 ----------
  console.log('\n== P0 预检 ==')
  const regPath = join(homedir(), '.dsh-fish', 'host-cua.json')
  const reg = JSON.parse(await fs.readFile(regPath, 'utf8').catch(() => 'null'))
  const winExe = String(reg?.exe ?? '')
  await check('P0.registration', 'P0', 'host-cua.json 存在且路径稳定', async () => {
    expect(reg && winExe, 'host-cua.json 缺失或无 exe')
    expect(isStableDriverPath(winExe), `非稳定路径：${winExe}`)
    return { version: reg.version, exe: winExe }
  })

  const wslExe = winPathToWsl(winExe)
  await check('P0.driver-exists', 'P0', '驱动文件存在且可执行', async () => {
    expect(existsSync(wslExe), `不存在：${wslExe}`)
    return wslExe
  })
  await check('P0.driver-version', 'P0', 'cua-driver 0.55.0', async () => {
    const r = await runCommand(wslExe, ['--version'], { timeoutMs: 20000 })
    expect(r.code === 0, `--version 退出码 ${r.code}: ${r.stderr.slice(0, 200)}`)
    expect(/cua-driver 0\.55\.0/.test(r.stdout), `版本不符：${r.stdout.trim()}`)
    return r.stdout.trim()
  })

  if (args.checkService) {
    await check('P0.service-mode', 'P0', '线上服务 mode=off（避免双驱动）', async () => {
      const r = await fetch(`${args.service}/api/fish/host-cua/status`).then((x) => x.json())
      expect(r?.ok === true, 'status 不可读')
      expect(r.mode === 'off', `线上 mode=${r.mode}，先停托管`)
      return { mode: r.mode, phase: r.phase }
    })
  }

  // ---------- 实例与工具 ----------
  const hostCfg = {
    exe: winExe,
    apps: ['Code.exe', 'WindowsTerminal.exe', 'notepad.exe', 'chrome.exe'],
    defaultDetail: 'full',
    defaultInput: 'allow',
    detail: { 'chrome.exe': 'structure' },
    input: { 'WindowsTerminal.exe': 'deny' },
    budget: { maxActions: 120, maxActionsPer10s: 8, maxTypedChars: 20000 },
    ttlMs: 15 * 60_000,
  }
  const config = { hostCua: hostCfg }
  const hostCua = createHostCua({ root: runtimeRoot, config, log })
  const printWindow = createPrintWindow({ log })
  const defs = new Map()
  const ctx = { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } }
  registerLookWindow(ctx, { mode: hostCua, printWindow, root: runtimeRoot, config, log })
  registerHostCuaTools(ctx, {
    hostCua, root: runtimeRoot, config,
    guard: { looksLikeSecret, sanitizeForeign }, log,
  })
  const tool = (name, a) => defs.get(name)?.execute(a, {}) ?? { ok: false, code: 'NO_TOOL' }
  const callTool = async (name, a) => {
    try { return await tool(name, a) } catch (e) { return { ok: false, code: codeOf(e), message: String(e?.message ?? e) } }
  }
  const listWindows = async () => windowsOf(await hostCua.call('list_windows', { on_screen_only: false }))
  const findWindow = async (app, { visibleOnly = true } = {}) => {
    const wins = await listWindows()
    return wins.find((w) => new RegExp(`^${app.replace('.', '\\.')}$`, 'i').test(winApp(w)) && (!visibleOnly || w.minimized !== true))
  }

  try {
    // ---------- P1 状态机 ----------
    console.log('\n== P1 服务状态机 ==')
    await check('P1.status-off', 'P1', '初始 mode=off', async () => {
      const s = hostCua.status()
      expect(s.mode === 'off', `mode=${s.mode}`)
      return { mode: s.mode, apps: s.apps }
    })
    await check('P1.apps', 'P1', '4 个白名单与 detail/input', async () => {
      const s = hostCua.status()
      const by = Object.fromEntries(s.apps.map((x) => [x.app, x]))
      expect(by['Code.exe']?.detail === 'full' && by['Code.exe']?.input === 'allow', 'Code 配置不对')
      expect(by['chrome.exe']?.detail === 'structure', 'Chrome detail 应为 structure')
      expect(by['WindowsTerminal.exe']?.input === 'deny', 'Terminal input 应为 deny')
      return s.apps
    })
    await check('P1.observe', 'P1', 'observe 不启动驱动', async () => {
      await hostCua.setMode({ mode: 'observe', actor: 'acceptance' })
      const s = hostCua.status()
      expect(s.mode === 'observe' && s.driver === null, `mode=${s.mode} driver=${Boolean(s.driver)}`)
      return { mode: s.mode, driver: s.driver }
    })
    await check('P1.managed', 'P1', 'managed 启动驱动，5 工具齐全', async () => {
      const r = await hostCua.setMode({ mode: 'managed', actor: 'acceptance' })
      const s = hostCua.status()
      expect(r?.ok === true, `setMode 失败：${codeOf(r)}`)
      expect(s.mode === 'managed' && s.driver?.connected === true, `mode=${s.mode} connected=${s.driver?.connected}`)
      expect(s.driver.version === '0.55.0', `version=${s.driver.version}`)
      return { mode: s.mode, driver: s.driver }
    })
    await check('P1.off', 'P1', 'off 后驱动退出', async () => {
      await hostCua.setMode({ mode: 'off', actor: 'acceptance' })
      const s = hostCua.status()
      expect(s.mode === 'off' && s.driver === null, `mode=${s.mode} driver=${Boolean(s.driver)}`)
      return { mode: s.mode, driver: s.driver }
    })
    await check('P1.ttl', 'P1', '短 TTL 自动 off', async () => {
      const svc = createHostCua({ root: join(runtimeRoot, 'ttl'), config: { hostCua: { ...hostCfg, ttlMs: 1500 } }, log })
      try {
        await svc.setMode({ mode: 'observe', actor: 'acceptance' })
        expect(svc.status().mode === 'observe', '未进入 observe')
        await sleep(2100)
        expect(svc.status().mode === 'off', `到期后 mode=${svc.status().mode}`)
        return 'observe → off'
      } finally { svc.dispose() }
    })

    // ---------- P2 读路径 ----------
    console.log('\n== P2 读路径 ==')
    await hostCua.setMode({ mode: 'observe', actor: 'acceptance' })
    const lookList = await callTool('look_window', {})
    const lookWindows = Array.isArray(lookList.windows) ? lookList.windows : []
    const codeEntry = lookWindows.find((w) => /^Code\.exe$/i.test(w.app))
    const chromeEntry = lookWindows.find((w) => /^chrome\.exe$/i.test(w.app))
    const terminalEntry = lookWindows.find((w) => /^WindowsTerminal\.exe$/i.test(w.app))

    await check('P2.target-present', 'P2', `${args.target} 在 look_window 列表`, async () => {
      expect(codeEntry, `${args.target} 不在 look_window 列表`)
      return { id: codeEntry.id, title: codeEntry.title.slice(0, 80), minimized: codeEntry.minimized }
    })

    await check('P2.look-list', 'P2', 'look_window 列出白名单，微信/飞书不在', async () => {
      expect(lookList.ok === true && Array.isArray(lookList.windows), `look_window 失败：${codeOf(lookList)}`)
      const apps = lookWindows.map((w) => w.app)
      expect(apps.some((a) => /Code\.exe/i.test(a)), '没有 Code')
      expect(apps.some((a) => /WindowsTerminal\.exe/i.test(a)), '没有 Terminal')
      expect(apps.some((a) => /chrome\.exe/i.test(a)), '没有 Chrome')
      expect(!apps.some((a) => /Weixin|WeChat|Feishu|Lark/i.test(a)), '出现了 deny 应用')
      return { count: lookWindows.length, apps: [...new Set(apps)] }
    })

    await check('P2.look-capture', 'P2', 'look_window 抓 Code 一帧并落盘', async () => {
      expect(codeEntry, '没有 Code 窗口')
      const r = await callTool('look_window', { windowId: codeEntry.id })
      expect(r.ok === true && r.path, `抓帧失败：${codeOf(r)}`)
      const st = await fs.stat(r.path)
      expect(st.size > 1000, `图片过小：${st.size}`)
      return { path: r.path, bytes: st.size, width: r.width, height: r.height }
    })

    await check('P2.structure-no-image', 'P2', 'structure 应用返回 DETAIL_NO_IMAGE', async () => {
      expect(chromeEntry, '没有 Chrome 窗口')
      const r = await callTool('look_window', { windowId: chromeEntry.id })
      expect(r.ok === false && r.code === 'DETAIL_NO_IMAGE', `实际 ${r.code}`)
      return r.code
    })

    await check('P2.minimized-capture', 'P2', '最小化 full 窗口抓帧结果（观察项）', async () => {
      const mini = lookWindows.find((w) => w.minimized === true && w.detail !== 'structure' && w.detail !== 'none')
      expect(mini, '没有最小化且 full 的窗口')
      const r = await callTool('look_window', { windowId: mini.id })
      return r.ok ? { ok: true, app: mini.app, path: r.path, width: r.width, height: r.height } : { ok: false, app: mini.app, code: r.code }
    }, { optional: true })

    await check('P2.host-look', 'P2', 'managed + host_look Code 返回截图与快照', async () => {
      await hostCua.setMode({ mode: 'managed', actor: 'acceptance' })
      expect(codeEntry, '没有 Code 窗口')
      const r = await callTool('host_look', { windowId: codeEntry.id })
      expect(r.ok === true, `host_look 失败：${codeOf(r)}`)
      expect(r.snapshotId, '没有 snapshotId')
      expect(r.path, '没有截图路径')
      const treeLines = String(r.tree ?? '').split('\n').filter(Boolean).length
      return { snapshotId: r.snapshotId, captureId: r.captureId, path: r.path, treeLines }
    })

    // ---------- P3 fail-closed ----------
    console.log('\n== P3 fail-closed ==')
    const fresh = async (app) => {
      const w = await findWindow(app, { visibleOnly: false })
      expect(w, `${app} 不在窗口列表`)
      return w
    }
    const codeNow = await fresh('Code.exe')
    const terminalNow = await fresh('WindowsTerminal.exe')
    const chromeNow = await fresh('chrome.exe')

    const look = await callTool('host_look', { windowId: winId(codeNow) })
    const captureId = String(look?.captureId ?? 'acceptance-capture')

    await check('P3.capture-required', 'P3', '坐标点击无 captureId → CAPTURE_REQUIRED', async () => {
      const r = await callTool('host_click', { windowId: winId(codeNow), x: 10, y: 10 })
      expect(r.ok === false && r.code === 'CAPTURE_REQUIRED', `实际 ${r.code}`)
      return r.code
    })
    await check('P3.click-background', 'P3', 'Code 后台 click 有明确结果（ok 或 BACKGROUND_UNAVAILABLE）', async () => {
      const r = await callTool('host_click', { windowId: winId(codeNow), x: 10, y: 10, captureId })
      expect(r.ok === true || r.code === 'BACKGROUND_UNAVAILABLE', `实际 ${r.code}`)
      return r.ok ? 'ok（后台 click 可用）' : r.code
    })
    await check('P3.type-background-unavailable', 'P3', 'Code 后台 type → BACKGROUND_UNAVAILABLE', async () => {
      const r = await callTool('host_type', { windowId: winId(codeNow), text: 'cua-acceptance' })
      expect(r.ok === false && r.code === 'BACKGROUND_UNAVAILABLE', `实际 ${r.code}`)
      return r.code
    })
    await check('P3.key-background-unavailable', 'P3', 'Code 后台 ctrl+n → BACKGROUND_UNAVAILABLE', async () => {
      const r = await callTool('host_key', { windowId: winId(codeNow), key: 'n', modifiers: ['ctrl'] })
      expect(r.ok === false && r.code === 'BACKGROUND_UNAVAILABLE', `实际 ${r.code}`)
      return r.code
    })
    await check('P3.chrome-click', 'P3', 'Chrome 后台 elementToken click 结果（观察项）', async () => {
      const look = await callTool('host_look', { windowId: winId(chromeNow) })
      expect(look.ok === true, `host_look 失败：${look.code}`)
      const token = (String(look.tree ?? '').match(/\[([^\]\s]+)\]/) ?? [])[1]
      if (!token) return { skippedReason: 'Chrome structure 没有 element token' }
      const r = await callTool('host_click', { windowId: winId(chromeNow), elementToken: token })
      expect(r.ok === true || r.code === 'BACKGROUND_UNAVAILABLE', `实际 ${r.code}`)
      return { token, result: r.ok ? 'ok' : r.code, minimized: chromeNow.minimized === true }
    }, { optional: true })
    await check('P3.terminal-click', 'P3', 'Terminal input=deny → INPUT_DENIED（不进驱动）', async () => {
      const r = await callTool('host_click', { windowId: winId(terminalNow), x: 10, y: 10, captureId })
      expect(r.ok === false && r.code === 'INPUT_DENIED', `实际 ${r.code}`)
      return r.code
    })
    await check('P3.terminal-input-denied', 'P3', 'Terminal input=deny → INPUT_DENIED', async () => {
      const r = await callTool('host_type', { windowId: winId(terminalNow), text: 'cua-acceptance' })
      expect(r.ok === false && r.code === 'INPUT_DENIED', `实际 ${r.code}`)
      return r.code
    })
    await check('P3.key-blacklist', 'P3', 'alt+f4 → BAD_ARGS', async () => {
      const r = await callTool('host_key', { windowId: winId(codeNow), key: 'f4', modifiers: ['alt'] })
      expect(r.ok === false && r.code === 'BAD_ARGS', `实际 ${r.code}`)
      return r.code
    })
    await check('P3.secret-denied', 'P3', 'sk- 文本 → INPUT_DENIED', async () => {
      // 拼接写法：运行时仍是假 key，但避免凭据扫描把它当成真实 token
      const fakeKey = 'sk-' + 'acceptance-not-a-real-key'
      const r = await callTool('host_type', { windowId: winId(codeNow), text: fakeKey })
      expect(r.ok === false && r.code === 'INPUT_DENIED', `实际 ${r.code}`)
      return r.code
    })
    await check('P3.window-not-allowed', 'P3', '非白名单窗口 → WINDOW_NOT_ALLOWED', async () => {
      const wins = await listWindows()
      const other = wins.find((w) => winApp(w) && !/^(Code|WindowsTerminal|notepad|chrome)\.exe$/i.test(winApp(w)))
      expect(other, '找不到非白名单窗口')
      const r = await callTool('host_click', { windowId: winId(other), x: 1, y: 1, captureId })
      expect(r.ok === false && r.code === 'WINDOW_NOT_ALLOWED', `实际 ${r.code}`)
      return { app: winApp(other), code: r.code }
    })
    await check('P3.rate-limited', 'P3', '连续输入触发 RATE_LIMITED', async () => {
      await hostCua.setMode({ mode: 'off', actor: 'acceptance' })
      await hostCua.setMode({ mode: 'managed', actor: 'acceptance' })
      const codes = []
      for (let i = 0; i < 9; i += 1) {
        try {
          await hostCua.call('type_text', { pid: codeNow.pid, window_id: winId(codeNow), text: 'x', delivery_mode: 'background' })
          codes.push('ok')
        } catch (e) {
          codes.push(codeOf(e))
        }
      }
      expect(codes.includes('RATE_LIMITED'), `未命中：${codes.join(',')}`)
      return codes
    })

    // ---------- P4 VS Code 前台闭环 ----------
    console.log('\n== P4 VS Code 前台闭环 ==')
    const skip = (id, phase, reason) => {
      results.push({ id, phase, expected: reason, actual: 'skipped', status: 'skipped', ms: 0 })
      console.log(`  SKIP ${id} — ${reason}`)
    }
    if (!args.foreground) {
      results.push({ id: 'P4.foreground', phase: 'P4', expected: '显式 --allow-foreground', actual: 'skipped', status: 'skipped', ms: 0 })
      console.log('  SKIP P4 — 未提供 --allow-foreground')
    } else {
      await runForegroundLoop()
    }

    async function runForegroundLoop() {
      const before = await foregroundInfo()
      log(`前台（开始）：${JSON.stringify(before)}`)

      let code = await findWindow('Code.exe')
      const okTarget = await check('P4.target', 'P4', 'VS Code 窗口存在', async () => {
        expect(code, 'VS Code 不在窗口列表')
        return { id: winId(code), pid: code.pid, title: winTitle(code).slice(0, 80) }
      })
      if (!okTarget || !code) return
      // 确保 managed，且动作预算重置
      await hostCua.setMode({ mode: 'off', actor: 'acceptance' })
      await hostCua.setMode({ mode: 'managed', actor: 'acceptance' })
      code = await findWindow('Code.exe')
      const target = { pid: code.pid, window_id: winId(code), delivery_mode: 'foreground' }

      const marker1 = `cua-acceptance ${stamp}`
      const marker2 = `cua-acceptance ${stamp} edited`

      const okNew = await check('P4.new-file', 'P4', '前台 Ctrl+N 新建未命名缓冲区', async () => {
        const r = await hostCua.call('press_key', { ...target, key: 'n', modifiers: ['ctrl'] })
        await sleep(900)
        const after = await findWindow('Code.exe')
        const title = winTitle(after)
        expect(/untitled|未命名/i.test(title), `标题未出现未命名：${title.slice(0, 80)}`)
        return { title: title.slice(0, 80), driver: r?.isError === true ? 'isError' : 'ok' }
      })
      if (!okNew) {
        skip('P4.write', 'P4', '新建失败')
        skip('P4.save', 'P4', '新建失败')
        skip('P4.verify-created', 'P4', '新建失败')
        skip('P4.modify', 'P4', '新建失败')
        skip('P4.verify-modified', 'P4', '新建失败')
        skip('P4.close', 'P4', '新建失败')
        return
      }
      const afterNew = await findWindow('Code.exe')
      const editorTarget = { pid: afterNew.pid, window_id: winId(afterNew), delivery_mode: 'foreground' }

      await check('P4.write', 'P4', '前台写入标记', async () => {
        await hostCua.call('type_text', { ...editorTarget, text: marker1 })
        await sleep(500)
        return marker1
      })

      let savedWslPath = ''
      const dialogElements = async (d) => {
        const r = await hostCua.call('get_window_state', {
          pid: d.pid, window_id: winId(d), include_accessibility_tree: true,
          include_screenshot: true, tree_format: 'elements', max_elements: 200, max_image_dimension: 1280,
        })
        return r?.structuredContent?.elements ?? []
      }
      const dialogOpen = async (pid) => (await listWindows()).some((w) => w.pid === pid && /save as|另存为/i.test(winTitle(w)))

      const okSave = await check('P4.save', 'P4', 'Ctrl+S → 导航目录 → 保存', async () => {
        const beforeIds = new Set((await listWindows()).map(winId))
        await hostCua.call('press_key', { ...editorTarget, key: 's', modifiers: ['ctrl'] })
        await sleep(1400)
        const wins = await listWindows()
        const fresh = wins.filter((w) => !beforeIds.has(winId(w)) && w.pid === afterNew.pid)
        const dialog = fresh.find((w) => /save as|另存为|save file|保存/i.test(winTitle(w))) ?? fresh[0]
        expect(dialog, `未找到保存对话框；新窗口：${fresh.map((w) => winTitle(w)).join(' | ')}`)
        const dTarget = { pid: dialog.pid, window_id: winId(dialog), delivery_mode: 'foreground' }
        // 先导航到目标目录：Ctrl+L → 目录 → Enter（不要一次塞完整路径）
        await hostCua.call('press_key', { ...dTarget, key: 'l', modifiers: ['ctrl'] })
        await sleep(300)
        await hostCua.call('type_text', { ...dTarget, text: winScratchDir })
        await sleep(200)
        await hostCua.call('press_key', { ...dTarget, key: 'enter' })
        // 导航后等目录稳定；每次点击前重新取快照，最多 3 次
        await sleep(1500)
        let saveVia = 'none'
        let resolveBtn = null
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (!(await dialogOpen(dialog.pid))) break
          const els = await dialogElements(dialog)
          const saveBtn = els.find((e) => /button/i.test(String(e.role)) && /保存\(S\)|^保存$|^save( as)?$/i.test(String(e.label ?? e.value ?? e.name ?? '').trim()))
          resolveBtn = saveBtn?.element_token ?? null
          if (resolveBtn) {
            await hostCua.call('click', { ...dTarget, element_token: resolveBtn })
            saveVia = `button#${attempt}`
          } else {
            await hostCua.call('press_key', { ...dTarget, key: 'enter' })
            saveVia = `enter#${attempt}`
          }
          await sleep(1400)
        }
        const files = await fs.readdir(wslScratchDir).catch(() => [])
        const txt = files.filter((f) => /\.txt$/i.test(f)).sort()
        expect(txt.length > 0, `目录里没有 .txt：${files.join(',')}`)
        savedWslPath = join(wslScratchDir, txt[txt.length - 1])
        return { dialog: winTitle(dialog).slice(0, 80), dir: wslScratchDir, file: savedWslPath, saveVia, resolveBtn }
      })

      if (!okSave) {
        try { await hostCua.call('press_key', { ...editorTarget, key: 'escape', delivery_mode: 'foreground' }) } catch { /* ignore */ }
        skip('P4.verify-created', 'P4', '保存失败')
        skip('P4.modify', 'P4', '保存失败')
        skip('P4.verify-modified', 'P4', '保存失败')
        skip('P4.close', 'P4', '保存失败')
        return
      }

      const okVerify = await check('P4.verify-created', 'P4', '磁盘内容等于第一段标记', async () => {
        const path = savedWslPath || wslScratchFile
        const body = await fs.readFile(path, 'utf8').catch(() => null)
        expect(body !== null, `文件不存在：${path}`)
        expect(body.includes(marker1), `内容不符：${JSON.stringify(body.slice(0, 200))}`)
        return { path, bytes: Buffer.byteLength(body) }
      })
      if (!okVerify) {
        skip('P4.modify', 'P4', '首次保存校验失败')
        skip('P4.verify-modified', 'P4', '首次保存校验失败')
        skip('P4.close', 'P4', '首次保存校验失败')
        return
      }

      // 保存对话框消耗了大部分 10 秒窗口预算；改写前重启托管以重置计数
      await hostCua.setMode({ mode: 'off', actor: 'acceptance' })
      await hostCua.setMode({ mode: 'managed', actor: 'acceptance' })

      await check('P4.modify', 'P4', '全选改写并 Ctrl+S', async () => {
        const cur = await findWindow('Code.exe')
        expect(cur, '改写时找不到 Code 窗口')
        const curTarget = { pid: cur.pid, window_id: winId(cur), delivery_mode: 'foreground' }
        await hostCua.call('press_key', { ...curTarget, key: 'a', modifiers: ['ctrl'] })
        await hostCua.call('type_text', { ...curTarget, text: marker2 })
        await sleep(400)
        await hostCua.call('press_key', { ...curTarget, key: 's', modifiers: ['ctrl'] })
        await sleep(1200)
        return marker2
      })

      await check('P4.verify-modified', 'P4', '磁盘内容等于第二段标记', async () => {
        const path = savedWslPath || wslScratchFile
        const body = await fs.readFile(path, 'utf8').catch(() => null)
        expect(body !== null, '文件不存在')
        expect(body.trim() === marker2 || body.includes(marker2), `内容不符：${JSON.stringify(body.slice(0, 200))}`)
        return { path, body: body.trim().slice(0, 120) }
      })

      await check('P4.close', 'P4', 'Ctrl+W 关闭已保存标签页', async () => {
        const cur = await findWindow('Code.exe')
        expect(cur, '关闭时找不到 Code 窗口')
        const curTarget = { pid: cur.pid, window_id: winId(cur), delivery_mode: 'foreground' }
        await hostCua.call('press_key', { ...curTarget, key: 'w', modifiers: ['ctrl'] })
        await sleep(900)
        const after = await findWindow('Code.exe')
        return { title: winTitle(after).slice(0, 80) }
      })

      const after = await foregroundInfo()
      log(`前台（结束）：${JSON.stringify(after)}`)
      results.push({ id: 'P4.focus', phase: 'P4', expected: '记录前台变化', actual: { before, after }, status: 'observed', ms: 0 })
    }
  } finally {
    try { await hostCua.setMode({ mode: 'off', actor: 'acceptance' }) } catch { /* ignore */ }
    try { hostCua.dispose() } catch { /* ignore */ }
  }

  // ---------- P5 报告 ----------
  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
  const report = { stamp, args, outDir, winScratchFile, results, counts }
  await fs.writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log('\n== 汇总 ==')
  console.log(JSON.stringify(counts))
  console.log(`报告：${join(outDir, 'report.json')}`)
  console.log(`测试文件（保留）：${wslScratchFile}`)
  if (args.foreground) console.log('前台阶段已执行：VS Code 被激活过，焦点可能已改变。')
  const failed = results.filter((r) => r.status === 'failed')
  if (failed.length) {
    console.log('\n失败项：')
    for (const f of failed) console.log(`  ${f.id}: ${f.actual?.code ?? ''} ${f.actual?.message ?? ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('harness crashed:', err)
  process.exit(3)
})
