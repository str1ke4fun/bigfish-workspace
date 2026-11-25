# 大肥鱼桌宠薄壳（Windows）

Electron + React 19 + `dsh-pet-component` 的 Windows 桌宠。它只做表现层：
轮询 BFF 的 `/api/fish/pet/state`，把她的 presence 评论与六档工作状态翻译成动作和气泡；
不含人设、提示词、记忆或模型调用（说话走仓库的 `/api/fish/say`）。

## 前置条件

- Windows 10/11 x64（`electron-builder --win` 打 portable 包）。
- Node.js 22.6+（`node --test --experimental-strip-types` 需要；实测 Node 24）。
- Git（克隆本仓库、从上游同步素材）。
- 首次 `npm install` 需要联网（依赖含 Electron）。
- 运行时的状态与说话依赖 WSL 侧的 8788 工作台和 8710 DSH；没有它们时桌宠只会待机。

## 快速验证（不下载完整素材）

仓库只随源码附带 1 段待机动画 `assets/webm/待机呼吸休闲.webm`（441,437 B）。
干净 clone 后不联网也能验证窗口、透明、视频解码和待机循环：

```powershell
cd <仓库>\desktop-pet
npm install
npm run build
npm start
```

此时只有待机动作；切到工作/思考等状态或点动作菜单会提示素材缺失，这是预期。
完整动作和打包需要先同步其余 113 段素材。

## 完整构建

```powershell
cd <仓库>\desktop-pet

# 1. 安装依赖
npm install

# 2. 从上游同步其余 113 段动画（约 56 MB；已存在的文件默认保留）
npm run assets:fetch

# 3. 构建渲染进程 / 主进程 / preload
npm run build

# 4. 单元测试（纯 Node，不需要 Electron）
npm test

# 5. 打成 Windows portable 包，输出到 release\
npm run dist:win

# 开发时直接起 Electron（需要先 npm run build）
npm start
```

## 素材来源与许可

| 内容 | 是否入库 | 来源 |
|---|---|---|
| `assets/webm/待机呼吸休闲.webm`（441,437 B） | **是** | dsh-pet v0.4.9，CC BY-NC-SA 4.0 |
| 其余 113 个 `.webm` | 否 | 上游 `dsh-pet/assets/webm`，由 `npm run assets:fetch` 同步 |

- 上游：<https://github.com/PC2005-cloud/dsh-pet>，标签固定 **v0.4.9**，素材路径
  `dsh-pet/assets/webm`（不是仓库根目录的 `assets/webm`）。
- 许可：**CC BY-NC-SA 4.0**（署名、非商业、相同方式共享）。署名见 `assets/ATTRIBUTION.md`。
- **本仓库只分发 1 段待机动画**；其余 113 段不由本仓库或本仓库的 Release 托管。
- **这 1 段已进入 Git 历史**。作为非商业项目、保留署名没有问题；如果以后要商用或公开分发，
  必须把它替换成自有素材，或另行取得授权。同步下来的其余素材同样受 CC BY-NC-SA 约束。
- `assets/webm/` 中除这段待机外的文件仍被 `.gitignore` 忽略，**不要把同步结果提交进仓库**。

### 一条命令同步（推荐）

```powershell
cd <仓库>\desktop-pet
npm run assets:fetch
```

脚本默认用 `git clone --depth 1 --branch v0.4.9 --filter=blob:none --sparse` 只取上游的
`dsh-pet/assets/webm`，缓存放在 `%TEMP%\bigfish-pet-assets\dsh-pet-v0.4.9`，
然后调用 `sync-assets.mjs` 补齐缺的文件。已存在的本地文件默认保留，方便换成自定义动画；
`npm run assets:fetch -- --force` 才会用上游文件覆盖。脚本不会删除任何目录。

### 手工从上游仓库转移

PowerShell：

```powershell
$repo = Join-Path $env:TEMP 'dsh-pet-v0.4.9'
git clone --depth 1 --branch v0.4.9 --filter=blob:none --sparse `
  https://github.com/PC2005-cloud/dsh-pet.git $repo
git -C $repo sparse-checkout set dsh-pet/assets/webm

cd <仓库>\desktop-pet
node scripts/check-assets.mjs --from (Join-Path $repo 'dsh-pet\assets\webm')
node scripts/sync-assets.mjs  --from (Join-Path $repo 'dsh-pet\assets\webm')
```

WSL / Git Bash：

```bash
tmp="$(mktemp -d)"
git clone --depth 1 --branch v0.4.9 --filter=blob:none --sparse \
  https://github.com/PC2005-cloud/dsh-pet.git "$tmp/dsh-pet"
git -C "$tmp/dsh-pet" sparse-checkout set dsh-pet/assets/webm

