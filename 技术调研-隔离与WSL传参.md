# 技术调研：Linux 侧危险指令隔离 & PowerShell→wsl.exe→bash 传参

> 调研时间：2026-11-02
> 实测环境：Windows 11 (26200.9711) + WSL 2.7.10，发行版 Ubuntu 26.10，内核 `6.18.33.2-microsoft-standard-WSL2` x86_64，systemd 261，bubblewrap 0.12.0，PowerShell 5.1.26100.9711
> 文中标注「实测」的结论都在这台机器上跑过，命令与输出见附录；标注「文档」的是查证官方文档；标注「经验」的是通用工程判断。

---

## 0. 先给结论

**问题 1（隔离）**

- 单靠任何一个"删除保护"都挡不住 `rm -rf /*`：现代 coreutils 的 `--preserve-root` 只挡 `rm -rf /`，`/*` 会被 shell 展开，绕过检查。非 root 用户下 `/*` 里绝大多数目录本来就没权限删，**真正会被毁掉的是 `$HOME`**——2026-10-31 那次事故正是如此。
- 能"真的挡住"的只有一类机制：**让进程看不见 / 写不动那些路径**。即 mount namespace（bubblewrap / podman / systemd-run）和 Landlock。seccomp、sudo、rbash、审计都挡不住。
- 目标「只能动 `~/work` 和 `~/.agent`，动别处直接 EACCES，且不需要 root」→ **bubblewrap + Landlock 两层**，外面再套 `prlimit` 限进程数。两者都不需要 root，在本机实测可用（Landlock ABI 7）。
  - bwrap 负责"看不见"：私有 `/home`、只读根、独立 `/tmp`、断网、丢 capability。
  - Landlock 负责"EACCES"：把不在白名单里的路径（**包括读**）变成 `EACCES`，补上 bwrap 只读绑定仍可读的漏洞。
  - 现成可抄的 `agentbox.sh` + `ll_sandbox.py` 见 §3，已实测通过。
- 若环境不允许 user namespace（部分发行版默认关），退化方案是**只用 Landlock**：语义仍是 EACCES，但拿不到"看不见 `/mnt/c`、断网、私有 `/tmp`"这些好处。

**问题 2（传参）**

- 乱码和丢引号是**两个独立问题**，别混在一起治：
  - 乱码：`wsl.exe` 自己的消息是 **UTF-16LE**，子进程输出是**原样 UTF-8 字节**；PowerShell 用 `[Console]::OutputEncoding` 解码。三者不一致就乱码。
  - 丢引号：PowerShell 把参数拼成一条字符串 → `wsl.exe` 再解析一遍，**把没转义的 `"` 全部吃掉**。`grep -E "a|b"` 到 bash 手里变成 `grep -E a|b`，于是 `|` 成了管道。实测复现。
- 最可靠的三种写法，按优先级：**① 脚本落地再 `bash 文件` ② base64 内联 ③ `bash -s` 从 stdin 读**。裸写 `wsl -e bash -c "..."` 是最脆的一种。
- 环境变量默认**不**过去，要用 `WSLENV`；路径转换加 `/p`，路径列表加 `/l`。

---

# 问题 1：Linux 侧「危险指令隔离」

## 1.1 威胁模型：先想清楚要防什么

`rm -rf /*` 在非 root 下的实际杀伤力：

| 目标 | 非 root 能否删掉 | 说明 |
|---|---|---|
| `/usr` `/etc` `/var` `/boot` | 否 | 属主 root，普通用户无写权限 |
| `$HOME` 下所有东西 | **能** | 属主是自己 |
| `~/work`（agent 工作区） | **能** | 这正是"误删"的高发区 |
| `~/.ssh` `~/.config` `~/.local` | **能** | 密钥、token、浏览器配置 |
| `~/` 里挂着的 `/mnt/c/...`（WSL） | **能** | 9p 挂载，权限模型和 Linux 不同，风险更高 |

所以"隔离"的实际目标不是保护 `/usr`（本来也删不掉），而是：

1. **把 `$HOME` 从 agent 的视野里拿掉**，只留工作区；
2. **让越界访问给出明确错误**（EACCES / EROFS / ENOENT），而不是"碰巧没权限"；
3. **顺手掐掉外联**（`curl | bash` 的前提是有网）；
4. **限住资源**（fork bomb、内存）。

## 1.2 候选方案逐项对比

### 总表

| 方案 | 能否挡住 `rm -rf /*` / `rm -rf ~` | 内核/发行版要求 | 需要 root？ | 配置成本 | 适配"agent 读写自己工作区" | 挡 `curl \| bash` | 挡 fork bomb | 挡写 `/etc` |
|---|---|---|---|---|---|---|---|---|
| **bubblewrap** | **能**：`--ro-bind / /` + `--tmpfs /home`，越界写返回 `EROFS`，不可见路径 `ENOENT` | 需 unprivileged userns（3.8+）；Ubuntu 24.04+ 默认 AppArmor 限制 userns，需 profile | 否 | 低（一条命令） | 极好：`--bind` 工作区即可 | 能：`--unshare-net` | 部分：配合 `prlimit`/cgroup | 能（`EROFS`） |
| **Landlock** | **能**：未列入白名单的路径一律 `EACCES`，**含读** | 5.13+（ABI 1）；读+写+删要 ABI 1，`REFER` 要 5.19，`TRUNCATE` 要 6.2，网络要 6.7，信号隔离要 6.12 | 否 | 中（要写几十行调用代码，或用现成工具） | 极好：白名单模型天然匹配 | 能：handle 网络权限且不加规则 = 全部 `EACCES` | 否 | 能（`EACCES`） |
| **firejail** | 视 profile：`--private=DIR` 能，默认 profile 只管部分应用 | 3.x+；SUID 安装 | 安装要 root，运行不要 | 中（要维护 profile） | 一般：面向桌面应用，不是为"任意工作区"设计 | 能（`--net=none`） | 部分（`--rlimit-nproc`） | 能（`--read-only`） |
| **nsjail** | **能**：mount namespace + 只读根 | 需 userns 或 root；Kafel seccomp | 通常要 root（或 userns） | 高（protobuf 配置） | 好，但偏重 | 能 | 能（cgroup） | 能 |
| **seccomp / seccomp-bpf** | **不能**。只能按 syscall 过滤，看不到路径；禁掉 `unlinkat` 就连正常工作也做不了 | 3.5+ | 否 | 高（要么写 BPF，要么用 libseccomp） | 差：粒度错位 | 只能靠禁 `execve`/`socket`，副作用大 | **能**（禁 `clone`/`fork`） | 只能靠禁 `open` 写，副作用大 |
| **systemd-run（transient unit）** | **能**：`ProtectSystem=strict` + `ReadOnlyPaths=` + `InaccessiblePaths=` | systemd 232+；**用户实例也支持**（本机 261 实测） | 否（`--user`） | 低（一条命令） | 好：`BindPaths=` 精确挂载 | 能（`PrivateNetwork=yes`） | 能（`TasksMax=`，cgroup） | 能（`EROFS`/`EACCES`） |
| **rootless podman** | 能：容器内 `rm -rf /` 只毁容器 rootfs；bind 挂载的工作区仍可写 | 需 `/etc/subuid`+`newuidmap`，userns | 否（首次配置要 root 装包） | 中 | 好，但每个命令一个容器有启动开销 | 能（`--network=none`） | 能（`--pids-limit`） | 能（容器内是"另一个 /"） |
| **rootless docker** | 同上，但配置更麻烦 | 同 podman + rootless 安装脚本 | 否 | 高 | 同上 | 能 | 能 | 能 |
| **gVisor (runsc)** | 能：用户态内核拦截 syscall，容器内怎么删都只影响 rootfs | 需 KVM 或 ptrace 平台；arm64 支持较新 | 通常要 root 装 runtime；rootless 模式受限 | 高 | 一般：为"跑不受信代码"设计，路径白名单不是它的强项 | 能（`--network=none`） | 能 | 能 |
| **sudo 细粒度策略** | **不能**。sudo 给的是完整 root；`sudoers` 限制命令参数可被 symlink/编辑器/`-exec` 绕过 | 无 | 是 | 中 | 极差：等于把 root 交给 agent | 不能 | 不能 | 不能（它就是要写 /etc） |
| **rbash** | **不能**。`vi`/`less`/`python -c`/`cp /bin/sh` 都能逃逸 | 无 | 否 | 低 | 极差 | 不能 | 不能 | 不能 |
| **AppArmor** | 能，但profile 是按"可执行文件路径"绑定的，同一份 bash 无法按调用动态换路径白名单 | Ubuntu 默认带；WSL 里**未启用**（实测） | 加载 profile 要 root | 高（每个场景一份 profile） | 差：路径要写死在 profile 里，工作区一变就要改 | 能（网络规则较粗） | 不能 | 能 |

