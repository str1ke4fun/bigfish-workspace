# 迁移记录：大肥鱼 → WSL Ubuntu 26.10

> 2026-11-02。原来的 `Ubuntu` 发行版被换成了 `Ubuntu-26.10`（x86_64），大肥鱼在 26.10 里重新装好并跑起来。
> 旧系统 `FishRecover`（24.04.4）**还在**，里面的东西没动，可以当备份。

## 现在是什么状态

| 项 | 值 |
|---|---|
| 默认发行版 | `Ubuntu-26.10`（`wsl --set-default` 已设） |
| dsh | 0.2.1-rc.5，装在 `/opt/dsh-x64`，`/usr/local/bin/dsh` 指向它 |
| node / pnpm | v24.21.0 / 11.28.5，在 `/usr/local` |
| 她的屋子 | `/home/str1k3/.dsh-fish`（36 个文件，13 MB，`events.jsonl` 112 行） |
| 工作区 | `/home/str1k3/.dsh-fish/home`（`workspace.json` 里指对了） |
| 插件 | `/home/str1k3/dsh-plugins/`（dsh-fish 0.6.0、dsh-wx 0.1.0、qq、speech） |
| profile | `~/.dsh/profiles/web`，两个插件已 `dsh plugin add link:` 注册 |
| 服务 | `dsh-web.service`（systemd，enabled + active，:8710） |
| 旧会话 | 从 FishRecover 搬来了 `~/.dsh/{sessions,media,storages}` |

访问：**双击 `scripts\打开大肥鱼.cmd`**（自动从日志里取当前 token 并开浏览器）。
手动：`http://127.0.0.1:8710/?token=<看 /home/str1k3/dsh-web.log 第一行>`

## 怎么装起来的（复现顺序）

```bash
# 1. 装 node + pnpm + dsh（x64，不需要 --os/--cpu，也不需要 --ignore-scripts）
sudo bash /mnt/d/fish-handoff/scripts/install-x64-wsl.sh

# 2. 补垫片 + 搬屋子/插件
sudo bash /mnt/d/fish-handoff/scripts/migrate-house.sh

# 3. 注册插件（必须用 str1k3 身份，HOME 要对）
su - str1k3 -c 'dsh plugin --profile web add link:/home/str1k3/dsh-plugins/dsh-fish-0.6.0'
su - str1k3 -c 'dsh plugin --profile web add link:/home/str1k3/dsh-plugins/dsh-wx'

# 4. 服务
sudo systemctl enable --now dsh-web
```

## 这次踩的坑（和卡上那套不一样）

1. **pnpm 11 默认不跑构建脚本**，`node-pty`/`koffi`/`sharp` 会缺原生绑定 → 必须 `dangerously-allow-all-builds=true`（写 `.npmrc` 或 `pnpm approve-builds`）。
   *注意*：`pnpm` 字段在 package.json 里已经不读了，pnpm 11 把设置搬去了 `.npmrc` / `pnpm-workspace.yaml`。
2. **`@deepseek-ai/cordis-plugin-group` 要单独装**（它没有 0.2.1-rc.5 这个版本线，用 latest 1.0.5），而且它的 peer 要老版 schemastery，必须带 `--config.auto-install-peers=false --config.strict-peer-dependencies=false`，否则 `ERR_PNPM_NO_MATCHING_VERSION`。
3. **`@deepseek-ai/dsh-environment` 仍然没有发布**，还是那个三行垫片（转接到 `dsh-launch-environment`）。
4. **systemd 的 `ExecStartPre` 不认单引号里的重定向**：`/bin/sh -c ': > log'` 会被拆成 5 个参数 → 用 `/usr/bin/truncate -s 0 /path`，并且**事先**把日志文件建好、chown 给 str1k3，否则 truncate 建出来的属主是 root。
5. **FishRecover 里那套 dsh（0.2.1-rc.3）不能直接拷**：`node bin.js --version` 直接 segfault（原生模块和当前系统对不上）。所以这次是干净重装的。

## 还没恢复的

- **dsh-mem**（微信流水账）：交接材料里就没这份源码，`dsh-wx` 加载时提示 `Cannot find module .../dsh-mem/lib/livewx.js`。微信通道能挂载，但读消息/自动回复这条链没通。
- **QQ 通道**：`dsh-onebot-qq` 装好了，但没跑 NapCat，没扫码，没登录态。
- **模型账户**：新系统没有 API 凭据，UI 能开，但要先在设置里配模型账户才能真正说话。
- **B 站 cookie**：`owner.json` 跟着屋子过来了，cookie 有没有过期没验证。

## 回滚

- 想回到旧系统：`wsl --set-default FishRecover`，它还在，东西没动。
- 26.10 里的东西全在 `/opt/dsh-x64` 和 `/home/str1k3`，删这两个目录就等于清空（但别用 `rm -rf`，先 `mv` 到别处）。
