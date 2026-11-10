# 工作台 root 能力（fish-ctl）

工作台以 `str1k3` 身份运行，但“启动/停止她”和微信启停需要动系统单元。
本机没有免密 sudo，而 `host.root` 走的是 `sudo -n bash -l -s`——那会等于免密 root 任意命令。
所以改成：sudoers 只放行 `/usr/local/sbin/fish-ctl`，脚本内部再白名单动词和单元。

## 安装（需要一次 sudo）

```bash
sudo install -m 0755 /home/str1k3/src/bigfish-workspace-dev/scripts/ops/fish-ctl /usr/local/sbin/fish-ctl
sudo install -m 0440 -o root -g root /home/str1k3/src/bigfish-workspace-dev/scripts/ops/fish-ctl.sudoers /etc/sudoers.d/fish-workbench
sudo visudo -cf /etc/sudoers.d/fish-workbench
sudo -n /usr/local/sbin/fish-ctl is-active dsh-web.service
```

期望：`visudo` 输出 `parsed OK`，最后一条命令不需要密码就返回 `active`。

## 允许的范围

| 动词 | 单元 |
| --- | --- |
| `start` / `stop` / `restart` / `is-active` | `dsh-web.service`、`xvfb-fish.service`、`wechat-fish.service` |

其他动词、其他单元一律拒绝（退出码 64）。微信只经由 systemd 启停，
工作台不再自己 `setsid wechat`，避免出现第二个监管者把系统单元挤成 255 崩溃循环。

## 看门狗（fish-watchdog）

systemd 管“进程崩了”，看门狗管“进程活着但耳朵停摆”。每 60 秒检查：

- `dsh-web.service` 不在 active（或 HTTP 8710 不通）→ 重启宿主；
- 宿主 active 但 `~/.dsh-wx/health.json` 超过 120 秒没更新 → 依赖都正常就重启宿主，
  Xvfb/微信不在 active 就先把依赖拉起来；
- 刚启动 90 秒内、`activating`、登录页/树掉、策略 `watch=false` 都不重启；
- 重启限流 600 秒，连续 3 次后退避到 1800 秒，不会永久放弃。

安装：

```bash
sudo install -m 0755 /home/str1k3/src/bigfish-workspace-dev/scripts/fish_watchdog.py /usr/local/sbin/fish-watchdog
sudo install -m 0644 /home/str1k3/src/bigfish-workspace-dev/scripts/systemd/fish-watchdog.service /etc/systemd/system/fish-watchdog.service
sudo install -m 0644 /home/str1k3/src/bigfish-workspace-dev/scripts/systemd/fish-watchdog.timer /etc/systemd/system/fish-watchdog.timer
sudo systemctl daemon-reload
sudo /usr/local/sbin/fish-watchdog --dry-run
sudo systemctl enable --now fish-watchdog.timer
```

状态与记录：`/run/fish-watchdog/state.json`（重启即清）、`~/.dsh-wx/watchdog.json`
（最近 50 条动作，root 写、644 可读）、`journalctl -u fish-watchdog.service`。

### 人工停止与 hold

工作台“停止她”会先写 `~/.dsh-wx/hold.json`（`until` = 当前 + 600 秒），再停宿主。
hold 有效期内看门狗看到宿主 not active / HTTP 不通只等待，不拉起；到期恢复常驻。
“启动她”会把 `until` 写成当前时间，立即解除 hold。

维护时如果需要停掉宿主且不被拉起，先停定时器：

```bash
systemctl stop fish-watchdog.timer
```

## 卸载

```bash
sudo rm /etc/sudoers.d/fish-workbench /usr/local/sbin/fish-ctl
```