### 逐项说明

**bubblewrap（bwrap）**
- 原理：创建空 mount namespace，根是私有 tmpfs，用 `--ro-bind`/`--bind`/`--tmpfs` 手工搭出根文件系统，再 `pivot_root` 进去。默认**不保留任何 capability**（man: "By default no caps are left in the sandboxed process"）。
- 对 `rm -rf /*`：根是只读绑定，删除返回 `EROFS`；私有 `--tmpfs /home` 让 `~/.ssh` 直接不存在（`ENOENT`）。
- 关键坑：`--unshare-all` 用的是 `--unshare-user-try`，若系统禁了 userns，bwrap **静默降级**（不建 user ns），此时语义会变，建议显式 `--unshare-user` + `--disable-userns`。
- Ubuntu 23.10 起默认 `kernel.apparmor_restrict_unprivileged_userns=1`，裸机上 bwrap 可能报 `setting up uid map: Permission denied`，需要给 `/usr/bin/bwrap` 装 AppArmor profile。**WSL 里没这个问题**：本机实测该 sysctl 不存在、AppArmor 也没进 LSM 列表，`unshare -Ur` 直接可用。
- 挡 `curl | bash`：`--unshare-net` 之后只剩 loopback，DNS 直接失败（实测）。

**Landlock**
- 原理：进程给自己（及后代）套一层"只能更严"的规则；规则白名单之外一律拒绝，返回 `EACCES`（不是 `EPERM`，也不是 `EROFS`）。
- 覆盖**读**：`READ_FILE`/`READ_DIR` 也在管辖内，所以 `cat ~/.ssh/id_rsa` 直接 `Permission denied`（实测）。这是它相对 bwrap 只读绑定的最大优势——只读绑定挡写不挡读。
- 也覆盖 `/proc` `/sys` `/dev`（实测：不加白名单时 `cat /proc/self/status` 就 `EACCES`）——所以配置里必须显式放行 `/proc`、`/dev`，否则连 `ls` 都会瘸。
- 网络：handle 了 `NET_CONNECT_TCP`/`NET_BIND_TCP` 却一条规则都不加，等于全禁（实测 DNS/curl 全失败）。ABI 4+（6.7+）支持；ABI 10 起加 UDP。
- 硬限制（文档明确写了，必须知道）：
  - **沙箱之前已打开的 fd 不受管**——如果 agent 主进程先 `open()` 了 `~/.config`，再 fork 出被 Landlock 限制的子进程，那个 fd 仍然能写。
  - 不能"放宽"，只能叠加更严。
  - OverlayFS 的层与合并视图各自独立，规则不互通。
- 版本对照（文档）：ABI 1=5.13（基础）／2=5.19（`REFER`，跨目录 rename/link）／3=6.2（`TRUNCATE`）／4=6.7（TCP）／5=6.10（`IOCTL_DEV`）／6=6.12（信号与抽象 socket 作用域）；再往上还有日志、`TSYNC`、UDP、capability/namespace 规则等新 ABI。**本机 ABI = 7**（实测）。

**firejail**
- SUID 程序，能力很全（namespace + seccomp + 白名单 + `--private`），但定位是"给桌面应用套现成 profile"。给 agent 用意味着你要自己维护一份 profile，且 SUID 二进制本身是攻击面（历史上 CVE 不少）。Ubuntu 仓库里能装，但**没有预装**（实测 `firejail: MISSING`）。
- 2025 年起加了实验性 Landlock 支持（0.9.74 release notes），说明作者也认为纯 namespace 不够。

**nsjail**
- Google 出品，protobuf 配置，mount 白名单、Kafel seccomp、cgroup 都支持，工程质量高。代价是**配置重**、通常要 root 或 userns，更适合"跑批处理/CTF/多租户服务"，不适合"每条命令起一个"。

**seccomp / seccomp-bpf**
- 只能看 syscall 号和参数寄存器，**看不到路径**（路径在用户态内存里，TOCTOU 无解）。想"只允许删工作区"做不到；只能"禁掉 unlink/unlinkat"，那 `rm` 正常工作也没了。
- 真正合适的用途是**补刀**：禁 `mount`、`ptrace`、`bpf`、`keyctl`、`unshare`、`io_uring_setup`，禁 `clone` 挡 fork bomb，禁 `socket` 挡外联。bwrap 的 `--seccomp FD` 就是干这个的（要喂编译好的 cBPF）。
- 结论：**seccomp 是隔离的配角，不是主角。**

**systemd-run（transient unit）**
- 本机实测（systemd 261）：
  - `systemd-run --user --pipe --wait -p ProtectSystem=strict ...` → 写 `/etc` 报 `Read-only file system`；写 `$HOME` 仍可（未开 `ProtectHome`）。
  - `-p InaccessiblePaths=/home` → `ls /home` 报 `Permission denied`。
  - `-p TasksMax=32` → 单元 cgroup 的 `pids.max` 确实是 32。
  - **`--scope` 不接受挂载类属性**：`systemd-run --user --scope -p ProtectSystem=strict` 直接报 `Unknown assignment: ProtectSystem=strict`。要用服务单元（默认就是）。
