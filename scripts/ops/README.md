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

## 卸载

```bash
sudo rm /etc/sudoers.d/fish-workbench /usr/local/sbin/fish-ctl
```