cd <仓库>/desktop-pet
node scripts/check-assets.mjs --from "$tmp/dsh-pet/dsh-pet/assets/webm"
node scripts/sync-assets.mjs  --from "$tmp/dsh-pet/dsh-pet/assets/webm"
```

### npm 包备选

没有 git 或想从 npm 取同一份素材：

```powershell
npm pack dsh-pet@0.4.9
tar -xzf dsh-pet-0.4.9.tgz package/assets/webm
node scripts/check-assets.mjs --from package/assets/webm
node scripts/sync-assets.mjs  --from package/assets/webm
```

### 自定义动画

- **替换默认动作**：把同名 webm 放进 `assets/webm/`，`assets:fetch` 默认跳过已存在的文件，
  不会覆盖你的版本。
- **新增动作**：把 webm 放进 `assets/webm/`，在 `config.json` 或 `actions.json` 登记；
  再运行 `assets:fetch` 补齐其余上游文件。
- 若要提交自定义素材，需要 `git add -f`（默认被 `.gitignore` 忽略）。
- 新增 `actions.json` 条目会改变「114 个文件名」的固定名单，需要同步更新
  `test/config.test.ts` 里的期望；只替换同名默认动画不需要改测试。

`check-assets.mjs` 与 `sync-assets.mjs` 都取 `assets/config.json` 和 `assets/actions.json`
的并集并去重；缺失任一引用都会列出文件名并失败，不会自动扫描或暗中登记目录里的其他 webm。

当前目录登记 **114 段素材、113 条动作**：`睡觉-开始` 与 `睡觉-循环` 合并成一条 `seq` 动作，
`睡觉-起来` 保持单独动作。`assets/actions.json` 进 Git，其余 `assets/webm/` 仍被忽略。

## 手动动作注册与播放

`assets/actions.json` 是手动动作的唯一目录；不会从 `assets/webm/` 自动发现文件名，也不能把
basename 直接当作 action id 猜。每条动作格式如下：

```json
{
  "actions": [
    { "id": "asset-001", "label": "三球抛接", "anim": "三球抛接", "loop": false, "group": "日常" },
    { "id": "asset-091", "label": "睡觉", "seq": ["睡觉-开始", "睡觉-循环"], "loop": true, "group": "休息" },
    { "id": "asset-093", "label": "睡觉-起来", "anim": "睡觉-起来", "loop": false, "group": "休息" }
  ]
}
```

- **稳定 id**：`asset-NNN` 按 v0.4.9 的 114 个文件名排序快照编号。`睡觉-开始` 使用
  `asset-091` 并合并循环段，因此 `asset-092` 是保留空位；`睡觉-起来` 为 `asset-093`。
  新增动作请在末尾续号，不重排已有 id，避免 `/pet/act`、菜单和旧客户端失配。
- **分组**：只能使用「日常 / 回应 / 工作 / 休息 / 节日 / 其他」。余额类素材只留在「其他」，
  作为手动动画播放，不引入余额状态、接口或 trigger。
- **注册**：把 webm 放进 `assets/webm/`，在 `actions.json` 的 `actions` 数组显式加一条，
  然后在托盘/右键菜单点「重新载入动作」。重载成功会刷新菜单、目录和 `/pet/hello` 上报；
  动作注册表有坏条目时，该条丢弃并记日志，其他动作继续可用。
- **一次性与 seq**：普通 `anim` 播完恢复最新稳态；`seq` 按数组顺序播放。最后一段若是
  `loop:true`，播到该段后持续循环；否则播完恢复映射和最新稳态。组件回调推进段切换，
  不靠写死视频时长。
- **停止与抢占**：循环动作不会自己结束；点「停下当前动作」显式停止并恢复最新稳态。
  新动作会抢占旧动作；拖动、换 skin、重载目录也会先让当前 generation 失效，旧回调不能覆盖新状态。
- **未登记素材**：即使 webm 已同步，只要没有 `actions.json` 条目，菜单不显示，`/pet/act`
  也不接受该 id。

### Windows 真机验收边界

Node 单测、`check-assets` 和 `npm run build` 只能证明协议、目录、引用和构建链路，**不能证明**
视频解码、透明或视觉正确。发布前必须在 Windows 真机逐项验收：透明、闪烁、一次性、`seq`、
`loop`、stop、动作抢占、拖动、skin 切换、activity 变化，以及 `/pet/act { action }`。
菜单能点开或单测全绿都不算动作播放已验收。

## 气泡、托盘与右键菜单

- **逐句翻页**：她的长回复（对话回复、陪看评论）按句号/问号/感叹号和换行切句，超长句再按逗号拆
  （每段 ≤40 字），在同一个气泡里一句一句换；每句停留 `max(2.5 秒, 字数×0.18 秒)`，新消息会取消上一轮。
- **气泡外观**：不透明度 40–100%（默认 90）、最大宽度 220–420px（0 = 跟随桌宠大小）。
  右键「气泡」子菜单和工作台「外观」区都能改，写 `POST /api/fish/pet/config { bubbleOpacity, bubbleWidth }`；
  本地改动先生效，服务端回声前不会被旧值拉回去。
- **系统托盘**：通知区有桌宠图标（`assets/tray.png`，取自默认待机动画的一帧）。左键/双击显示或隐藏，
  右键菜单：显示/隐藏、回到右下角、演一个动作、大小、气泡、陪你看屏幕（事件/氛围/工作/关闭）、
  打开工作台、退出。隐藏状态只在内存里，重启后默认可见。托盘里切陪看走现有 `/presence/mode`，点击即授权。
- 右键菜单与托盘共用同一份菜单模型（`electron/menu-model.ts`），右键里多一个「隐藏桌宠」。

## 单实例与工作台「仅打开桌宠」

- 壳只允许一个实例：再次启动（包括点工作台链接）只会把已有窗口带到前台，不开第二个。
- 启动时把 `bigfishpet://` 登记到当前用户（`HKCU\Software\Classes\bigfishpet`）。
  portable 包登记原始 exe 路径（`PORTABLE_EXECUTABLE_FILE`），开发态登记 `electron.exe` 加应用目录。