- 优点：不用装任何东西，日志自动进 journal（天然审计），`TasksMax` 顺手限 fork bomb。
- 缺点：粒度是"整个单元"，要精确控制"只允许 `~/work`"得靠 `BindPaths=`/`ReadOnlyPaths=` 组合；而且它仍然是**同一个 uid**，Landlock 那种"读也拒绝"做不到。

**rootless podman / docker**
- podman rootless：容器里 `rm -rf /` 只毁容器层；工作区用 `-v ~/work:/work:rw` 挂进去照常读写；`--read-only` 让根只读；`--network=none` 断网；`--pids-limit` 限进程。
- 代价：要 `/etc/subuid`、`/etc/subgid`、`newuidmap`（首次配置要 root），每条命令起容器有几百毫秒开销；镜像/存储占空间。
- 本机没装 podman，`docker` 指向的是 **Windows 侧 Docker Desktop CLI**（`/mnt/c/Program Files/Docker/...`），容器跑在 Docker Desktop 的 VM 里，挂 WSL 的 `/home` 需要额外配置——**不适合当"每条命令的隔离层"**。

**gVisor (runsc)**
- 用户态内核（Sentry）拦截 syscall，安全边界最硬，但它是"防容器逃逸/防内核漏洞"，不是"防误删"。工作区照样是 bind 进去的可写目录，`rm -rf /work/*` 一样没。启动开销大、要 KVM 或 ptrace、配置重。**对本场景是过度设计。**

**sudo 细粒度策略 / rbash / AppArmor**
- sudo：给的是完整 root。`sudoers` 里限制命令参数（`/bin/rm /home/*`）历史上有无数绕过（`sudo rm -rf -- /`、`-exec`、编辑器 `:!sh`、`LD_PRELOAD` 被 env_reset 挡住但也别赌）。**结论：agent 永远不该有 sudo。**
- rbash：`vi` → `:!bash`；`less` → `!bash`；`python -c 'import os;os.system("/bin/sh")'`；`cp /bin/sh /tmp/x`。**当隔离用等于没有。**
- AppArmor：路径型 MAC，能力强，但 profile 是**按可执行文件路径**绑定的，且路径要写死。要让"同一个 bash 有时能写 `~/work`、有时不能"，只能给每次调用生成 profile 再 `aa-exec`，运维成本高于收益。**WSL 里 AppArmor 根本没启用**（实测 `/sys/module/apparmor` 存在但 `lsm=` 列表里没有它），所以这条在你的 WSL 环境里直接出局。

## 1.3 推荐方案

### 组合：bwrap（看得见什么）+ Landlock（能不能碰）+ prlimit（能开多少进程）

分工要说清楚，否则两层策略打架（我实测就踩了：bwrap 挂了可写 `/tmp`，Landlock 没放行 `/tmp`，结果写 `/tmp` 报 `EACCES`——两层都放行才行）。

```
┌─ agent 进程（uid 1000，无 root）────────────────────────┐
│  agentbox.sh                                            │
│    └─ bwrap：私有 /home、只读根、私有 /tmp、断网、丢 cap │
│         └─ prlimit --nproc=512                          │
│              └─ ll_sandbox.py（Landlock 白名单）         │
│                   └─ bash -c "agent 的命令"             │
└─────────────────────────────────────────────────────────┘
```

实测效果（Ubuntu 26.10 / 内核 6.18 / bwrap 0.12 / Landlock ABI 7）：

| 测试 | 结果 |
|---|---|
| `echo hi > t1.txt`（工作区） | 成功，宿主机 `~/work/t1.txt` 可见（同一份文件） |
| `rm -rf /*` | 全部失败，工作区与家目录毫发无损 |
| `echo x > /etc/pwn` | `Read-only file system` |
| `cat ~/.ssh/id_test` | `No such file or directory`（私有 `/home`） |
| `ls /mnt` | `No such file or directory`（Windows 盘不可见） |
| `curl https://example.com` | `Could not resolve host` |
| `id` / `CapEff` / `NoNewPrivs` | uid 1000；`CapEff=0`；`NoNewPrivs=1` |
| `git --version` / `node -v` / `python3 -V` | 2.55.0 / v24.21.0 / 3.14.8，工具链正常 |
| `exit 7` | 退出码原样透传 |

### 最小可用配置（可直接抄）

**① `~/.agent/agentbox.sh`**

```bash
#!/usr/bin/env bash
# agentbox —— 无 root 的 AI agent 执行器
#   用法: agentbox '要执行的 shell 命令'
set -euo pipefail

WORK=${AGENT_WORK:-$HOME/work}
AHOME=${AGENT_HOME:-$HOME/.agent}
LL_HOST=${AGENT_LANDLOCK:-$AHOME/ll_sandbox.py}
LL_SANDBOX=/home/agent/.agent/$(basename "$LL_HOST")   # 沙箱内路径，别用宿主路径
mkdir -p "$WORK" "$AHOME"

BWRAP_ARGS=(
  --ro-bind /usr /usr
  --ro-bind-try /usr/local /usr/local     # node/pnpm 常装在这
  --ro-bind /etc /etc
  --symlink usr/bin /bin
  --symlink usr/sbin /sbin
  --symlink usr/lib /lib
  --symlink usr/lib64 /lib64
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --tmpfs /home                            # 关键：家目录整体消失
  --dir /home/agent
  --bind "$WORK"   /home/agent/work        # 唯一的工作区入口
  --bind "$AHOME"  /home/agent/.agent      # agent 自己的屋子
  --chdir /home/agent/work
  --unshare-all                            # user/ipc/pid/net/uts/cgroup
  --disable-userns                         # 禁止再套 userns 翻墙
  --die-with-parent                        # 父进程死则全死，防孤儿
  --new-session                            # 断开控制终端，防 TIOCSTI
  --cap-drop ALL
  --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  --setenv HOME /home/agent
  --setenv LANG C.UTF-8
  --setenv LC_ALL C.UTF-8
  --setenv TERM dumb
  --setenv AGENT_SANDBOX 1
)

CMD=("$@")
[ $# -eq 1 ] && CMD=(/bin/bash -c "$1")

if [ -f "$LL_HOST" ]; then
  exec bwrap "${BWRAP_ARGS[@]}" \
    prlimit --nproc=512 -- \
    /usr/bin/python3 "$LL_SANDBOX" \
      --rw /home/agent/work --rw /home/agent/.agent \
      --rw /tmp --ro /proc --rw /dev \
      --ro /usr --ro /usr/local --ro /etc \
      --ro /bin --ro /sbin --ro /lib --ro /lib64 \
      -- "${CMD[@]}"
else
  exec bwrap "${BWRAP_ARGS[@]}" prlimit --nproc=512 -- "${CMD[@]}"
fi
```

**② `~/.agent/ll_sandbox.py`**（Landlock 白名单执行器，无第三方依赖）

