# 大肥鱼常驻宿主实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 8710 的 web 宿主独占承载 `dsh-fish` + `dsh-wx`，退役 Desktop，并给每一层加上可重试的监督，做到开机自启、崩溃自恢复、耳朵停摆可检测。

**Architecture:** 源码和端到端验证都在 `dev` 工作区完成。`dsh-fish` 增加“宿主服务晚就绪”的有界重试；web profile 加载 `dsh-wx` 并把鱼根指到真鱼 `~/.dsh-fish`，同时重新启用被 `dsh-web-app` 禁用的 `workflow-ptc` / `tool-workflow`，让旧会话的 `standard` preset 可用。先用 8712 临时宿主验证 preset（不碰生产），再切换 8710 并停用 Desktop，最后安装看门狗。

**Tech Stack:** Node.js 24（`node --test`、`node:timers/promises`）、systemd（system + user units）、Python 3 标准库、DSH profile/bundle patch、WSL。

**Spec:** `docs/superpowers/specs/2026-11-04-bigfish-resident-host-design.md`

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 必须始终是 `{}`。
- `~/.dsh-fish/events.jsonl` 只能追加，不得删除、覆盖、重排。
- 不加人格设置入口；新输入口必须过 `lib/guard.js`。
- `src/dsh-fish` 提交前跑完整 `node --test`，基线 641 项必须全绿。
- 只暂存本任务明确涉及的文件；提交前跑 `git diff --cached --check` 和 `python3 scripts/audit-staged.py`。
- `rm`、`git clean`、破坏性 reset、强推、带 `--delete` 的同步必须先取得用户明确批准。
- 需要 sudo 的步骤当前不能免密执行，由用户用 `! sudo ...` 运行；执行前先展示完整命令和目标路径。
- 任何时刻只允许一个宿主写 `~/.dsh-fish` 和 `~/.dsh-wx/session.json`；切换前必须确认 Desktop 已退出。
- dev 工作区里已有的未跟踪文件 `src/dsh-wx/lib/sticker-panel.mjs` 不属于本任务，禁止提交或改动。

---

## Review Focus

- 宿主服务晚到（`workspaceRegistry` / `sessionController` 还没挂上）：必须重试到有界次数，不能永久卡死，也不能重试非服务类错误。
- `standard` preset 在 web 宿主仍然失败：阶段 A 必须从日志和会话头两处确认，不能只看进程起来了。
- 看门狗误重启：`watch=false`、微信未登录/树掉、health 缺失、state 文件损坏时都不能盲目重启。
- 双写者：切换后必须确认 Desktop 进程不存在，且只有一个 DSH 宿主。
- 长耗时 OCR 导致 health 超过 120 秒：阈值和退避必须可调，不能变成每 10 分钟无条件重启。

---

## Task 1: dev 工作区对齐

**Files:**
- 无文件改动（只做 Git 快进）

**Interfaces:**
- Consumes: `main` 上的 spec 和 plan 文档
- Produces: `dev` 与 `main` 同一基线，后续任务都在 `dev` 上提交

- [ ] **Step 1: 确认 dev 没有会被快进覆盖的本地提交**

Run: `git -C /home/str1k3/src/bigfish-workspace-dev status --short && git -C /home/str1k3/src/bigfish-workspace-dev log --oneline -3`
Expected: 只有未跟踪的 `src/dsh-wx/lib/sticker-panel.mjs`；当前提交是 `ec6429a` 或其祖先。

- [ ] **Step 2: 快进 dev 到 main**

Run: `git -C /home/str1k3/src/bigfish-workspace-dev merge --ff-only main`
Expected: `Fast-forward`，dev 现在包含 spec 和 plan。

- [ ] **Step 3: 确认两侧 SHA 一致**

Run: `git -C /home/str1k3/src/bigfish-workspace-dev log -1 --oneline && git -C /home/str1k3/src/bigfish-workspace log -1 --oneline`
Expected: 两行相同。

---

## Task 2: `dsh-fish` 宿主服务晚就绪重试

**Files:**
- Modify: `src/dsh-fish/lib/home.js:59-62`、`:109-112`、`:263-274`
- Modify: `src/dsh-fish/lib/index.js:152-158`、`:218-230`
- Test: `src/dsh-fish/test/home.test.mjs`
- 工作区：`/home/str1k3/src/bigfish-workspace-dev`

**Interfaces:**
- Consumes: 现有 `bootstrapHome(ctx, { root, preset, log })`
- Produces:
  - `ensureWorkspace` / `ensureTalkSession` 在宿主服务缺失时返回 `retryable: true`
  - `bootstrapHome` 原样透传 `retryable`
  - `export async function bootstrapHomeWithRetry(ctx, { root, preset, log, warn, attempts = 10, delayMs = 1500, signal } = {})`，返回最后一次 `bootstrapHome` 的结果；被 `signal` 中止时返回 `{ ok: false, why: '已停用', aborted: true, retryable: false, wsId: '', sessionId: '' }`

- [ ] **Step 1: 写失败的测试**

