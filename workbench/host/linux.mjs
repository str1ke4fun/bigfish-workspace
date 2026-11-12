/**
 * linux.mjs —— Linux（树莓派）上的 host：脏活就在本机，直接跑。
 *
 * 和 Windows 那边的接口一模一样，所以 server.mjs 和页面一行都不用改。
 * 差别只有三处：
 *  - 没有 wsl.exe，命令直接 bash -lc；
 *  - 不需要保活（机器常开，服务由 systemd 管）；
 *  - 通知走 notify-send / wall，没有就静默。
 */
import { execFile, spawn } from 'node:child_process'

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

export function linuxHost(o = {}) {
  const appDir = o.appDir || process.cwd()

  function run(cmd, { timeout = 90_000 } = {}) {
    // 仍然 base64 包一层：命令里有中文、引号、$ 都不怕被二次解析。
    const wrapped = `echo ${b64(cmd)} | base64 -d | bash -l -s`
    return new Promise((resolve) => {
      execFile('bash', ['-c', wrapped], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || ''), err: err ? String(stderr || err.message).trim() : '' })
      })
    })
  }

  const sh = (cmd, opts) => run(cmd, opts)
  // 树莓派上这个用户通常有免密 sudo；没有就退化成普通用户，命令自己会报错。
  // 同样走 base64 管道，别让命令里的引号和 $ 被 shell 二次解析。
  const root = (cmd, { timeout = 90_000 } = {}) =>
    new Promise((resolve) => {
      const wrapped = `echo ${b64(cmd)} | base64 -d | sudo -n bash -l -s`
      execFile('bash', ['-c', wrapped], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || ''), err: err ? String(stderr || err.message).trim() : '' })
      })
    })

  async function image(cmd, { timeout = 90_000 } = {}) {
    const r = await run(`${cmd} | base64 -w0`, { timeout })
    const out = r.out.trim()
    if (!r.ok || out.length < 200) return { ok: false, err: r.err || '空图' }
    return { ok: true, buf: Buffer.from(out, 'base64') }
  }

  function notify(title, text) {
    for (const [cmd, args] of [
      ['notify-send', [String(title), String(text)]],
      ['wall', [`${title}：${text}`]],
    ]) {
      try {
        const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
        p.on('error', () => {})
        p.unref()
        return
      } catch { /* 换下一个 */ }
    }
  }

  return {
    name: 'linux',
    sh,
    root,
    image,
    notify,
    // 常开机器不需要保活；接口留着，上层不用分叉
    keepalive: { start() {}, stop() {}, aliveAgeMs: () => 0 },
  }
}
