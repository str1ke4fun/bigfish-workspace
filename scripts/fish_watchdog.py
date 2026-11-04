#!/usr/bin/env python3
"""大肥鱼看门狗：宿主活着但耳朵停摆时重启 dsh-web。

设计：
- 宿主（dsh-web.service）不在 active，直接重启，不看 watch 开关。
- 宿主刚启动（<90s）或 activating，等待，不误杀启动中的进程。
- 用户关了 watch（~/.dsh-wx/policy.json 的 watch=false）或整个策略 disabled，
  不再基于 health.json 判活；但宿主挂了仍然重启。
- health.json 缺失或超过 min-age（默认 120s）没更新：
  - Xvfb 或微信不在 active → 先把依赖拉起来（start-deps，600s 限流）。
  - 依赖都在 → 重启宿主（600s 限流，连续 3 次后升到 1800s）。
"""

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
XVFB_UNIT = "xvfb-fish.service"
WECHAT_UNIT = "wechat-fish.service"
HEALTH_URL = "http://127.0.0.1:8710/"
MIN_AGE = 120
START_DEPS_COOLDOWN = 600
MAX_ACTIONS = 50


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


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def parse_iso(text):
    if not text:
        return None
    try:
        value = str(text).strip()
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except (TypeError, ValueError):
        return None


def unit_state(name):
    try:
        proc = subprocess.run(
            ["systemctl", "show", "-p", "ActiveState", "--value", name],
            capture_output=True, text=True, timeout=10,
        )
        return (proc.stdout or "").strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def host_uptime_sec(name):
    """宿主已 active 的秒数；读不到返回 999（不触发启动保护）。"""
    try:
        proc = subprocess.run(
            ["systemctl", "show", "-p", "ActiveEnterTimestampMonotonic",
             "--value", name],
            capture_output=True, text=True, timeout=10,
        )
        entered = int((proc.stdout or "").strip() or "0")
        if entered <= 0:
            return 999
        with open("/proc/uptime", "r", encoding="utf-8") as fh:
            uptime = float(fh.read().split()[0])
        return max(0.0, uptime - entered / 1_000_000)
    except (OSError, ValueError, subprocess.SubprocessError):
        return 999


def http_ok(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= getattr(resp, "status", 200) < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


def read_state(path):
    state = read_json(path, default=None)
    if not isinstance(state, dict):
        state = {}
    return {
        "lastRestartAt": state.get("lastRestartAt"),
        "lastStartDepsAt": state.get("lastStartDepsAt"),
        "consecutiveRestarts": int(state.get("consecutiveRestarts") or 0),
    }


def _atomic_write(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def write_state(path, state):
    _atomic_write(path, state)


def record_action(actions_path, entry):
    actions = read_json(actions_path, default=[])
    if not isinstance(actions, list):
        actions = []
    actions.append(entry)
    _atomic_write(actions_path, actions[-MAX_ACTIONS:])


def _systemctl(*args):
    return subprocess.run(
        ["systemctl", *args], capture_output=True, text=True, timeout=60,
    )


def run_action(decision, state, now, dry_run):
    """执行决策，返回 (result, changed)；changed 表示 state 是否被修改。"""
    action = decision.action
    if action == "ok":
        return "ok", False
    if action == "wait":
        return "wait", False
    if action == "restart-host":
        cooldown = next_cooldown(state["consecutiveRestarts"])
        last = parse_iso(state.get("lastRestartAt"))
        if last is not None and (now - last).total_seconds() < cooldown:
            return "skip: cooldown", False
        if dry_run:
            return "would-restart-host", False
        try:
            proc = _systemctl("restart", UNIT)
        except (OSError, subprocess.SubprocessError) as exc:
            return f"restart-failed: {exc}", False
        if proc.returncode != 0:
            return f"restart-failed: {(proc.stderr or '').strip()}", False
        state["consecutiveRestarts"] = int(state["consecutiveRestarts"]) + 1
        state["lastRestartAt"] = now.isoformat()
        return "restarted-host", True
    if action == "start-deps":
        last = parse_iso(state.get("lastStartDepsAt"))
        if last is not None and (now - last).total_seconds() < START_DEPS_COOLDOWN:
            return "skip: cooldown", False
        if dry_run:
            return "would-start-deps", False
        failed = []
        for unit in (XVFB_UNIT, WECHAT_UNIT):
            try:
                proc = _systemctl("start", unit)
            except (OSError, subprocess.SubprocessError) as exc:
                failed.append(f"{unit}: {exc}")
                continue
            if proc.returncode != 0:
                failed.append(f"{unit}: {(proc.stderr or '').strip()}")
        if failed:
            return "start-deps-failed: " + "; ".join(failed), False
        state["lastStartDepsAt"] = now.isoformat()
        return "started-deps", True
    return f"unknown-action: {action}", False


def main(argv=None):
    parser = argparse.ArgumentParser(description="大肥鱼看门狗")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--now")
    parser.add_argument("--health-file", type=Path, default=HEALTH)
    parser.add_argument("--policy-file", type=Path, default=POLICY)
    parser.add_argument("--state-file", type=Path, default=STATE)
    parser.add_argument("--actions-file", type=Path, default=ACTIONS)
    parser.add_argument("--min-age", type=int, default=MIN_AGE)
    args = parser.parse_args(argv)

    now = parse_iso(args.now) or datetime.now(timezone.utc)
    policy = read_json(args.policy_file, default={})
    if not isinstance(policy, dict):
        policy = {}
    health = read_json(args.health_file, default={})
    if not isinstance(health, dict):
        health = {}
    health_at = parse_iso(health.get("at"))
    state = read_state(args.state_file)

    host_state = unit_state(UNIT)
    if host_state == "active" and not http_ok(HEALTH_URL):
        host_state = "unhealthy"
    uptime = host_uptime_sec(UNIT) if host_state == "active" else 999

    decision = decide(
        now=now,
        policy=policy,
        health_at=health_at,
        host_state=host_state,
        xvfb_state=unit_state(XVFB_UNIT),
        wechat_state=unit_state(WECHAT_UNIT),
        min_age=args.min_age,
        host_uptime_sec=uptime,
    )

    result, changed = run_action(decision, state, now, args.dry_run)
    if decision.reason == "health-fresh" and state["consecutiveRestarts"]:
        state["consecutiveRestarts"] = 0
        changed = True

    if changed and not args.dry_run:
        try:
            write_state(args.state_file, state)
        except OSError as exc:
            print(json.dumps({"error": f"state-write-failed: {exc}"},
                             ensure_ascii=False))
            return 1

    line = {
        "at": now.isoformat(),
        "action": decision.action,
        "reason": decision.reason,
        "result": result,
        "host": host_state,
        "hostUptime": round(uptime) if uptime != 999 else None,
        "healthAge": (round((now - health_at).total_seconds())
                      if health_at else None),
        "consecutiveRestarts": state["consecutiveRestarts"],
        "dryRun": bool(args.dry_run),
    }
    print(json.dumps(line, ensure_ascii=False))

    if not args.dry_run:
        try:
            record_action(args.actions_file, line)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