在 `src/dsh-fish/test/home.test.mjs` 末尾追加（复用文件里已有的 `tmpRoot` 和 `fakeCtx`）：

```js
function flakyCtx({ missingRegistryTimes = 0, missingSessionTimes = 0, registry = {} } = {}) {
  const base = fakeCtx({ registry })
  const originalGet = base.ctx.get.bind(base.ctx)
  let regCalls = 0
  let scCalls = 0
  base.ctx.get = (key) => {
    if (key === 'workspaceRegistry') {
      regCalls += 1
      return regCalls <= missingRegistryTimes ? null : originalGet(key)
    }
    if (key === 'sessionController') {
      scCalls += 1
      return scCalls <= missingSessionTimes ? null : originalGet(key)
    }
    return originalGet(key)
  }
  return { ...base, counts: () => ({ regCalls, scCalls }) }
}

test('workspaceRegistry 晚就绪：bootstrapHomeWithRetry 重试后成功', async () => {
  const root = await tmpRoot()
  try {
    const h = flakyCtx({ missingRegistryTimes: 2 })
    const r = await bootstrapHomeWithRetry(h.ctx, { root, attempts: 5, delayMs: 1 })
    assert.equal(r.ok, true, r.why)
    assert.equal(h.counts().regCalls, 3)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('sessionController 晚就绪：bootstrapHomeWithRetry 也会重试', async () => {
  const root = await tmpRoot()
  try {
    const h = flakyCtx({ missingSessionTimes: 2 })
    const r = await bootstrapHomeWithRetry(h.ctx, { root, attempts: 5, delayMs: 1 })
    assert.equal(r.ok, true, r.why)
    assert.equal(h.counts().scCalls, 3)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('非服务缺失类失败不重试', async () => {
  const root = await tmpRoot()
  try {
    const h = flakyCtx({ registry: { createSession: () => { throw new Error('create failed') } } })
    const r = await bootstrapHomeWithRetry(h.ctx, { root, attempts: 5, delayMs: 1 })
    assert.equal(r.ok, false)
    assert.equal(r.retryable, undefined)
    assert.equal(h.counts().regCalls, 1)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('重试等待期间 dispose：停止后续尝试', async () => {
  const root = await tmpRoot()
  try {
    const h = flakyCtx({ missingRegistryTimes: 99 })
    const ac = new AbortController()
    const p = bootstrapHomeWithRetry(h.ctx, { root, attempts: 5, delayMs: 50, signal: ac.signal })
    setTimeout(() => ac.abort(), 10)
    const r = await p
    assert.equal(r.ok, false)
    assert.equal(r.aborted, true)
    assert.equal(h.counts().regCalls, 1)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
```

同时把测试文件顶部的 import 改为包含 `bootstrapHomeWithRetry`：

```js
import {
  ensureWorkspace,
  ensureTalkSession,
  bootstrapHome,
  bootstrapHomeWithRetry,
  homeStatus,
  ensureHomeDir,
  talkSessionId,
} from '../lib/home.js'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test test/home.test.mjs`
Expected: FAIL，报 `bootstrapHomeWithRetry is not a function`。

- [ ] **Step 3: 在 `home.js` 加 `retryable` 标记**

`ensureWorkspace` 的服务缺失分支改为：

```js
if (!reg?.create) return { ok: false, why: '宿主没有 workspaceRegistry 服务', dir, retryable: true }
```

`ensureTalkSession` 的服务缺失分支改为：

```js
if (!sc?.create) return { ok: false, why: '宿主没有 sessionController 服务', retryable: true }
```

`bootstrapHome` 的两处透传改为：

```js
if (!ws.ok) return { ok: false, why: ws.why, wsId: '', sessionId: '', retryable: ws.retryable }
...
if (!ses.ok) return { ok: false, why: ses.why, wsId: ws.wsId, sessionId: '', retryable: ses.retryable }
```

- [ ] **Step 4: 在 `home.js` 实现 `bootstrapHomeWithRetry`**

文件顶部加：

```js
import { setTimeout as delay } from 'node:timers/promises'
```

在 `bootstrapHome` 之后加：

```js
export async function bootstrapHomeWithRetry(
  ctx,
  { root = rootDir(), preset = '', log, warn, attempts = 10, delayMs = 1500, signal } = {},
) {
  const max = Math.max(1, Number(attempts) || 1)
  const wait = Math.max(0, Number(delayMs) || 0)
  let last = { ok: false, why: 'not attempted', wsId: '', sessionId: '' }
  for (let i = 1; i <= max; i += 1) {
    if (signal?.aborted) {
      return { ok: false, why: '已停用', retryable: false, aborted: true, wsId: '', sessionId: '' }
    }
    last = await bootstrapHome(ctx, { root, preset, log })
    if (last.ok) return last
    if (!last.retryable) return last
    if (i === max) break
    warn?.(`[dsh-fish] 屋子还没就绪（第 ${i}/${max} 次）：${last.why}，${wait}ms 后重试`)
    await delay(wait, undefined, { signal }).catch(() => {})
  }
  return last
}
```

