#!/usr/bin/env python3
"""
ll_sandbox.py —— 一个不依赖 root、不依赖 user namespace 的 Landlock 白名单沙箱。
用法:
    ll_sandbox.py --rw DIR [--rw DIR ...] [--ro DIR ...] [--net none|all] -- CMD [ARGS...]
默认策略: 未列出的路径一律 EACCES（含读）。
"""
import ctypes, os, sys, errno

libc = ctypes.CDLL(None, use_errno=True)
SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446
VERSION = 1
RULE_PATH_BENEATH = 1

A = {
    "EXECUTE": 1 << 0, "WRITE_FILE": 1 << 1, "READ_FILE": 1 << 2, "READ_DIR": 1 << 3,
    "REMOVE_DIR": 1 << 4, "REMOVE_FILE": 1 << 5, "MAKE_CHAR": 1 << 6, "MAKE_DIR": 1 << 7,
    "MAKE_REG": 1 << 8, "MAKE_SOCK": 1 << 9, "MAKE_FIFO": 1 << 10, "MAKE_BLOCK": 1 << 11,
    "MAKE_SYM": 1 << 12, "REFER": 1 << 13, "TRUNCATE": 1 << 14, "IOCTL_DEV": 1 << 15,
    "RESOLVE_UNIX": 1 << 16,
}
ALL_FS = 0
for k, v in A.items():
    if k != "RESOLVE_UNIX":
        ALL_FS |= v


def abi_version():
    r = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint(VERSION))
    if r < 0:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))
    return int(r)


def make_ruleset(abi):
    handled_fs = ALL_FS
    handled_net = (1 << 0) | (1 << 1)  # BIND_TCP | CONNECT_TCP
    if abi >= 10:
        handled_net |= (1 << 2) | (1 << 3)  # BIND_UDP | CONNECT_SEND_UDP
    scoped = 0
    if abi < 2:
        handled_fs &= ~A["REFER"]
    if abi < 3:
        handled_fs &= ~A["TRUNCATE"]
    if abi < 4:
        handled_net = 0
    if abi < 5:
        handled_fs &= ~A["IOCTL_DEV"]
    if abi >= 6:
        scoped = (1 << 0) | (1 << 1)  # ABSTRACT_UNIX_SOCKET | SIGNAL
    if abi < 9:
        handled_fs &= ~A["RESOLVE_UNIX"]
    if abi >= 12:
        size = 32
    elif abi >= 6:
        size = 24
    elif abi >= 4:
        size = 16
    else:
        size = 8
    buf = ctypes.create_string_buffer(size)
    ctypes.memmove(buf, ctypes.byref(ctypes.c_uint64(handled_fs)), 8)
    if size >= 16:
        ctypes.memmove(ctypes.byref(buf, 8), ctypes.byref(ctypes.c_uint64(handled_net)), 8)
    if size >= 24:
        ctypes.memmove(ctypes.byref(buf, 16), ctypes.byref(ctypes.c_uint64(scoped)), 8)
    fd = libc.syscall(SYS_CREATE, buf, ctypes.c_size_t(size), ctypes.c_uint(0))
    if fd < 0:
        e = ctypes.get_errno()
        raise OSError(e, "landlock_create_ruleset: " + os.strerror(e))
    return fd, handled_fs


class PathBeneath(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def allow(ruleset_fd, path, access):
    st = os.stat(path)
    if not (os.path.isdir(path) or os.path.isfile(path)):
        # Landlock 只能对目录或普通文件下规则（字符设备/符号链接会 EINVAL）
        print(f"[ll] skip non-regular path: {path}", file=sys.stderr)
        return
    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        attr = PathBeneath(allowed_access=ctypes.c_uint64(access).value, parent_fd=fd)
        r = libc.syscall(SYS_ADD, ctypes.c_int(ruleset_fd), ctypes.c_int(RULE_PATH_BENEATH),
                         ctypes.byref(attr), ctypes.c_uint(0))
        if r < 0:
            e = ctypes.get_errno()
            raise OSError(e, f"landlock_add_rule({path}): " + os.strerror(e))
    finally:
        os.close(fd)


def main(argv):
    rw, ro, net = [], [], "none"
    i = 1
    while i < len(argv) and argv[i] != "--":
        a = argv[i]
        if a == "--rw":
            i += 1; rw.append(argv[i])
        elif a == "--ro":
            i += 1; ro.append(argv[i])
        elif a == "--net":
            i += 1; net = argv[i]
        else:
            break
        i += 1
    if i < len(argv) and argv[i] == "--":
        i += 1
    cmd = argv[i:]
    if not cmd:
        print(__doc__); return 2

    abi = abi_version()
    rs, handled_fs = make_ruleset(abi)
    RW = (A["READ_FILE"] | A["READ_DIR"] | A["WRITE_FILE"] | A["TRUNCATE"] | A["MAKE_REG"] |
          A["MAKE_DIR"] | A["MAKE_SYM"] | A["MAKE_FIFO"] | A["MAKE_SOCK"] | A["REMOVE_FILE"] |
          A["REMOVE_DIR"] | A["REFER"] | A["EXECUTE"])
    RO = A["READ_FILE"] | A["READ_DIR"] | A["EXECUTE"]
    for p in rw:
        if os.path.exists(p):
            allow(rs, p, RW & handled_fs)
    for p in ro:
        if os.path.exists(p):
            allow(rs, p, RO & handled_fs)
    # 注意：/proc /sys /dev 不列入白名单（见实测结果）
    ctypes.CDLL(None).prctl(38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
    r = libc.syscall(SYS_RESTRICT, ctypes.c_int(rs), ctypes.c_uint(0))
    if r < 0:
        e = ctypes.get_errno()
        raise OSError(e, "landlock_restrict_self: " + os.strerror(e))
    os.close(rs)
    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        print(f"exec failed: {e}", file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main(sys.argv))
