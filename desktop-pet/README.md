# 大肥鱼桌宠薄壳（Windows）

Electron + React 19 + `dsh-pet-component` 的 Windows 桌宠。它只做表现层：
轮询 BFF 的 `/api/fish/pet/state`，把她的 presence 评论与六档工作状态翻译成动作和气泡；
不含人设、提示词、记忆或模型调用（说话走仓库的 `/api/fish/say`）。

## 前置条件

- Windows（`electron-builder --win` 打 portable 包）。
- Node.js 22.6+（`node --test --experimental-strip-types` 需要；实测 Node 24）。
- 首次构建前需要联网执行 `npm install`（依赖含 Electron）。

## 从零构建

在 **Windows** 的仓库根目录执行：

```powershell
cd D:\fish-handoff\desktop-pet

# 1. 安装依赖
npm install

# 2. 同步动画素材（见下一节；assets/webm/ 不进 Git）
node scripts/sync-assets.mjs --from <asar 解包目录>\assets\webm

# 3. 构建渲染进程 / 主进程 / preload
npm run build

# 4. 单元测试（纯 Node，不需要 Electron）
npm test

# 5. 打成 Windows portable 包，输出到 release\
npm run dist:win

# 开发时直接起 Electron（需要先 npm run build）
npm start
```

## 素材来源（`assets/webm/`）

动画素材**不进入 Git**（`desktop-pet/.gitignore` 忽略 `assets/webm/`），
因为它是大肥鱼形象、按 CC BY-NC-SA 4.0 授权，见 `assets/ATTRIBUTION.md`。
干净 checkout 里没有这些文件，`npm run dist:win` 会先跑 `scripts/check-assets.mjs` 并拒绝缺素材的构建。

实际使用的来源是 **dsh-pet v0.4.8 的 Windows 发布包**：

```powershell
# 原始安装包解出的 asar（本机路径）
#   D:\dsh-pet\release-v0.4.8\dsh-pet-0.4.8-win-x64\resources\app.asar

# 1. 解包 asar（npx 会按需下载 @electron/asar）
npx @electron/asar extract `
  "D:\dsh-pet\release-v0.4.8\dsh-pet-0.4.8-win-x64\resources\app.asar" `
  "D:\dsh-pet\asar-v0.4.8"

# 2. 只复制 assets/config.json 引用到的 11 个 webm
cd D:\fish-handoff\desktop-pet
node scripts/sync-assets.mjs --from "D:\dsh-pet\asar-v0.4.8\assets\webm"
```

`scripts/sync-assets.mjs` 以 `assets/config.json` 的 `animations.motions` / `idle` /
`turn` / `drag` / `clicks` / `moves` 为准，缺失任何一个都会列名失败，不会静默跳过。

当前 v1 子集共 **11 个文件**：

```text
待机呼吸休闲.webm
东张西望.webm
螃蟹走路.webm
点击回应-元气挥手.webm
被鼠标拖拽悬空反馈.webm
工作状态-思考冒泡.webm
工作状态-忙碌点按.webm
工作状态-清点归档.webm
工作状态-原地踱步张望.webm
工作状态-垂头叹气冒汗.webm
工作状态-雀跃庆祝.webm
```

换全量素材时只需把同名（或多出的）文件放进 `assets/webm/` 并更新
`assets/config.json` 的映射，不用改代码。

## 许可

- 播放器组件 `dsh-pet-component` 0.2.5、动作协议参考 `dsh-pet`：MIT。
- 角色形象与动画素材：**CC BY-NC-SA 4.0**，署名与非商业性使用要求见
  `assets/ATTRIBUTION.md`。用于商业用途或公开分发前必须替换为自有素材或另行取得授权。

## 目录

```text
desktop-pet/
  electron/       主进程：窗口、穿透、轮询、右键菜单、平台探测
  renderer/       React 渲染进程：<Pet>、动作控制器、对话、样式
  assets/         config.json、ATTRIBUTION.md、webm/（gitignored）
  scripts/        sync-assets.mjs、check-assets.mjs
  test/           Node 单测（controller/poller/pointer/chat/config）
```