```python
#!/usr/bin/env python3
"""ll_sandbox.py --rw DIR [--rw DIR ...] [--ro DIR ...] -- CMD [ARGS...]
未列出的路径一律 EACCES（含读）。需要内核 5.13+。"""
import ctypes, os, sys

libc = ctypes.CDLL(None, use_errno=True)
SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446
VERSION = 1
RULE_PATH_BENEATH = 1

A = {"EXECUTE": 1, "WRITE_FILE": 2, "READ_FILE": 4, "READ_DIR": 8, "REMOVE_DIR": 16,
     "REMOVE_FILE": 32, "MAKE_CHAR": 64, "MAKE_DIR": 128, "MAKE_REG": 256, "MAKE_SOCK": 512,
     "MAKE_FIFO": 1024, "MAKE_BLOCK": 2048, "MAKE_SYM": 4096, "REFER": 8192,
     "TRUNCATE": 16384, "IOCTL_DEV": 32768, "RESOLVE_UNIX": 65536}
ALL_FS = sum(v for k, v in A.items() if k != "RESOLVE_UNIX")


def abi_version():
    r = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint(VERSION))
    if r < 0:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))
    return int(r)


def make_ruleset(abi):
    fs = ALL_FS
    net = 0b11                      # BIND_TCP | CONNECT_TCP，但不加规则 => 全禁
    if abi >= 10:
        net |= 0b1100               # UDP
    scoped = 0
    if abi < 2: fs &= ~A["REFER"]
    if abi < 3: fs &= ~A["TRUNCATE"]
    if abi < 4: net = 0
    if abi < 5: fs &= ~A["IOCTL_DEV"]
    if abi >= 6: scoped = 0b11      # 抽象 unix socket | 信号
    if abi < 9: fs &= ~A["RESOLVE_UNIX"]
    size = 32 if abi >= 12 else 24 if abi >= 6 else 16 if abi >= 4 else 8
    buf = ctypes.create_string_buffer(size)
    ctypes.memmove(buf, ctypes.byref(ctypes.c_uint64(fs)), 8)
    if size >= 16: ctypes.memmove(ctypes.byref(buf, 8), ctypes.byref(ctypes.c_uint64(net)), 8)
    if size >= 24: ctypes.memmove(ctypes.byref(buf, 16), ctypes.byref(ctypes.c_uint64(scoped)), 8)
    fd = libc.syscall(SYS_CREATE, buf, ctypes.c_size_t(size), ctypes.c_uint(0))
    if fd < 0:
        e = ctypes.get_errno()
        raise OSError(e, "landlock_create_ruleset: " + os.strerror(e))
    return fd, fs


class PathBeneath(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def allow(rs, path, access):
    if not (os.path.isdir(path) or os.path.isfile(path)):
        print(f"[ll] skip non-regular path: {path}", file=sys.stderr)   # 设备/链接会 EINVAL
        return
    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        attr = PathBeneath(ctypes.c_uint64(access).value, fd)
        if libc.syscall(SYS_ADD, ctypes.c_int(rs), ctypes.c_int(RULE_PATH_BENEATH),
                        ctypes.byref(attr), ctypes.c_uint(0)) < 0:
            e = ctypes.get_errno()
            raise OSError(e, f"landlock_add_rule({path}): " + os.strerror(e))
    finally:
        os.close(fd)


def main(argv):
    rw, ro, i = [], [], 1
    while i < len(argv) and argv[i] != "--":
        if argv[i] == "--rw": i += 1; rw.append(argv[i])
        elif argv[i] == "--ro": i += 1; ro.append(argv[i])
        else: break
        i += 1
    if i < len(argv) and argv[i] == "--": i += 1
    cmd = argv[i:]
    if not cmd:
        print(__doc__); return 2

    abi = abi_version()
    rs, fs = make_ruleset(abi)
    RW = (A["READ_FILE"] | A["READ_DIR"] | A["WRITE_FILE"] | A["TRUNCATE"] | A["MAKE_REG"] |
          A["MAKE_DIR"] | A["MAKE_SYM"] | A["MAKE_FIFO"] | A["MAKE_SOCK"] | A["REMOVE_FILE"] |
          A["REMOVE_DIR"] | A["REFER"] | A["EXECUTE"])
    RO = A["READ_FILE"] | A["READ_DIR"] | A["EXECUTE"]
    for p in rw:
        if os.path.exists(p): allow(rs, p, RW & fs)
    for p in ro:
        if os.path.exists(p): allow(rs, p, RO & fs)
    libc.prctl(38, 1, 0, 0, 0)      # PR_SET_NO_NEW_PRIVS
    if libc.syscall(SYS_RESTRICT, ctypes.c_int(rs), ctypes.c_uint(0)) < 0:
        e = ctypes.get_errno()
        raise OSError(e, "landlock_restrict_self: " + os.strerror(e))
    os.close(rs)
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

**③ 接到 agent 上**

```bash
# 把 agent 的 shell 工具指向 agentbox
export AGENT_SHELL_WRAPPER="$HOME/.agent/agentbox.sh"
# 或直接改 DSH 的 shell 执行器：
#   command = ["/home/user/.agent/agentbox.sh", cmdline]
```

要点：
- **一条命令一个进程**，每次重新建 namespace，别想着"进沙箱后一直待着"——那样 fd 会泄漏出沙箱语义。
- 工作区路径**必须**同时出现在 bwrap `--bind` 和 Landlock `--rw` 里，少一处就是 EACCES（实测踩坑）。
- `--ro-bind /usr/local` 别忘，node/pnpm 常在那儿。

### 如果 userns 不可用：只用 Landlock

```bash
exec prlimit --nproc=512 -- python3 ~/.agent/ll_sandbox.py \
  --rw "$HOME/work" --rw "$HOME/.agent" --rw /tmp --ro /proc --rw /dev \
  --ro /usr --ro /etc --ro /bin --ro /lib --ro /lib64 \
  -- /bin/bash -c "$1"