- [ ] **Step 5: 在 `index.js` 接入并支持 dispose 取消**

顶部 import 改为：

```js
import { bootstrapHomeWithRetry, homeStatus, wakeIfBlank } from './home.js'
```

`apply` 内、`boot()` 之前加：

```js
const bootAbort = new AbortController()
```

`boot()` 里的 `bootstrapHome` 调用改为：

```js
home = await bootstrapHomeWithRetry(ctx, {
  root,
  preset: config?.tools?.preset ?? '',
  log: (...a) => logger.info(...a),
  warn: (...a) => logger.warn(...a),
  signal: bootAbort.signal,
})
```

调用结束后在 `if (!home.ok)` 之前加：

```js
if (bootAbort.signal.aborted) return
```

`ctx.on?.('dispose', ...)` 和返回对象的 `dispose()` 里各加一行：

```js
try { bootAbort.abort() } catch { /* ignore */ }
```

- [ ] **Step 6: 运行单文件测试确认通过**

Run: `cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test test/home.test.mjs`
Expected: 全部 PASS，包括新增 4 项。

- [ ] **Step 7: 跑完整测试**

Run: `cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test`
Expected: 641 项基线全绿，加上新增测试也全绿；0 失败。

- [ ] **Step 8: 提交**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/home.js src/dsh-fish/lib/index.js src/dsh-fish/test/home.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "dsh-fish: 宿主服务晚就绪时重试建屋子"
```

---

## Task 3: 看门狗脚本与单元模板

**Files:**
- Create: `scripts/fish_watchdog.py`
- Create: `scripts/test_fish_watchdog.py`
- Create: `scripts/systemd/fish-watchdog.service`
- Create: `scripts/systemd/fish-watchdog.timer`
- 工作区：`/home/str1k3/src/bigfish-workspace-dev`

**Interfaces:**
- Consumes: `~/.dsh-wx/policy.json`（`enabled`、`watch`）、`~/.dsh-wx/health.json`（`at`、`tree.status`）、`systemctl show -p ActiveState --value <unit>`、`http://127.0.0.1:8710/`
- Produces:
  - `decide(*, now, policy, health_at, host_state, xvfb_state, wechat_state, min_age=120, host_uptime_sec=999) -> Decision`
  - `Decision(action, reason)`，`action ∈ {'ok','wait','restart-host','start-deps'}`
  - `next_cooldown(consecutive_restarts) -> int`（`<3` 返回 600，`>=3` 返回 1800）
  - CLI `fish-watchdog [--dry-run] [--now ISO8601] [--health-file PATH] [--policy-file PATH] [--state-file PATH] [--actions-file PATH] [--min-age SEC]`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/test_fish_watchdog.py`：

```python
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from fish_watchdog import decide, next_cooldown

NOW = datetime(2026, 11, 4, 12, 0, 0, tzinfo=timezone.utc)
FRESH = NOW - timedelta(seconds=30)
STALE = NOW - timedelta(seconds=121)
ON = {"enabled": True, "watch": True}


