# 桌宠素材来源：最小入库 + 上游同步设计

- 日期：2026-11-24
- 状态：已实施
- 范围：`desktop-pet/assets/webm/`、`desktop-pet/scripts/`、`desktop-pet/README.md`

## 目标

让干净 clone 的仓库能在不下载 56 MB 素材的情况下完成一次真实的最小验证（窗口、透明、视频解码、待机循环），
同时不把全部素材、也不把素材压缩包托管进仓库或 Release。其余动画由脚本从固定上游版本同步。

## 决定

1. **只入库 1 段待机动画**：`desktop-pet/assets/webm/待机呼吸休闲.webm`（441,437 B，
   来自 dsh-pet v0.4.9）。它是 `config.json` 的 idle 动作，路径与协议不变。
2. **其余 113 段不入库、不托管**：由 `scripts/fetch-assets.mjs` 从
   `PC2005-cloud/dsh-pet` 的 `v0.4.9` 标签、路径 `dsh-pet/assets/webm` 同步。
3. **不做 hash 断言**：用户会替换或新增自定义动画，固定文件 hash 会把正常定制变成测试失败。
4. **同步默认保留已有文件**：`sync-assets.mjs --skip-existing` 只补缺，`--force` 才覆盖。
5. **不引入压缩包**：WebM 已是压缩格式，实测 `tar.gz` 只省 0.6%，压缩没有体积收益。
6. **不新增仓库外托管**：不使用子分支、Release 附件、Git LFS 或独立素材仓库。

## 非目标

- 不实现 `setup-windows` 一键安装；本次只做素材来源和文档。
- 不提交 `package-lock.json`（另行决定）。
- 不修改 `D:\fish-handoff` 等其他文档中的旧路径。
- 不改变动作目录、事件流、`check-assets` 的完整性规则。

## 行为

### 最小状态

- 干净 checkout 只有 1 个 webm。
- `npm install && npm run build && npm start` 能看到待机呼吸。
- 切到工作/思考等状态或点动作菜单会提示素材缺失并回退，这是预期。
- `npm run dist:win` 仍会运行 `check-assets.mjs`，缺 113 个文件时拒绝打包，并提示
  `npm run assets:fetch`。

### 完整状态

- `npm run assets:fetch`：
  - 无 `--from` 时用 `git clone --depth 1 --branch v0.4.9 --filter=blob:none --sparse`
    把上游缓存到 `%TEMP%\bigfish-pet-assets\dsh-pet-v0.4.9`；
  - 只 checkout `dsh-pet/assets/webm`；
  - 调 `sync-assets.mjs --skip-existing` 补齐缺的文件；
  - 再调 `check-assets.mjs` 验证本地 114 个引用齐全；
  - 不删除任何目录；缓存损坏时只报错并让用户手动删除。
- `--from <dir>` 使用本地快照或手工克隆目录。
- `--force` 才覆盖 `assets/webm/` 里已存在的文件。

### 忽略规则

```gitignore
assets/webm/*
!assets/webm/待机呼吸休闲.webm
```

`.gitattributes` 增加 `*.webm binary`，避免文本转换。

## 许可

- 入库的 1 段与同步得到的其余 113 段都来自 dsh-pet v0.4.9，许可为 CC BY-NC-SA 4.0。
- README 与 `assets/ATTRIBUTION.md` 明确：本仓库只分发 1 段；这 1 段已进入 Git 历史；
  商用或公开分发前必须替换为自有素材或取得授权；同步结果不要提交。
- 署名按上游要求保留；不改写素材本身。

## 验证

- `node --test --experimental-strip-types test/config.test.ts test/fetch-assets.test.ts test/assets-sync.test.ts`
  全绿。
- 最小状态：`check-assets.mjs` 失败并列出 113 个文件名与 `assets:fetch` 提示。
- 完整状态：`assets:fetch` 后 `check-assets.mjs` 输出 114 个文件齐全。
- `--skip-existing` 保留自定义文件；不带该参数时覆盖。
- `git status` 中只有 1 个 webm 被跟踪，其余 113 个仍被忽略。
- Windows 真机播放、透明和待机循环需要人工验收，单测和构建不能替代。