```

- 优点：不需要 userns，不需要 root，语义就是你要的 `EACCES`，**读也拦**。
- 缺点：`/mnt/c`（WSL 的 Windows 盘）还在，只是读不了写不了；网络只能靠"handle 且不加规则"全禁，没法只放行某个域名；`/tmp` 是全局共享的（不是私有 tmpfs）。
- 实测：`rm -f ~/canary.txt` → `Permission denied`；`head ~/.bashrc` → `Permission denied`；`getent hosts example.com` → 失败；工作区读写正常。

## 1.4 关于 `curl | bash` 与 fork bomb

- **`curl | bash` 的本质是"net + exec"两件事**，只堵一件就够：
  - 断网（bwrap `--unshare-net` / podman `--network=none` / Landlock 网络全禁）——最彻底；
  - 或者禁 `execve`（seccomp）——但 agent 就没法跑任何命令了，不现实；
  - 或者 egress 代理白名单（工程量大，但能保住"能装包"）。
  - **不要**指望"检测命令里有没有 `curl`"——`python -c`、`node -e`、`git clone` 都能下载。
- **fork bomb**：
  - `prlimit --nproc=N` 是 **per-UID** 的，会连带限制你自己（包括 DSH 主进程）——所以 N 别设太小。实测 `prlimit --nproc=64` 时 bash 自己就开始 `fork: retry: Resource temporarily unavailable`。
  - 更精准的是 cgroup：`systemd-run --user -p TasksMax=32`，实测单元里 `pids.max` 就是 32，只影响这个单元。
  - bwrap 里没有直接设 rlimit 的选项，所以要在外面套 `prlimit`，或整体放进一个 systemd 单元。
  - 注意：`( : & )` 这种"秒起秒退"的循环不会触发 `RLIMIT_NPROC`（进程数不累积），真正的 fork bomb 会。

## 1.5 隔离 ≠ 审计：命令记录怎么做

| 手段 | 需要 root | 覆盖范围 | 说明 |
|---|---|---|---|
| **agent 自身日志**（DSH 的 tool call 记录） | 否 | 它自己发起的每条命令 | **最该先做**：记 `cmdline + cwd + 退出码 + 耗时 + 输出摘要`，落独立文件并 append-only |
| `systemd-run --user --unit=agent-$(uuid)` | 否 | 每条命令一个单元 | 顺带得到 journal 记录（时间、退出码、cgroup），`journalctl --user -u 'agent-*'` 可查 |
| bash `DEBUG` trap / `PROMPT_COMMAND` | 否 | 该 shell 及其子 shell | 容易漏（`exec`、`env -i`、非 bash 子进程） |
| `script -q -c "cmd" out.log` | 否 | 单条命令的完整 tty 输出 | 适合留"现场"，但拿到的是终端流不是结构化记录 |
| `strace -f -e trace=execve -o log` | 否（对自己子进程） | 所有 exec | `yama/ptrace_scope=1` 下只能跟踪自己的后代，正好够用；开销大 |
| **auditd** `-a always,exit -F arch=b64 -S execve -k agent_exec` | **是** | 全系统 | 最完整，WSL 里要自己装并让 auditd 跑起来 |
| eBPF / bpftrace | **是**（本机 `unprivileged_bpf_disabled=2`） | 全系统 | 信息最全，运维成本最高 |

建议：**agent 层结构化日志（必须）+ systemd-run 单元（顺手）+ auditd（有 root 时补）**。三者互补：agent 日志告诉你"它想干什么"，auditd 告诉你"内核实际允许了什么"。

## 1.6 选型结论（一句话版）

| 场景 | 选它 |
|---|---|
| 单机、无 root、要"只许动工作区 + EACCES" | **bwrap + Landlock + prlimit**（本文方案） |
| 连 userns 都没有 | 只用 Landlock |
| 想少写代码、能接受 `EROFS` 而不是 `EACCES` | `systemd-run --user -p ProtectSystem=strict -p InaccessiblePaths=... -p BindPaths=... -p TasksMax=...` |
| 要跑完全不可信的第三方代码 | rootless podman（或 gVisor，若你已经在用容器编排） |
| 只要审计不要隔离 | auditd + agent 日志 |
| **别用** | sudo 细粒度、rbash、纯 seccomp、"检测危险命令字符串" |

---

# 问题 2：PowerShell → wsl.exe → bash 的传参

## 2.1 一条命令要过四道手

```
PowerShell 解析 → 拼成一条命令行字符串 → CreateProcess(wsl.exe)
   → wsl.exe 用自己的规则再切一次 → 交给 Linux 侧 init → bash 再解析
```

四道里任何一道都可能吃掉引号、展开变量、改编码。**PowerShell 5.1 在第二道是"拼字符串"而不是"传 argv 数组"**，这是万恶之源（文档明确写了："The parsed arguments are then joined into a single string with each parameter separated by a space"）。

## 2.2 实测：到底哪一层吃掉了什么

用 `/mnt/d/.../argv.sh`（`printf '<%s>\n' "$@"`）记录 bash 真正收到的 argv。

**① 逐参数加单引号（PS 5.1）**

```powershell
wsl.exe -d Ubuntu-26.10 -e /mnt/d/.../argv.sh C1 'a b' 'c|d' '$HOME' '"q"' "it's"
```

收到：

```
argc=6
argv[0]=<C1>      argv[1]=<a b>   argv[2]=<c|d>
argv[3]=<$HOME>   argv[4]=<q>     argv[5]=<it's>
```

→ 空格、`|`、`$`、单引号都活着；**只有 `"q"` 变成了 `q`**——双引号被 `wsl.exe` 吃了。

**② 引号残缺时更糟**

```powershell
wsl.exe ... C30 'a[1]' 'b*' 'c?' 'd"e' '"f"' '~' 'x;y' 'p&q' 'r>s' 't$u' 'g h'
```

收到：

```
argc=6
argv[0]=<C30>  argv[1]=<a[1]>  argv[2]=<b*>  argv[3]=<c?>
argv[4]=<de f ~ x;y p&q r>s t$u g>     ← 五个参数被黏成一个
argv[5]=<h>
```

→ **引号不配对时，`wsl.exe` 会把后续一大段并成一个参数**。这就是"参数里的空格被拆开/粘住"的真凶。

**③ 直接复现你的场景**

```powershell
wsl.exe -d Ubuntu-26.10 -e /bin/echo 'grep -E "a|b" file'
```

`/bin/echo` 收到：`grep -E a|b file` → 交给 bash 就是"grep 输出管道给 b"。**引号消失，管道成立。**

加反斜杠转义后：

```powershell
wsl.exe -d Ubuntu-26.10 -e /bin/echo 'grep -E \"a|b\" file'
```

收到：`grep -E "a|b" file` ✅（实测 grep 正确匹配 2 行）

**④ `-e` 与 `--` 的区别（实测）**

```powershell
wsl.exe -d $d -e /bin/echo 'echo $HOME $(id -u)'   # → echo $HOME $(id -u)   （原样，不展开）
wsl.exe -d $d --  /bin/echo 'echo $HOME $(id -u)'  # → echo /home/str1k3 1000 （被 shell 展开了）
```

- `-e` / `--exec`：直接 `execvp`，**不经过 shell**，`$`、`*`、`;` 都原样。
- `--`：把剩下的交给**默认 shell**（登录 shell），会做变量展开、通配、分号。
- 不带任何前缀（`wsl ls -la`）：等同 `--`，走 shell。

**⑤ 变量被 PowerShell 先展开**

```powershell
$HOME = C:\Users\ASUS
wsl -e bash -c "printf '%s\n' $HOME"     # → printf '%s\n' C:\Users\ASUS → 反斜杠又被 bash 吃掉 → C:UsersASUS
wsl -e bash -c 'printf "%s\n" "$HOME"'   # → 单引号保护，bash 自己展开 → /home/str1k3
```

## 2.3 PowerShell 5.1 vs 7.x

| 项 | PowerShell 5.1 | PowerShell 7.0–7.2 | PowerShell 7.3+ |
|---|---|---|---|
| 原生命令传参 | 拼字符串（Legacy） | 同 5.1 | `$PSNativeCommandArgumentPassing` 主流化，改用 `ProcessStartInfo.ArgumentList` |
| 默认值 | 无此变量 | `Windows`（Windows 平台） | `Windows`（Windows）/ `Standard`（非 Windows） |
| 字符串内嵌引号 | 会被吞/需转义 | 同左 | **Standard 模式下保留**（文档：`TestExe -echoargs $a 'c" "d'` 能拿到 `<c" "d>`） |
| 空字符串参数 | 丢失 | 丢失 | 保留 |
| `--%` | 有（3.0 起） | 有 | 有 |
| `$OutputEncoding` 默认 | **ASCII**（中文变 `?`） | UTF-8 | UTF-8 |
| 本机是否有 | ✅ 5.1.26100.9711 | — | 未安装 |

关键差异（文档）：
- 7.3 的 `Standard`/`Windows` 模式**只有** `cmd.exe`、`cscript.exe`、`wscript.exe`、`*.bat`、`*.cmd`、`*.js`、`*.vbs`、`*.wsf` 仍走 Legacy；`wsl.exe` 走新逻辑，**引号不再被 PowerShell 那一层吃掉**。
- 但注意：**`wsl.exe` 自己那一层照样吃引号**。所以"PS7 里就没事了"是错的——你只是少了一层伤害。
- 想在 PS7 里回到旧行为：`$PSNativeCommandArgumentPassing = 'Legacy'`。

> 结论：跨 5.1/7.x 通用的写法，必须假设"`wsl.exe` 会吃掉未转义的 `"`"。

