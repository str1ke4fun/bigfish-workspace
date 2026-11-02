# agentbox —— 无 root 的 agent 隔离执行器

配套文档：`../技术调研-隔离与WSL传参.md`

## 装

```bash
mkdir -p ~/.agent ~/work
cp agentbox.sh ll_sandbox.py ~/.agent/
chmod +x ~/.agent/agentbox.sh ~/.agent/ll_sandbox.py
```

## 用

```bash
~/.agent/agentbox.sh '你的 shell 命令'
```

- 只看得见 `~/work`（挂到 `/home/agent/work`）和 `~/.agent`（挂到 `/home/agent/.agent`）
- 根文件系统只读，`/home` 是私有 tmpfs，`/tmp` 是私有 tmpfs
- 没有网络（只有 loopback），没有 capability，`NoNewPrivs=1`
- 越界访问：不存在 → `ENOENT`，只读 → `EROFS`，被 Landlock 拦 → `EACCES`
- 进程数上限 512（`prlimit --nproc`）

## 自测

```bash
cp selftest.sh ~/.agent/ && bash ~/.agent/selftest.sh
```

预期：工作区可写、`rm -rf /*` 无效、`/etc` 只读、`~/.ssh` 不可见、`/mnt` 不可见、curl 失败、退出码透传。

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_WORK` | `~/work` | 工作区，唯一可写入宿主机的目录 |
| `AGENT_HOME` | `~/.agent` | agent 自己的屋子（放脚本、状态） |
| `AGENT_LANDLOCK` | `$AGENT_HOME/ll_sandbox.py` | 没有这个文件就退化成"只有 bwrap" |

## 依赖

- `bubblewrap`（`apt install bubblewrap`），需要非特权 user namespace
- `python3`（只用于 Landlock 层）、`prlimit`（util-linux，基本都自带）
- 内核 ≥ 5.13（Landlock）；≥ 6.2 才有 `TRUNCATE`，≥ 6.7 才有网络控制

## 注意

- 工作区路径必须同时出现在 bwrap 的 `--bind` 和 Landlock 的 `--rw` 里，少一处就是 `EACCES`。
- 若 `~/.agent/ll_sandbox.py` 不存在，只跑 bwrap 那层（仍能挡误删，但读不到 EACCES 语义）。
- 裸机 Ubuntu 24.04+ 若报 `setting up uid map: Permission denied`，是 AppArmor 限制了非特权 userns：
  `sysctl kernel.apparmor_restrict_unprivileged_userns` 看是否为 1。