- 工作台 `#her/pet` 的「仅打开桌宠」是指向 `bigfishpet://open` 的链接，由浏览器交给 Windows 拉起壳；
  它只拉起壳，不开陪看，服务端也不起任何子进程。
- 第一次要在 Windows 上手动启动一次壳，协议才会登记；换成新的 exe 后同样要先启动一次来覆盖旧登记。

## 工作台改尺寸与皮肤

8788 工作台的「她 · 桌宠」页（`#her/pet`）可以不用 Windows 右键菜单就改桌宠：

- **在线判定**：壳启动时与每 60 秒 `POST /api/fish/pet/hello` 上报版本与皮肤清单；
  工作台只认这条心跳，超过 90 秒没报到就显示离线。壳每 2 秒轮询
  `/api/fish/pet/state`，只刷新「最后轮询」，不会把离线续成在线。
- **尺寸**：小 320 / 中 400 / 大 462。工作台写 `POST /api/fish/pet/config { size }`，
  壳下一轮轮询（≤2 秒）应用；同一尺寸重复下发不会抖动窗口。右键「大小」仍本地生效，
  并尽力把新尺寸同步回服务端。
- **皮肤**：下拉列表来自壳通过心跳上报的皮肤清单。选中后工作台写
  `POST /api/fish/pet/config { skin }`；壳按 id 读本地皮肤并重载 `<Pet>`，
  默认项（`skin: ''`）回到 `assets/config.json` + `assets/webm`。
- **坏皮肤**：`skin.json` 不合法、缺任一动画文件或运行期载入失败时，壳保留上一个可用皮肤，
  不会白屏、不会退出；渲染进程会给出「皮肤没载入」的提示。
- **换一条会话**：同一页的「陪伴会话」卡片只调 `POST /api/fish/pet/rotate`，让陪看服务
  换一条新会话；桌宠壳不读写会话内容。

### 本地皮肤目录

在 `desktop-pet/assets/` 下放：

```text
assets/skins/
  <id>/
    skin.json     # { "name": "显示名", "motions": { ...14 个动作... }, "size": 400 }
    webm/
      <动画名>.webm
    ATTRIBUTION.md   # 皮肤自己的素材署名
```

- `<id>` 只允许小写字母、数字与连字符（`[a-z0-9-]{1,32}`），也是工作台下拉里的值；
  显示名取 `skin.json` 的 `name`。
- `motions` 必须覆盖 14 个动作：`idle / turn / moving-left / moving-right / waving /
  thinking / working / result / waiting / running / review / failed / success / error`
  （`dragging` 是手势态，不算在内），每个值对应 `webm/<动画名>.webm`，文件必须存在。
- 默认皮肤不放进 `skins/`，仍用 `assets/config.json` + `assets/webm/`。
- 壳启动时扫描一次皮肤目录；新增皮肤后要重启壳才会出现在工作台下拉里。
- **除随源码附带的待机动画外，素材不进 Git**：皮肤目录里的 `assets/skins/<id>/webm/`
  仍被 `desktop-pet/.gitignore` 忽略；`skin.json` 与 `ATTRIBUTION.md` 可以提交。

## 氛围动作策略

待机时演什么不再由 `triggers.json` 里的一条 `when: "ambient"` 决定，改由按 presence 模式分档的氛围策略驱动；`triggers.json` 仍管 speak / activity / scene / date 等事件。