## 2.4 编码：三个编码别搞混（实测字节）

| 通道 | 默认 | 症状 | 修法 |
|---|---|---|---|
| wsl.exe **自身**消息（`--version`/`--status`/报错） | **UTF-16LE**（实测字节 `57 00 53 00 4C 00…`） | 每个字符间夹空格 | `$env:WSL_UTF8=1`（实测变 UTF-8：`57 53 4C 20 E7 89 88…`） |
| 子进程 stdout | 原样 UTF-8 字节（实测 `E4 B8 AD E6 96 87…`） | PS 按 CP936/CP437 解码 → 乱码 | `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()` |
| PS 管道写给原生程序的 stdin | **ASCII**（5.1） | 中文变 `?`（实测 `3F 3F 3F 3F`），且每行补 `0D 0A` | `$OutputEncoding = [Text.UTF8Encoding]::new($false)`（实测变 `E4 B8 AD…`，但仍会补 CRLF） |

补充：
- `chcp 65001` 改的是控制台代码页，影响 `[Console]::OutputEncoding` 的初始值；在**重定向**场景下不起作用，别指望它。
- WSL 侧建议 `LANG=C.UTF-8` / `LC_ALL=C.UTF-8`（或 `zh_CN.UTF-8`），`locale` 不对时某些工具会按 latin-1 输出。
- `wsl.conf` 里**没有**编码开关；能设的是 `[boot] systemd=true`、`[interop] appendWindowsPath=false` 之类。编码要在 PowerShell 侧和 `LANG` 上解决。

## 2.5 WSLENV：环境变量怎么过去

默认**不过去**（实测 `$env:FOO='hello world'` 在 WSL 里看不到）。要显式登记：

```powershell
$env:WSLENV = 'MYDIR/p:MYLIST/l:ONLY_IN/u:ONLY_OUT/w'
```

| 标志 | 含义（文档） | 实测 |
|---|---|---|
| `/p` | 值按**路径**转换（`D:\x` ↔ `/mnt/d/x`） | `MYDIR=D:\fish-handoff\.tmp` → `/mnt/d/fish-handoff/.tmp` ✅ |
| `/l` | 值是**路径列表**（`;` 分隔），逐项转换 | `…\.tmp;…\logs` → `/mnt/d/…/.tmp:/mnt/d/…/logs` ✅ |
| `/u` | 只在"从 Win32 启动 WSL"时带上 | — |
| `/w` | 只在"从 WSL 启动 Win32"时带上 | — |

无 `/p` 时实测原样透传：`MYDIR=D:\fish-handoff\.tmp`。
注意 WSLENV 是**大小写敏感**的，且只在进程启动时快照——改完要重新起 `wsl.exe`。

## 2.6 传参方式可靠性排序

| 排名 | 方式 | 抗中文 | 抗引号 | 抗 `$`/`|` | 抗空格 | 备注 |
|---|---|---|---|---|---|---|
| ① | **写 .sh 文件 → `wsl -e bash /path/x.sh args`** | ✅ | ✅ | ✅ | ✅ | 唯一要求：**UTF-8 无 BOM + LF** |
| ② | **base64 内联** | ✅ | ✅ | ✅ | ✅ | 外层全是 ASCII，几乎不可能出错 |
| ③ | **`bash -s` 从 stdin 读** | ✅（需设 `$OutputEncoding`） | ✅ | ✅ | ✅ | 会多一个 CRLF，脚本里别依赖行尾 |
| ④ | `Start-Process -ArgumentList` 单串 | ✅ | 需手工 `\"` | ✅ | ✅ | 数组形式会被空格拆开（实测 `'a b'` → `a` `b`） |
| ⑤ | `--%` 停止解析 | ✅ | ✅ | ✅ | ✅ | 一次性字面命令可以；**不能**用变量、不能重定向、`%VAR%` 会被展开 |
| ⑥ | 裸 `wsl -e bash -c "…"` | ❌ | ❌ | ❌ | ❌ | 你现在踩的就是这个 |

### ① 脚本落地（推荐默认）

```powershell
$dir  = 'D:\fish-handoff\.tmp'
$path = Join-Path $dir 'job.sh'
$body = @'
set -euo pipefail
grep -E "a|b" "$1" | wc -l
echo "中文 OK: $HOME"
'@
# 关键：UTF-8 无 BOM + 强制 LF
$lf  = $body -replace "`r`n", "`n"
[IO.File]::WriteAllText($path, $lf, (New-Object Text.UTF8Encoding($false)))
wsl.exe -d Ubuntu-26.10 -e bash /mnt/d/fish-handoff/.tmp/job.sh '/mnt/d/fish-handoff/.tmp/g.txt'
```

三个必须注意的点（都实测过）：
- **CRLF**：`Set-Content` 默认写 CRLF，bash 会报 `$'\r': command not found`。用 `[IO.File]::WriteAllText` + `-replace` 强制 LF。
- **BOM**：UTF-8 BOM 会让 shebang 失效（`#!/bin/bash` 前面多个字符）。
- **不要在 `/mnt/c` 上跑热路径**：9p 文件系统慢，脚本放 `/mnt/d` 可以，工作区尽量在 ext4 上。

### ② base64（内联首选）

