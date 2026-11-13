# 新一轮落地部署 Runbook（2026-11-13）

> 这是**待执行**的部署清单，不是已执行记录。每一步都需要用户针对本次操作明确批准。
> 代码分支：`feat/new-round-2026-11-13`，worktree `/home/str1k3/src/bigfish-workspace-newround`。

## 0. 已完成的本地检查

- `dsh-fish`：1059 tests / pass 1059 / fail 0
- `dsh-wx`：91 / 91 / 0
- `dsh-bili`：32 / 32 / 0
- `workbench`：109 / 109 / 0
- 迁移 dry-run：1244 条事件，`ok:true`、`wrote:false`，note 的 `person.label = cat不到flag的cat`
- 未重启 `dsh-web`，未改线上 `~/.dsh-fish/config.json`，未 apply 迁移。

## 1. 推送分支（低风险）

```bash
cd /home/str1k3/src/bigfish-workspace-newround
git status --short            # 应为空（docs/ 已在分支内）
git log --oneline main..HEAD  # 18 个提交
git push -u origin feat/new-round-2026-11-13
```

## 2. 部署到 8710（dsh-web）

先只读确认当前指向：

```bash
cat /home/str1k3/.dsh/profiles/web/package.json
ls -l /home/str1k3/dsh-plugins/dsh-wx
systemctl cat fish-workbench.service | grep -E 'WorkingDirectory|ExecStart'
ls -la /opt/fish
```

预期当前：

- `dsh-fish` → `/home/str1k3/src/bigfish-workspace/src/dsh-fish`（main）
- `dsh-bili` → `/home/str1k3/src/bigfish-workspace-dev/src/dsh-bili`（dev）
- `dsh-wx` → `/home/str1k3/dsh-plugins/dsh-wx` → main 的 `src/dsh-wx`
- workbench → `/opt/fish/workbench`

部署要改三处指向 + 重启：

1. `~/.dsh/profiles/web/package.json`：`dsh-fish` / `dsh-bili` 改为
   `link:/home/str1k3/src/bigfish-workspace-newround/src/dsh-fish` /
   `.../src/dsh-bili`。
2. `/home/str1k3/dsh-plugins/dsh-wx` 符号链接改指
   `/home/str1k3/src/bigfish-workspace-newround/src/dsh-wx`（先 `readlink` 确认，
   不要直接覆盖未知目录）。
3. workbench：若 `/opt/fish/workbench` 是符号链接，改指
   `/home/str1k3/src/bigfish-workspace-newround/workbench`；若是拷贝，先备份再同步
   `assets/`、`fish/`、`server.mjs` 等改动文件（不要 `--delete`）。
4. `sudo systemctl restart dsh-web fish-workbench`。

健康检查：

```bash
systemctl is-active dsh-web fish-workbench
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8710/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/
tail -n 80 /home/str1k3/dsh-web.log
tail -n 80 /home/str1k3/.dsh-fish/logs/dsh-fish.log
```

## 3. 迁移 apply（写事件流，必须单独批准）

dry-run 已通过。apply 前建议先复制事件流做只读备份（不是删除/改写）：

```bash
cp -p /home/str1k3/.dsh-fish/events.jsonl \
      /home/str1k3/.dsh-fish/events.jsonl.bak-before-owner-fact-$(date +%Y%m%dT%H%M%S)
cd /home/str1k3/src/bigfish-workspace-newround
node scripts/append-owner-fact.mjs --event ev_01M77HQ4TDZJT4SJMQ49JP8RNH \
  --label 'cat不到flag的cat' --apply
node scripts/append-owner-fact.mjs --event ev_01M77HQ4TDZJT4SJMQ49JP8RNH \
  --label 'cat不到flag的cat' --apply   # 第二次应 wrote:false
```

验证：`fish:owner` 在 web/wx 出现 `cat不到flag的cat`，bili/qq 不出现；
`home/关于他.md` 存在且全局 `她的身份.md` 不含别名。

## 4. 成长实例配置（改线上 config，可回滚）

按合并稿 D8，以下只改 `~/.dsh-fish/config.json`，不写 `DEFAULTS`：

- `growthDays` 90 → 60（暂定）
- `window` → `["09:30","18:20"]`
- `browse.window` → `["09:30","18:20"]`
- `comment.window` → `["09:30","18:20"]`
- `wakesPerDay` 2 → 1

改完 `sudo systemctl restart dsh-web`，观察 `sched:` / `browse:` / `closing:` 标记。
回滚：把五个值改回旧值，不需要改代码/事件。

## 5. 屏幕陪伴真机验收（需要用户在 Windows 前）

- T4：开工作模式，切 VS Code / Windows Terminal → 飞书/微信 → 回 VS Code；
  确认允许窗口有帧、拒绝窗口停采集、切回 2 秒后恢复、关闭 1 秒内无新帧。
- T0：真实游戏 30 分钟，ddagrab 0.2fps / 1fps 各 10 分钟；记录 CPU、帧大小、
  scene/freeze 候选数、1% low；验收线 0.2fps 单核 <1%、1fps <3%、1% low 下降 <3%。

## 6. 回滚

- 代码：把三处 profile/workbench 指向改回原路径，`systemctl restart dsh-web fish-workbench`。
- **不要**把 dsh-fish 降回 v3：v4 事件落盘后旧代码会静默跳过。
- 迁移：事件流只追加，不能删；写错的 label 用新的 `person_note` + `revokes` 修正。
- 配置：改回旧值即可。