- **默认策略**：`assets/ambient.json`（随源码入库）。顶层是 `version`、`quietHours` 和 `modes.{off,event,ambient,work}`；每个模式一段 `enabled`、`items`（`action`、`weight`、`enabled`、`cooldownSec`、`minIdleSec`）和 `frequency`（`intervalMinSec`、`intervalMaxSec`、`minGapSec`、`maxPerIdle`、`maxPerDay`、`settleSec`、`actionCooldownSec`）。
- **皮肤覆盖**：`assets/skins/<id>/ambient.json` 可选，按模式整段替换默认策略；皮肤没写的模式继续用默认。默认文件缺失、JSON 坏了或根形状不对时，壳保留上一份目录；单条动作不在当前动作目录只丢那一条，其它照常可用。
- **选择规则**：presence 没开时固定用 `off`；presence 开着就按当前 `presence.mode`（`ambient` / `work` / `event`）选。只在空闲、没有 scene 与 activity 时播；安静时段会把下一次整体推到结束之后，固定再等 `afterJitterSec`（默认 600 秒）。
- **event 不自动播放**：`event` 模式只消费事实事件；即使通过 API 把它改成 `enabled:true`，壳也不会自动播氛围动作。
- **安静时段来源**：有效安静时段是皮肤/默认目录的 `quietHours`，被 `config.pet.ambient.quietHours` 的非 null 值显式覆盖。`null` 只表示“没有覆盖”，不能用来清空；不带 mode 的 `reset` 会把覆盖清回 `null`，于是重新使用目录默认。
- **新增动作**：新增可做氛围的动作时，既要进 `assets/actions.json`，也要加进 `assets/ambient.json`（或皮肤 `ambient.json`）对应模式的 `items`；只进动作目录不会自动进入氛围池。
- **默认值**：`event` 默认关闭；`work` 默认整套 19 个动作、20–40 分钟一次、每次空闲最多 4 个、每天最多 16 个；`off` 8–20 分钟 / 10 / 30；`ambient` 12–25 分钟 / 6 / 20。安静时段默认 23:00–07:00（结束后固定再等 `afterJitterSec`，默认 600 秒）。
- **用户覆盖**：存在 `config.pet.ambient`，形状同上，只需写要覆盖的模式。
  - `GET /api/fish/pet/ambient` 返回壳上报的 `defaults`、用户 `overrides`、合并后的 `effective`、可选动作 `actions` 与归一化 `errors`。
  - `POST /api/fish/pet/ambient` 的 body 是一个 `{ op }` 操作：`set-enabled`（`mode`、`enabled`）、`set-frequency`（`mode`、`patch`）、`replace-mode`（`mode`、`policy`）、`add-item`（`mode`、`action` 及可选 `weight` / `enabled` / `cooldownSec` / `minIdleSec`）、`set-item`（`mode`、`action`、`patch`）、`remove-item`（`mode`、`action`）、`reset`（可带 `mode`；不带则清空全部覆盖，包括 `quietHours`）。
  - 壳还没上报动作目录时，接受写入，但暂不做动作存在性校验；上报之后未知动作会被拒绝或丢弃。每次成功改动 `revision` +1，下一轮 `/pet/state` 会带上新的覆盖，壳每拍按它选策略。这个接口只写 `config`，不调模型、不写事件流。
- **工作台 UI 暂缓**：目前没有图形编辑器，改氛围用上面的 API，或直接改 `config.pet.ambient` / `assets/ambient.json`。
- **旧 trigger 兼容**：`when: "ambient"` 仍能被解析，旧皮肤或旧触发表照常工作；但仓库默认 `assets/triggers.json` 已不再包含这一条，`date:*` 等其它 trigger 不变。

## 许可

- 播放器组件 `dsh-pet-component` 0.2.5、动作协议参考 `dsh-pet`：MIT。
- 角色形象与动画素材：**CC BY-NC-SA 4.0**，署名与非商业性使用要求见
  `assets/ATTRIBUTION.md`。**本仓库随源码附带 1 段待机动画，且已进入 Git 历史**；
  用于商业用途或公开分发前必须把这 1 段以及同步得到的其余素材替换为自有素材，或另行取得授权。

## 目录

```text
desktop-pet/
  electron/       主进程：窗口、穿透、轮询、右键菜单、平台探测
  renderer/       React 渲染进程：<Pet>、动作控制器、对话、样式
  assets/         config.json、ATTRIBUTION.md、webm/（仅待机动画入库，其余 gitignored）
  scripts/        fetch-assets.mjs、sync-assets.mjs、check-assets.mjs
  test/           Node 单测（controller/poller/pointer/chat/config/skin/assets-sync 等）
```