```powershell
$script = @'
grep -E "a|b" "$1" | wc -l
echo "中文 | 管道 | $HOME"
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
wsl.exe -d Ubuntu-26.10 -e bash -c "echo $b64 | base64 -d > /tmp/job.sh && bash /tmp/job.sh /mnt/d/fish-handoff/.tmp/g.txt"
```

实测输出：`中文 | 管道 | /home/str1k3 | '单引号' | "双引号" | 参数1=中文测试` —— 全须全尾。
外层只有 `[A-Za-z0-9+/=]`，**任何引号规则都伤不到它**。

### ③ `bash -s` 从 stdin

```powershell
$OutputEncoding = [Text.UTF8Encoding]::new($false)   # 不设就把中文变 ?
@'
echo "arg1=$1"
echo "中文 正常"
'@ | wsl.exe -d Ubuntu-26.10 -e bash -s -- 'A B'
```

实测：`arg1=A B` / `中文 正常`。缺点：stdin 被脚本占用，脚本里不能再读 stdin；PS 会给每行补 CRLF。

### ④ `Start-Process`

```powershell
$args = '-d Ubuntu-26.10 -e bash -c "grep -E \"a|b\" /path/g.txt | wc -l"'
Start-Process wsl.exe -ArgumentList $args -NoNewWindow -Wait
```

`-ArgumentList` 传数组时是**用空格 join**，含空格的元素会被拆开（实测）。要么给单串自己控制引号，要么别用。

### ⑤ `--%`

```powershell
wsl.exe -d Ubuntu-26.10 --% -e bash -c "echo $HOME"
```

`$HOME` 不被 PS 展开（实测输出 `/home/str1k3`），`|`、`;` 也不被 PS 解析。限制（文档）：只到行尾/管道符，不能接 PowerShell 变量，`%VAR%` 会被展开，`>` 重定向会当参数传进去。

## 2.7 现成工具

- **官方没有** WSL 专用的 PowerShell 模块；`wsl.exe` 就是全部 API。
- 真正有用的官方件：`wslpath`（路径互转）、`wsl --cd`（指定工作目录）、`WSLENV`、`wsl --shell-type`（较新版本支持 `Standard|Login|None`）。
- 社区有几个薄封装（`Wsl`/`PSWsl` 之类），价值主要在补全，解决不了本文的引号问题——因为它们最终还是要拼一条命令行。
- 想要"干净"，自己封一个函数即可（下面这个按 §2.6 的①+②实现）。

```powershell
function Invoke-Wsl {
    <#
      .SYNOPSIS  在 WSL 里执行一段 bash 脚本，规避 PowerShell/wsl.exe 的引号与编码问题
      .EXAMPLE   Invoke-Wsl -Script 'grep -E "a|b" "$1"' -Argument '/tmp/f.txt'
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Script,
        [string[]]$Argument = @(),
        [string]$Distribution = 'Ubuntu-26.10',
        [string]$User
    )
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
    $wslArgs = @('-d', $Distribution)
    if ($User) { $wslArgs += @('-u', $User) }
    $wslArgs += @('-e', 'bash', '-c', "echo $b64 | base64 -d > /tmp/.dsh-$$.sh && bash /tmp/.dsh-$$.sh `$@; rc=`$?; rm -f /tmp/.dsh-$$.sh; exit `$rc", 'dsh')
    $wslArgs += $Argument
    & wsl.exe @wslArgs
}
```

（`bash -c` 的 `$0`/`$@` 约定：脚本名占位 `dsh`，后面才是真正的参数。）

## 2.8 最佳实践：中文 + 引号 + `$` 变量 + 管道 同时出现

```powershell
# 1) 先把编码三件套设好（一次，放 profile 里）
$env:WSL_UTF8              = '1'
[Console]::OutputEncoding  = [Text.UTF8Encoding]::new($false)
$OutputEncoding            = [Text.UTF8Encoding]::new($false)

# 2) 脚本用 here-string 写（PS 单引号 here-string：不做任何展开）
$script = @'
set -euo pipefail
shopt -s nullglob
cd "$WORKDIR"
# 中文、引号、$变量、管道、正则竖线，全部原样
grep -E "错误|error" "$1" | sed -E 's/^[0-9:]+ +//' | sort | uniq -c | sort -rn | head -20
printf '%s\n' "完成：$PWD"
'@

# 3) base64 过桥，参数单独传（别拼进脚本字符串）
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
wsl.exe -d Ubuntu-26.10 -e bash -c "echo $b64 | base64 -d > /tmp/j.sh && WORKDIR=/home/user/work bash /tmp/j.sh /mnt/d/logs/app.log"

# 4) 环境变量走 WSLENV（路径记得 /p）
$env:WORKDIR = 'D:\fish-handoff'
$env:WSLENV  = 'WORKDIR/p'
```

**七条铁律**

1. 能在 Linux 侧落文件就别在命令行里拼脚本（§2.6 ①）。
2. 必须内联就用 base64（§2.6 ②）。
3. 用 `-e`，不要用 `--`——`--` 会过一遍登录 shell，`$`、`*`、`;` 全被展开。
4. PS 字符串一律用**单引号**；要用变量就先 `-f` 拼好，或者走 `WSLENV`。
5. 内层双引号必须写成 `\"`（PS 5.1/7 都要，因为吃它的是 `wsl.exe`）。
6. 中文：`$env:WSL_UTF8=1` + `[Console]::OutputEncoding` + `$OutputEncoding` + `LANG=C.UTF-8`，四个都要。
7. 脚本文件 UTF-8 无 BOM + LF；用 `[IO.File]::WriteAllText`，别用 `Set-Content`/`Out-File`。

**反面清单（一定会出事）**

- `wsl -e bash -c "grep -E "a|b" f"` —— 引号嵌套 + PS 展开，双重故障。
- `$cmd = "echo $HOME"; wsl -e bash -c $cmd` —— PS 先展开成 Windows 路径。
- `wsl ls -la | findstr x` —— 管道被 PS 解析，`findstr` 在 PS 侧执行（这条其实"能用"，但语义和你想的不一样）。
- `Set-Content x.sh "..."` 然后 `bash x.sh` —— CRLF。
- `wsl -e bash script.sh` 用的是相对路径时，会按"当前 Windows 目录映射进 WSL 后的路径"解析（往往是 `/mnt/c/Users/...`），不是你以为的家目录；用绝对路径或 `wsl --cd`。

---

# 附录 A：实测命令与关键输出

**A.1 环境探测（WSL 内）**

```
Linux 6.18.33.2-microsoft-standard-WSL2 x86_64 / Ubuntu 26.10
LSM: initializing lsm=capability,landlock,yama,safesetid,selinux,ima
landlock: Up and running.
/sys/kernel/security/lsm 不存在（securityfs 未挂载）
kernel.unprivileged_userns_clone / apparmor_restrict_unprivileged_userns 均不存在
unshare -U / -Ur / -Urm: OK ；unshare -n: 需 root
bwrap 0.12.0；firejail/nsjail/podman 未安装；docker 指向 Windows 侧
systemd 261；systemd-run --user 可用
sudo -n: 需要密码（本会话无 root）
Landlock ABI = 7
cgroup v2；root 与 user@1000.service 的 subtree_control 均为 "cpu memory pids"
```