class DecideTest(unittest.TestCase):
    def test_healthy(self):
        d = decide(now=NOW, policy=ON, health_at=FRESH, host_state="active",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "ok")

    def test_host_activating_waits(self):
        d = decide(now=NOW, policy=ON, health_at=FRESH, host_state="activating",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "wait")

    def test_host_starting_waits(self):
        d = decide(now=NOW, policy=ON, health_at=STALE, host_state="active",
                   xvfb_state="active", wechat_state="active", host_uptime_sec=30)
        self.assertEqual(d.action, "wait")

    def test_host_inactive_restarts_even_with_watch_off(self):
        d = decide(now=NOW, policy={"enabled": False, "watch": False}, health_at=None,
                   host_state="failed", xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "restart-host")

    def test_watch_off_ignores_stale_health(self):
        d = decide(now=NOW, policy={"enabled": True, "watch": False}, health_at=STALE,
                   host_state="active", xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "ok")

    def test_policy_disabled_ignores_stale_health(self):
        d = decide(now=NOW, policy={"enabled": False}, health_at=STALE,
                   host_state="active", xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "ok")

    def test_stale_health_with_dead_wechat_starts_deps(self):
        d = decide(now=NOW, policy=ON, health_at=STALE, host_state="active",
                   xvfb_state="active", wechat_state="inactive")
        self.assertEqual(d.action, "start-deps")

    def test_stale_health_with_dead_xvfb_starts_deps(self):
        d = decide(now=NOW, policy=ON, health_at=None, host_state="active",
                   xvfb_state="inactive", wechat_state="active")
        self.assertEqual(d.action, "start-deps")

    def test_stale_health_with_deps_up_restarts_host(self):
        d = decide(now=NOW, policy=ON, health_at=STALE, host_state="active",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "restart-host")

    def test_missing_health_with_deps_up_restarts_host(self):
        d = decide(now=NOW, policy=ON, health_at=None, host_state="active",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "restart-host")

    def test_cooldown_backoff(self):
        self.assertEqual(next_cooldown(0), 600)
        self.assertEqual(next_cooldown(2), 600)
        self.assertEqual(next_cooldown(3), 1800)
        self.assertEqual(next_cooldown(9), 1800)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/str1k3/src/bigfish-workspace-dev && python3 scripts/test_fish_watchdog.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'fish_watchdog'`。

- [ ] **Step 3: 实现 `scripts/fish_watchdog.py`**

文件至少包含：

```python
#!/usr/bin/env python3
"""大肥鱼看门狗：宿主活着但耳朵停摆时重启 dsh-web。"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

HOME = Path(os.environ.get("HOME", "/home/str1k3"))
POLICY = HOME / ".dsh-wx/policy.json"
HEALTH = HOME / ".dsh-wx/health.json"
ACTIONS = HOME / ".dsh-wx/watchdog.json"
STATE = Path("/run/fish-watchdog/state.json")
UNIT = "dsh-web.service"
MIN_AGE = 120


@dataclass(frozen=True)
class Decision:
    action: str
    reason: str


def next_cooldown(consecutive_restarts: int) -> int:
    return 1800 if consecutive_restarts >= 3 else 600


def decide(*, now, policy, health_at, host_state, xvfb_state, wechat_state,
           min_age=MIN_AGE, host_uptime_sec=999):
    if host_state == "activating":
        return Decision("wait", "host-activating")
    if host_state == "active" and host_uptime_sec < 90:
        return Decision("wait", "host-starting")
    if host_state != "active":
        return Decision("restart-host", "host-inactive")
    if not (policy.get("enabled") is True and policy.get("watch") is not False):
        return Decision("ok", "watch-off")
    if health_at is None:
        if xvfb_state != "active" or wechat_state != "active":
            return Decision("start-deps", "health-missing-deps-down")
        return Decision("restart-host", "health-missing")
    age = (now - health_at).total_seconds()
    if age <= min_age:
        return Decision("ok", "health-fresh")
    if xvfb_state != "active" or wechat_state != "active":
        return Decision("start-deps", "health-stale-deps-down")
    return Decision("restart-host", "health-stale")
```

其余实现按这些函数拆分（保持可读、单文件即可）：

- `read_json(path, default=None)`：读不到或 JSON 坏了返回默认值，不抛。
- `parse_iso(text)`：解析 `Z` 或带偏移的 ISO 时间；失败返回 `None`。
- `unit_state(name)`：`subprocess.run(["systemctl","show","-p","ActiveState","--value",name], capture_output=True, text=True, timeout=10)`，去掉空白；异常返回 `"unknown"`。
- `host_uptime_sec(name)`：读 `systemctl show -p ActiveEnterTimestampMonotonic --value <name>`，再读 `/proc/uptime` 第一列，返回两者之差（秒）；任何一步失败返回 `999`，表示不因启动保护而等待。
- `http_ok(url, timeout=5)`：`urlopen` 成功返回 True；`HTTPError` 且 `code < 500` 也返回 True；其他异常 False。
- `read_state(path)`：读不到返回 `{"lastRestartAt": None, "lastStartDepsAt": None, "consecutiveRestarts": 0}`。
- `write_state(path, state)`：先建父目录，写临时文件再 `os.replace`；权限 `0o644`。
- `record_action(actions_path, entry)`：读现有数组（坏文件当空数组），追加，保留最后 50 条，原子写，权限 `0o644`。
- `run_action(decision, state, now, dry_run)`：
  - `restart-host`：受 `next_cooldown(state["consecutiveRestarts"])` 限流；未到时间返回 `skip: cooldown`；到时间执行 `systemctl restart dsh-web.service`，`consecutiveRestarts += 1`，`lastRestartAt = now`。
  - `start-deps`：600 秒限流；执行 `systemctl start xvfb-fish.service` 和 `systemctl start wechat-fish.service`，不增加 `consecutiveRestarts`。
  - dry-run 只返回将要执行的动作，不调用 systemctl、不写文件。
- `main()`：解析 CLI；默认 `now = datetime.now(timezone.utc)`；读 policy/health/state；`host_state = unit_state("dsh-web.service")`，若为 `active` 但 `http_ok()` 为假则把 `host_state` 改成 `"unhealthy"`；算 `host_uptime_sec("dsh-web.service")`；调用 `decide`；执行；成功且 `decision.reason == "health-fresh"` 时把 `consecutiveRestarts` 归零；打印一行 JSON；非 dry-run 时追加到 `ACTIONS`。

CLI 参数：

```python
p.add_argument("--dry-run", action="store_true")
p.add_argument("--now")
p.add_argument("--health-file", type=Path, default=HEALTH)
p.add_argument("--policy-file", type=Path, default=POLICY)
p.add_argument("--state-file", type=Path, default=STATE)
p.add_argument("--actions-file", type=Path, default=ACTIONS)
p.add_argument("--min-age", type=int, default=MIN_AGE)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/str1k3/src/bigfish-workspace-dev && python3 scripts/test_fish_watchdog.py -v`
Expected: 11 项全部 PASS。

- [ ] **Step 5: 写 systemd 单元模板**

`scripts/systemd/fish-watchdog.service`：

```ini
[Unit]
Description=大肥鱼看门狗：宿主活着但耳朵停摆时重启
After=network.target dsh-web.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/fish-watchdog
Nice=10
```

`scripts/systemd/fish-watchdog.timer`：

```ini
[Unit]
Description=大肥鱼看门狗定时器

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: 用健康现场做一次 dry-run**

Run: `cd /home/str1k3/src/bigfish-workspace-dev && python3 scripts/fish_watchdog.py --dry-run`
Expected: 输出一行 JSON，`action` 为 `ok` 或 `wait`，不写任何文件。

- [ ] **Step 7: 提交**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add scripts/fish_watchdog.py scripts/test_fish_watchdog.py scripts/systemd/fish-watchdog.service scripts/systemd/fish-watchdog.timer
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "ops: 大肥鱼看门狗（耳朵停摆检测与限流重启）"
```

---

## Task 4: 阶段 A——8712 临时宿主验证 `standard`

**Files:**
- Create: `~/.dsh/profiles/webcheck/`（环境副本，不进仓库）
- Create: `~/.dsh-fish-devcheck/`（临时鱼根）
- 使用 dev 的 `src/dsh-fish`

**Interfaces:**
- Consumes: Task 2 的 `bootstrapHomeWithRetry`、当前 web profile
- Produces: 结论——重新启用 `workflow-ptc` / `tool-workflow` 后 `standard` preset 是否可用

- [ ] **Step 1: 复制 web profile**

Run: `cp -a /home/str1k3/.dsh/profiles/web /home/str1k3/.dsh/profiles/webcheck`
Expected: `webcheck` 下出现 `package.json`、`cordis.patch.yml`、`cordis.yml`、`node_modules`。

- [ ] **Step 2: 把副本的 `dsh-fish` 链接指向 dev**

Run: `ln -sfn /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish /home/str1k3/.dsh/profiles/webcheck/node_modules/dsh-fish`
Expected: `readlink` 输出 dev 路径。

- [ ] **Step 3: 改副本 `package.json` 的 bundles**

把 `bundles` 改成：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-wx", "dsh-fish"]
```

- [ ] **Step 4: 改副本 `cordis.patch.yml`**

在文件末尾追加：

```yaml
- { id: workflow-ptc, disabled: false }
- { id: tool-workflow, disabled: false }
- { id: dsh-wx, disabled: true }
- id: dsh-fish
  name: dsh-fish
  config:
    root: /home/str1k3/.dsh-fish-devcheck
```

同时删除文件里原有的 `- id: dsh-fish` 块（避免后面的 root 覆盖前面的）。确认文件里只有一个 `dsh-fish` 配置条目。

- [ ] **Step 5: 建临时鱼根**

Run: `mkdir -p /home/str1k3/.dsh-fish-devcheck && printf '{}\n' > /home/str1k3/.dsh-fish-devcheck/config.json`
Expected: 目录和空配置存在；默认 `tools.preset` 是 `''`，即宿主默认 `standard`。

- [ ] **Step 6: 启动 8712 临时宿主**

```bash
cd /home/str1k3
setsid nohup dsh --profile webcheck --no-open --port 8712 > /home/str1k3/.dsh/logs/webcheck.log 2>&1 < /dev/null &
echo $! > /tmp/webcheck.pid
sleep 20
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8712/
```

Expected: HTTP 返回 200、401 或 403（服务活着即可）。

- [ ] **Step 7: 检查 preset 是否真正可用**

Run: `grep -E "屋子|workflow-ptc|never started" /home/str1k3/.dsh-fish-devcheck/logs/dsh-fish.log | tail -20`
Expected: 出现 `屋子就绪`，且没有 `workflow-ptc ... never started`。

再确认会话头：

```bash
f=$(find /home/str1k3/.dsh/sessions -path '*fish-devcheck-home*' -name 'session.v4.jsonl.zstd' | head -1)
node -e 'const z=require("zlib"),fs=require("fs");console.log(z.zstdDecompressSync(fs.readFileSync(process.argv[1])).toString("utf8").split("\n")[0])' "$f"
```

Expected: `"agentPreset":"standard"`。

- [ ] **Step 8: 失败处理**

如果日志仍出现 `workflow-ptc ... never started` 或 `屋子没建起来`：
- 停止临时宿主：`kill $(cat /tmp/webcheck.pid)`
- 不要进入阶段 B。
- 把日志原文和判断报告给用户，讨论 spec 第 3 节的回退方案（新 `fish-home` 会话），**取得同意后再继续**。

- [ ] **Step 9: 停止临时宿主并记录结果**

Run: `kill $(cat /tmp/webcheck.pid); sleep 2; pgrep -af 'profile webcheck' || echo 'webcheck stopped'`
Expected: `webcheck stopped`。

临时目录 `/home/str1k3/.dsh-fish-devcheck` 和 `/home/str1k3/.dsh/profiles/webcheck` 先保留，便于复查；删除需要用户另行批准。

---

## Task 5: 阶段 B——真实切换 8710 并退役 Desktop

**Files:**
- Modify: `~/.dsh/profiles/web/package.json`
- Modify: `~/.dsh/profiles/web/cordis.patch.yml`
- Modify: `~/.dsh/profiles/desktop/package.json`
- Create: `~/.dsh/backups/2026-11-04-resident-host/`
- Create: `scripts/systemd/dsh-web.service`（仓库内模板）
- 使用 dev 的 `src/dsh-fish`

**Interfaces:**
- Consumes: 阶段 A 的结论、Task 2 的重试代码
- Produces: 8710 宿主独占 `dsh-fish` + `dsh-wx`，真鱼会话复用

- [ ] **Step 1: 备份**

```bash
mkdir -p /home/str1k3/.dsh/backups/2026-11-04-resident-host
cp /home/str1k3/.dsh/profiles/web/package.json /home/str1k3/.dsh/backups/2026-11-04-resident-host/web-package.json
cp /home/str1k3/.dsh/profiles/web/cordis.patch.yml /home/str1k3/.dsh/backups/2026-11-04-resident-host/web-cordis.patch.yml
cp /home/str1k3/.dsh/profiles/desktop/package.json /home/str1k3/.dsh/backups/2026-11-04-resident-host/desktop-package.json
cp /etc/systemd/system/dsh-web.service /home/str1k3/.dsh/backups/2026-11-04-resident-host/dsh-web.service
```

Expected: 四个备份文件存在。

- [ ] **Step 2: 停用 Desktop 用户单元**

```bash
systemctl --user disable --now dsh-desktop-next.service
sleep 2
pgrep -af 'dsh-desktop-2.0.21-next' || echo 'desktop stopped'
```

Expected: `desktop stopped`。若仍有进程，先 `systemctl --user stop dsh-desktop-next.service` 再查；确认退出后才继续。

- [ ] **Step 3: 改 web profile 的 `package.json`**

`bundles` 改为：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-wx", "dsh-fish"]
```

- [ ] **Step 4: 改 web profile 的 `cordis.patch.yml`**

- 把原有 `dsh-fish` 的 `root` 改为 `/home/str1k3/.dsh-fish`。
- 在文件末尾追加：

```yaml
# dsh-web-app 默认禁用 workflow-ptc / tool-workflow，而真鱼旧会话用 standard。
- { id: workflow-ptc, disabled: false }
- { id: tool-workflow, disabled: false }
- id: dsh-wx
  name: dsh-wx
  config:
    display: ':99'
```

- [ ] **Step 5: 从 desktop profile 移除两个插件**

`/home/str1k3/.dsh/profiles/desktop/package.json` 的 `bundles` 改为：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-experimental-plugin-market-bundle"]
```

其余字段不动。

- [ ] **Step 6: 把 web 的 `dsh-fish` 链接指向 dev**

```bash
ln -sfn /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish /home/str1k3/.dsh/profiles/web/node_modules/dsh-fish
readlink -f /home/str1k3/.dsh/profiles/web/node_modules/dsh-fish
```

Expected: 输出 dev 的 `src/dsh-fish` 绝对路径。

- [ ] **Step 7: 写仓库内的 `dsh-web.service` 模板**

创建 `scripts/systemd/dsh-web.service`：

```ini
[Unit]
Description=DSH web (大肥鱼) on WSL :8710
After=network-online.target xvfb-fish.service wechat-fish.service
Wants=network-online.target xvfb-fish.service wechat-fish.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=str1k3
Group=str1k3
WorkingDirectory=/home/str1k3
Environment=HOME=/home/str1k3
Environment=PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin
Environment=LANG=C.UTF-8
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
ExecStartPre=/usr/bin/truncate -s 0 /home/str1k3/dsh-web.log
ExecStart=/usr/local/bin/dsh web --no-open --port 8710
StandardOutput=append:/home/str1k3/dsh-web.log
StandardError=append:/home/str1k3/dsh-web.log
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 8: 安装单元并重启（USER-RUN，需要 sudo）**

把下面整段交给用户用 `!` 前缀执行：

```bash
sudo install -m 0644 /home/str1k3/src/bigfish-workspace-dev/scripts/systemd/dsh-web.service /etc/systemd/system/dsh-web.service
sudo systemctl daemon-reload
sudo systemctl restart dsh-web.service
```

Expected: 命令成功；`systemctl status dsh-web --no-pager` 显示 `active (running)`。

- [ ] **Step 9: 验证宿主与耳朵**

```bash
sleep 25
systemctl status dsh-web --no-pager | head -15
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8710/
grep -E '\[dsh-wx\] mounted|屋子就绪|屋子没建起来|never started' /home/str1k3/.dsh-fish/logs/dsh-fish.log | tail -20
pgrep -af 'dsh-desktop-2.0.21-next|host.js' || echo 'no second host'
```

Expected:
- HTTP 返回 200/401/403。
- 出现 `[dsh-wx] mounted (display=:99`。
- 出现 `屋子就绪 ... 会话 session-0891f0b7-...（复用）`。
- 没有 `never started`、没有 `屋子没建起来`。
- `no second host` 或只列出 dsh-web 自己的进程。

- [ ] **Step 10: 验证 health 与 8711**

```bash
python3 - <<'PY'
import json, datetime
p='/home/str1k3/.dsh-wx/health.json'
d=json.load(open(p))
at=datetime.datetime.fromisoformat(d['at'])
age=(datetime.datetime.now(datetime.timezone.utc)-at).total_seconds()
print('health age', round(age,1), 'tree', (d.get('tree') or {}).get('status'), 'chats', (d.get('tree') or {}).get('chats'))
PY
curl -s -o /dev/null -w 'entry %{http_code}\n' http://127.0.0.1:8711/
```

Expected: `health age` < 30 秒，`tree` 为 `ok` 或 `partial`，`chats` > 0；8711 返回 302 或 200。

- [ ] **Step 11: 人工确认一轮对话（USER-RUN）**

请用户打开 `http://127.0.0.1:8711/`，对鱼说一句话，确认有回复。

如果用户暂时不方便，记录为“模型调用链未验证”，不要用“服务已启动”代替这条结论。

- [ ] **Step 12: 提交 systemd 模板**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add scripts/systemd/dsh-web.service
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "ops: dsh-web 启动顺序与重试加固"
```

- [ ] **Step 13: 失败处理**

任何一项不符合预期：按 spec 第 12 节回滚（恢复 profile 备份、链接指回 main、重启 dsh-web、重新启用 Desktop），保留现场日志，报告给用户。不要继续安装看门狗。

---

## Task 6: 安装看门狗并做故障演练

**Files:**
- Install: `/usr/local/sbin/fish-watchdog`（来自 `scripts/fish_watchdog.py`）
- Install: `/etc/systemd/system/fish-watchdog.service`、`fish-watchdog.timer`

**Interfaces:**
- Consumes: Task 3 的脚本和单元、Task 5 的 8710 宿主
- Produces: 每 60 秒检查一次；耳朵停摆 120 秒后限流重启

- [ ] **Step 1: 安装（USER-RUN，需要 sudo）**

```bash
sudo install -m 0755 /home/str1k3/src/bigfish-workspace-dev/scripts/fish_watchdog.py /usr/local/sbin/fish-watchdog
sudo install -m 0644 /home/str1k3/src/bigfish-workspace-dev/scripts/systemd/fish-watchdog.service /etc/systemd/system/fish-watchdog.service
sudo install -m 0644 /home/str1k3/src/bigfish-workspace-dev/scripts/systemd/fish-watchdog.timer /etc/systemd/system/fish-watchdog.timer
sudo systemctl daemon-reload
```

- [ ] **Step 2: dry-run 确认判定**

Run: `sudo /usr/local/sbin/fish-watchdog --dry-run`
Expected: 输出 `"action": "ok"` 或 `"wait"`，没有执行重启。

- [ ] **Step 3: 启用定时器**

```bash
sudo systemctl enable --now fish-watchdog.timer
systemctl list-timers fish-watchdog.timer --no-pager
```

Expected: 定时器处于 `active (waiting)`，下次触发在 60 秒内。

- [ ] **Step 4: 手动触发一次**

```bash
sudo systemctl start fish-watchdog.service
journalctl -u fish-watchdog.service -n 10 --no-pager
```

Expected: 日志显示判定为 `ok` 或 `wait`，没有重启动作。

- [ ] **Step 5: 故障演练（USER-RUN，需要 sudo）**

```bash
sudo systemctl kill -s KILL dsh-web.service
sleep 20
systemctl status dsh-web --no-pager | head -8
```

Expected: systemd 把 `dsh-web` 拉起，status 为 `active`；随后 health 在 2 个轮询周期内恢复。

- [ ] **Step 6: 模拟耳朵停摆（USER-RUN，需要 sudo）**

```bash
pid=$(systemctl show -p MainPID --value dsh-web.service)
sudo kill -STOP "$pid"
sleep 180
journalctl -u fish-watchdog.service -n 20 --no-pager
sudo kill -CONT "$pid" 2>/dev/null || true
```

Expected: 看门狗在 120–180 秒内记录 `restart-host` 并重启宿主；`dsh-web.service` 的新 MainPID 与旧 PID 不同。

- [ ] **Step 7: 记录演练结果**

把 `journalctl` 和 `~/.dsh-wx/watchdog.json` 的关键行贴给用户；不要删除任何日志。

---

## Task 7: Windows 保活改成循环

**Files:**
- Modify: `C:\Users\ASUS\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\FishKeepAlive.vbs`
- WSL 路径：`/mnt/c/Users/ASUS/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/FishKeepAlive.vbs`

**Interfaces:**
- Consumes: 现有单次 `wsl.exe ... sleep infinity`
- Produces: WSL 退出后 60 秒自动重试

- [ ] **Step 1: 读原文件并确认字节内容**

Run: `python3 - <<'PY'
p="/mnt/c/Users/ASUS/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/FishKeepAlive.vbs"
b=open(p,'rb').read()
print(repr(b[-200:]))
PY`
Expected: 最后一行是 `sh.Run "wsl.exe -d Ubuntu-26.10 -u root -- /bin/sleep infinity", 0, False`。

- [ ] **Step 2: 改成循环，保留 CRLF**

用 Python 替换最后一条 `sh.Run` 行：

```python
old = b'sh.Run "wsl.exe -d Ubuntu-26.10 -u root -- /bin/sleep infinity", 0, False'
new = (
    b'Do\r\n'
    b'  sh.Run "wsl.exe -d Ubuntu-26.10 -u root -- /bin/sleep infinity", 0, True\r\n'
    b'  WScript.Sleep 60000\r\n'
    b'Loop'
)
assert b.count(old) == 1
p.write_bytes(b.replace(old, new))
```

- [ ] **Step 3: 读回确认**

Run: `python3 - <<'PY'
p="/mnt/c/Users/ASUS/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/FishKeepAlive.vbs"
print(open(p,'rb').read().decode('utf-8'))
PY`
Expected: 看到 `Do` / `True` / `WScript.Sleep 60000` / `Loop`，其余注释不变。

- [ ] **Step 4: 说明验证边界**

这一步无法从 WSL 内部验证 Windows 登录时的行为。报告时明确写：文件已改，实际冷启动验证需要用户重启 Windows。

---

## Task 8: 合并回 main 并复验

**Files:**
- Git：`dev` → `main`
- 链接：`~/.dsh/profiles/web/node_modules/dsh-fish` 指回 main

**Interfaces:**
- Consumes: Task 5/6 的验证结果和用户确认
- Produces: main 包含已验证的代码；生产链接指回主工作区

- [ ] **Step 1: 确认 dev 只有预期的提交**

```bash
git -C /home/str1k3/src/bigfish-workspace-dev status --short
git -C /home/str1k3/src/bigfish-workspace-dev log --oneline main..dev
```

Expected: 只有 Task 2、3、5 的三个提交；未跟踪的 `sticker-panel.mjs` 仍未跟踪、未提交。

- [ ] **Step 2: 请求用户确认合并**

把阶段 B 和看门狗的验证结果贴给用户，明确问：“验证通过，是否合并 dev → main？”只有得到肯定答复才继续。

- [ ] **Step 3: 快进合并**

```bash
git -C /home/str1k3/src/bigfish-workspace merge --ff-only dev
git -C /home/str1k3/src/bigfish-workspace log -2 --oneline
```

Expected: main 的 HEAD 与 dev 相同。

- [ ] **Step 4: 链接指回 main**

```bash
ln -sfn /home/str1k3/src/bigfish-workspace/src/dsh-fish /home/str1k3/.dsh/profiles/web/node_modules/dsh-fish
readlink -f /home/str1k3/.dsh/profiles/web/node_modules/dsh-fish
```

Expected: 输出主工作区的 `src/dsh-fish`。

- [ ] **Step 5: 重启并复验（USER-RUN，需要 sudo）**

```bash
sudo systemctl restart dsh-web.service
```

等待 25 秒后重复 Task 5 的 Step 9 和 Step 10：
- `[dsh-wx] mounted`
- `屋子就绪 ...（复用）`
- health 新鲜、`tree.status` 正常
- 只有一个宿主

- [ ] **Step 6: 报告边界**

明确区分：代码已合并、服务已重启、耳朵 health 正常；模型调用和微信消息收发没有在本轮验收范围内，不声称已验收。

---

## Task 9: 更新记忆与交付说明

**Files:**
- Modify: `/home/str1k3/.claude/projects/-home-str1k3-src-bigfish-workspace/memory/dsh-desktop-cua-status.md`
- Modify: `/home/str1k3/.claude/projects/-home-str1k3-src-bigfish-workspace/memory/MEMORY.md`

**Interfaces:**
- Consumes: Task 8 的最终状态
- Produces: 后续会话不会按“Desktop 是唯一耳朵”的旧事实行动

- [ ] **Step 1: 更新记忆**

把记忆里的主机归属改成：

- web 宿主（8710，系统服务）是 `dsh-fish` + `dsh-wx` 的唯一所有者。
- Desktop 用户单元已停用，desktop profile 不再加载两个插件。
- `dsh-fish` 根是真鱼 `~/.dsh-fish`；旧会话 `session-0891f0b7` 复用于 `standard` preset。
- 看门狗：`fish-watchdog.timer` 每 60 秒检查 health；120 秒不新鲜且微信/Xvfb 正常时重启 `dsh-web`。
- 回滚方式和备份路径。

- [ ] **Step 2: 更新索引行**

`MEMORY.md` 里对应条目的 hook 改成“web 宿主独占耳朵 + 看门狗；Desktop 已退役”。

- [ ] **Step 3: 最终报告**

向用户分别列出：
- 本地测试：通过/失败
- dev 提交 SHA
- 是否合并到 main、main SHA
- 阶段 A / B 验证结果
- 看门狗演练结果
- Windows 冷启动：未验证，需要用户重启
- 未能验证的边界（模型调用、真实消息收发）