**A.2 systemd-run（用户实例）**

```
$ systemd-run --user --pipe --wait -q -p ProtectSystem=strict /bin/bash -c 'touch /etc/__probe__'
touch: cannot touch '/etc/__probe__': Read-only file system
$ systemd-run --user --pipe --wait -q -p InaccessiblePaths=/home /bin/bash -c 'ls /home'
ls: cannot open directory '/home': Permission denied
$ systemd-run --user --scope -p ProtectSystem=strict /bin/bash -c 'echo x'
Unknown assignment: ProtectSystem=strict          ← scope 不支持挂载类属性
$ systemd-run --user -p TasksMax=32 --unit=probe-tm4 /bin/sleep 30
$ cat .../probe-tm4.service/pids.max
32
```

**A.3 bwrap**

```
$ bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all /bin/bash -c 'rm -rf /*'
rm: cannot remove '/bin': Read-only file system
rm: cannot remove '/boot': Read-only file system
...
$ bwrap ... --unshare-all /bin/bash -c 'ip addr; getent hosts example.com'
只有 lo；DNS 无输出
```

**A.4 Landlock（ABI 7）**

```
写 ~/work/t.txt          → OK
写 /tmp/ll_probe         → exit=1（EACCES）
读 ~/.bashrc             → Permission denied
删 ~/canary.txt          → Permission denied
touch /etc/ll_probe      → Permission denied
rm -rf /*                → 通配符无法展开（/ 不可读），什么也没删
cat /proc/self/status    → Permission denied（伪文件系统也受管）
getent hosts example.com → 失败；curl → Could not resolve host
mv work/a.txt ~/a.txt    → Permission denied（os error 13）
```

**A.5 agentbox 验收**

```
uid=1000(str1k3) ; pwd=/home/agent/work
写工作区 → 宿主机 ~/work/t1.txt 可见
rm -rf /* → 工作区完好
touch /etc/pwn → Read-only file system
cat ~/.ssh/id_test → No such file or directory
ls /mnt → No such file or directory
curl https://example.com → Could not resolve host
CapEff=0 ; NoNewPrivs=1
git 2.55.0 / node v24.21.0 / python 3.14.8 均可用
exit 7 → 退出码 7
```

**A.6 PowerShell 传参（PS 5.1.26100.9711）**

```
$OutputEncoding = us-ascii ; [Console]::OutputEncoding = utf-8 CP65001 ; chcp = 936
PSNativeCommandArgumentPassing 存在? False

-e /bin/echo 'grep -E "a|b" file'      → grep -E a|b file          （引号被吃）
-e /bin/echo 'grep -E \"a|b\" file'    → grep -E "a|b" file        （正确）
--  /bin/echo 'echo $HOME $(id -u)'    → echo /home/str1k3 1000    （被 shell 展开）
-e  /bin/echo 'echo $HOME $(id -u)'    → echo $HOME $(id -u)       （原样）

wsl --version 原始字节: 57 00 53 00 4C 00 20 00 ...   （UTF-16LE）
WSL_UTF8=1   原始字节: 57 53 4C 20 E7 89 88 ...       （UTF-8）
子进程输出   原始字节: 68 69 0A                       （原样透传）

管道喂 stdin（默认 ASCII）: echo 'C9 ??????'\r\n
设 $OutputEncoding=UTF8 后: echo 'C9 中文测试'\r\n
```

**A.7 WSLENV**

```
WSLENV=MYDIR/p:MYLIST/l → MYDIR=/mnt/d/fish-handoff/.tmp | MYLIST=/mnt/d/…/.tmp:/mnt/d/…/logs
WSLENV=MYDIR（无 /p）   → MYDIR=D:\fish-handoff\.tmp
未登记                   → 变量不可见
```

---

# 附录 B：参考链接

**隔离**

- Landlock 内核文档（ABI 版本、语义、fd 限制）：https://docs.kernel.org/userspace-api/landlock.html
- bwrap(1) man page（全部选项与默认值）：https://manpages.debian.org/testing/bubblewrap/bwrap.1.en.html
- seccomp 内核文档：https://docs.kernel.org/userspace-api/seccomp_filter.html
- systemd.exec（`ProtectSystem=`/`InaccessiblePaths=`/`ReadOnlyPaths=` 语义）：https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
- systemd-run：https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
- firejail 官网 / 版本说明（含 0.9.74 的实验性 Landlock 支持）：https://firejail.wordpress.com/
- nsjail：https://github.com/google/nsjail
- gVisor 文档：https://gvisor.dev/docs/
- rootless podman：https://docs.podman.io/en/latest/markdown/podman.1.html
- AppArmor 文档：https://gitlab.com/apparmor/apparmor/-/wikis/Documentation

**WSL / PowerShell**

- WSL 基础命令（`-e`/`--exec`、`--user`、`--cd`）：https://learn.microsoft.com/en-us/windows/wsl/basic-commands
- 跨文件系统与 WSLENV 标志 `/p /l /u /w`：https://learn.microsoft.com/en-us/windows/wsl/filesystems
- WSLENV 详解（官方博客）：https://devblogs.microsoft.com/commandline/share-environment-vars-between-wsl-and-windows/
- about_Parsing（原生命令拼字符串、`--%` 语义）：https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing
- PowerShell 7.3 新特性（`PSNativeCommandArgumentPassing` 主流化、改用 ArgumentList）：https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-73
- about_Preference_Variables（`$PSNativeCommandArgumentPassing` / `$OutputEncoding`）：https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables

---

# 附录 C：还需要你在真机上确认的

1. **裸机 Ubuntu（非 WSL）**：`kernel.apparmor_restrict_unprivileged_userns` 默认可能是 1，bwrap 会报 `setting up uid map: Permission denied`。确认方式：`sysctl kernel.apparmor_restrict_unprivileged_userns`，若是 1，给 bwrap 装 AppArmor profile 或临时 `sysctl -w ...=0`。
2. **树莓派 arm64**：Landlock 在 arm64 上同样走 syscall 444/445/446，ABI 取决于内核版本（Ubuntu 24.04 的 6.8 内核是 ABI 4/5，够用；但**没有 `TRUNCATE`** 就要注意 `creat()` 覆盖已有文件的行为）。用 `landlock_create_ruleset(NULL,0,VERSION)` 查一下实际值。
3. **内存/CPU 限制**：本文只用了 `prlimit --nproc`；要限内存得走 cgroup（`systemd-run --user -p MemoryMax=1G`，实测可用）或 `systemd-run --scope -p MemoryMax=...`。
4. **DSH 自己的 shell 执行路径**：确认它是 `bash -lc` 还是直接 `execvp`，以及是否会继承父进程已打开的 fd（Landlock 管不到这些 fd）。
