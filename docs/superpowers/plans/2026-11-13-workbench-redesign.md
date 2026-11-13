# 大肥鱼工作台改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 8788 工作台从八项平铺的通用后台，改成「先看她、再看 B 站和通道、低频配置沉到系统」的四页工作台，并建立可扩展的通道适配器与页面注册表。

**Architecture:** 外壳只负责主题、路由、一级 / 二级注册表、共享状态轮询和挂载点；每个二级页导出统一的 `page` 契约，每个通道导出统一的 `channel` 契约。P0 先把旧页面装进新外壳，P1–P4 逐页替换，P5 收口。旧文件保留一个发布版本，不做一次性大爆炸重写。

**Tech Stack:** Node.js 20+、原生 ES modules、原生 CSS、`node:test`。零依赖，无构建步骤。

**Spec:** `docs/superpowers/specs/2026-11-13-workbench-redesign-design.md`

## Global Constraints

- 在 `/home/str1k3/src/bigfish-workspace-dev` 的 `dev` 分支执行；`main` 是部署线，不直接改。
- 零依赖：不新增 npm 包、框架、图标库、网络字体、外部脚本或构建步骤。
- 只绑 `127.0.0.1`；Host / Origin / `Sec-Fetch-Site` 校验、CSP、`nosniff`、BFF 白名单全部不变。
- 不新增插件 HTTP 路由，不改事件 schema、调度、B 站抓取、记忆召回。
- 新页面与新通道模块禁止 `innerHTML`；所有上游文本用 `el()` / `textContent`。唯一例外是 P0 临时文件 `assets/legacy-channels.js` 的静态模板，P3 后不再被引用。
- 以她身份发送 / 打字 / 回车 / Esc：按钮带“人工”，发送前 `confirm`，服务端 `note(..., { operator:'human' })`；不写 `events.jsonl`。点画面只记动作日志。
- 配置一配置一归属，严格按 spec 4.4；`persona` 不出现在任何设置页；cookie 只上行、不回显。
- 旧 hash 映射保留一个版本；未知 hash 回落 `#her/today`。
- 主题：`<html data-theme="day|night">`；日间暖纸、夜间墨色；首次跟随系统，之后以 `localStorage['fish.theme']` 为准。
- 每个任务独立提交；只暂存该任务明确文件；提交前跑 `git diff --cached --check` 和 `python3 scripts/audit-staged.py`。每条 commit message 末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 回滚以任务为单位：`git revert <sha>`；不 reset、不 clean、不强推、不重写历史。
- `rm` / `git rm` / 清空目录等删除操作必须逐次取得用户明确批准；本计划不删除旧 `pages/*.js`、`channels.js` 或 `legacy-channels.js`。
- 文档、单测通过不等于已部署；报告里分开写本地检查、提交、推送、WSL 拉取、运行验收状态。

## Review Focus

- `localStorage` / `matchMedia` 被禁用或抛异常时：首屏仍应是可读的日间主题，不能白屏或停在未设主题的闪烁状态。
- 配置里的布尔、数字、数组缺失或类型不对（例如 `browse.keywords: null`、`allowChats` 不存在）：表单应显示空值 / 默认值；保存只发本组键，不能清空 cookie 或名单。
- 8710 不可达、BFF 返回 502 或 HTML 错误页时：单张卡片显示“读不到：原因”，其余卡片仍可用，不整页白屏。
- 昵称、评论、QQ / 微信消息里出现 `<script>`、引号、换行：必须按文本显示，不能执行，也不能把确认框内容拼成 HTML。
- 长 BVID、URL、昵称和 390px 窄屏：文本要换行、页面单列、按钮仍可点，不出现横向滚动。

---

## File Structure

新增或重写的文件：

```
workbench/
  index.html                       # 只留外壳
  assets/
    theme.css                      # 日 / 夜变量 + 旧变量兼容别名
    theme-boot.js                  # 首屏前设 data-theme
    app.css                        # 布局、组件、响应式
    app.js                         # 外壳：主题、路由、挂载、共享轮询
    router.js                      # 纯 hash 映射（可单测）
    nav.js                         # 一级 / 二级注册表 + 页面查找 + 状态点
    legacy-pages.js                # P0 临时：旧页面包装器
    legacy-channels.js             # P0 临时：旧通道 DOM + init
    config-form.js                 # 配置分组表单（B 站管理 / 系统设置共用）
    lib.js                         # 保留并补 statusDot / humanChip / segment / emptyState / parseList / openHer
    pages/
      her-today.js  her-memory.js  her-growth.js
      bili-today.js  bili-footprint.js  bili-manage.js
      system-settings.js  system-tools.js  system-logs.js  system-data.js  system-principles.js
    channels/
      registry.js  shared.js  overview.js  qq.js  wx.js  speech.js
  server.mjs                       # 只加 /api/status 的 channels 映射
  test/
    theme.test.mjs  lib.test.mjs  router.test.mjs  shell.test.mjs
    pages.test.mjs  channels.test.mjs
    assets.test.mjs  server.test.mjs
```

旧文件 `assets/pages/overview.js`、`bili.js`、`memory.js`、`env.js`、`tools.js`、`data.js`、`principles.js`、`assets/channels.js` 在新页验收前继续保留；P5 只标记废弃，不删除。

---

### Task 1: 主题变量与首屏主题引导

**Files:**
- Create: `workbench/assets/theme.css`
- Create: `workbench/assets/theme-boot.js`
- Test: `workbench/test/theme.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces: `theme.css` 的 `:root` / `html[data-theme="night"]` 变量；`theme-boot.js` 在首屏渲染前设置 `document.documentElement.dataset.theme`。

- [ ] **Step 1: 写失败测试**

`test/theme.test.mjs` 读取两个文件，并断言：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const read = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8')

test('日间与夜间都定义了完整 token', () => {
  const css = read('theme.css')
  assert.match(css, /:root\s*\{[\s\S]*--bg:\s*#f4efe6/)
  assert.match(css, /html\[data-theme="night"\]\s*\{[\s\S]*--bg:\s*#141413/)
  for (const token of ['--surface', '--ink', '--dim', '--accent', '--on-accent', '--teal', '--gold', '--danger']) {
    assert.match(css, new RegExp(`${token}:`))
  }
  assert.match(css, /--card:\s*var\(--surface\)/)
  assert.match(css, /--fg:\s*var\(--ink\)/)
})

test('主题脚本先读本地选择，再跟随系统，异常时回落日间', () => {
  const code = read('theme-boot.js')
  const run = (localStorage, matches) => {
    const document = { documentElement: { dataset: {} } }
    const window = { matchMedia: () => ({ matches }) }
    vm.runInNewContext(code, { document, window, localStorage })
    return document.documentElement.dataset.theme
  }
  assert.equal(run({ getItem: () => 'night' }, false), 'night')
  assert.equal(run({ getItem: () => null }, true), 'night')
  assert.equal(run({ getItem: () => { throw new Error('denied') } }, true), 'day')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/theme.test.mjs`
Expected: FAIL，`ENOENT` 找不到 `theme.css` / `theme-boot.js`。

- [ ] **Step 3: 实现主题资产**

`theme.css` 逐项复制 spec 7.1 的日间 / 夜间 token，并加旧页面兼容别名：

```css
:root {
  --card: var(--surface);
  --fg: var(--ink);
  --ok: var(--teal);
  --warn: var(--gold);
  --bad: var(--danger);
}
```

`theme-boot.js` 是同步 IIFE：`try` 里读 `localStorage.getItem('fish.theme')`；有值按值，无值用 `window.matchMedia('(prefers-color-scheme: dark)').matches`；`catch` 设 `'day'`。只设 `data-theme`，不碰 body。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/theme.test.mjs`
Expected: PASS，2 个测试。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/theme.css workbench/assets/theme-boot.js workbench/test/theme.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 日间暖纸与夜间墨色主题变量"
```

---

### Task 2: 共享 UI 辅助

**Files:**
- Modify: `workbench/assets/lib.js`
- Test: `workbench/test/lib.test.mjs`

**Interfaces:**
- Consumes: 现有 `el()`、`local()`。
- Produces:
  - `parseList(text: string, sample: unknown[]) -> string[] | number[]`
  - `statusDot(level?: 'ok'|'warn'|'bad'|'', text?: string) -> HTMLElement`
  - `humanChip() -> HTMLElement`
  - `segment(items: {id,label}[], opts: { value?, onChange?, label? }) -> { root, set(id) }`
  - `emptyState(text: string) -> HTMLElement`
  - `openHer() -> Promise<{ok,url?,error?}>`

- [ ] **Step 1: 写失败测试**

`test/lib.test.mjs`：

```js
import { parseList, asText } from '../assets/lib.js'

test('parseList 不把空输入变成 NaN', () => {
  assert.deepEqual(parseList('', [1, 2]), [])
  assert.deepEqual(parseList('1, 2', []), [1, 2])
  assert.deepEqual(parseList('a，b', null), ['a', 'b'])
  assert.deepEqual(parseList(null, []), [])
})
test('asText 不产生 [object Object]', () => {
  assert.equal(asText(null), '')
  assert.equal(asText({ a: 1 }), '{\n  "a": 1\n}')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/lib.test.mjs`
Expected: FAIL，`parseList` 未导出。

- [ ] **Step 3: 实现辅助函数**

`parseList` 从 `pages/env.js` 搬来，保留“样本为空数组时看输入本身是否全数字”的规则。`statusDot` 生成 `span.dot` 加可选文字，文字始终使用 `status-text`。`humanChip` 返回 `span.chip.human`，文字“人工”。`segment` 用 `role="tablist"` / `role="tab"` / `aria-selected`，`set()` 只切 `.on` 和 aria。`emptyState` 返回 `div.empty-state`。`openHer()` 调 `local('/api/her/open')`，成功时 `window.open(data.url, '_blank')`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/lib.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/lib.js workbench/test/lib.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 共享状态点、分段、人工标记与列表解析"
```

---

### Task 3: 纯路由映射

**Files:**
- Create: `workbench/assets/router.js`
- Test: `workbench/test/router.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `LEGACY_HASH: Record<string,string>`（spec 4.6 的 8 条）
  - `DEFAULT_ROUTE = 'her/today'`
  - `normalizeRoute(rawHash) -> 'nav/slug'`
  - `routeHash(nav, slug) -> '#nav/slug'`
  - `splitRoute(normalized) -> { nav, slug }`

- [ ] **Step 1: 写失败测试**

```js
import { normalizeRoute, routeHash, splitRoute } from '../assets/router.js'

test('旧 hash 映射到新路由', () => {
  assert.equal(normalizeRoute('#overview'), 'her/today')
  assert.equal(normalizeRoute('#bili'), 'bili/today')
  assert.equal(normalizeRoute('#channels'), 'channels/overview')
  assert.equal(normalizeRoute('#env'), 'system/settings')
})
test('未知 hash 回落默认路由', () => {
  assert.equal(normalizeRoute('#nope'), 'her/today')
  assert.equal(normalizeRoute(''), 'her/today')
  assert.equal(normalizeRoute('#her/'), 'her/today')
})
test('routeHash 与 splitRoute 往返一致', () => {
  assert.equal(routeHash('bili', 'footprint'), '#bili/footprint')
  assert.deepEqual(splitRoute('channels/qq'), { nav: 'channels', slug: 'qq' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/router.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯函数**

`normalizeRoute` 去掉 `#`、取 `LEGACY_HASH[key] || key`，只接受 `^[a-z]+\/[a-z0-9-]+$`；不合法返回 `DEFAULT_ROUTE`。它不校验页面是否真实存在，页面校验归 `nav.js`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/router.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/router.js workbench/test/router.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 旧 hash 到四页路由的纯映射"
```

---

### Task 4: 新外壳、页面注册表与旧页面落位

**Files:**
- Modify: `workbench/index.html`
- Modify: `workbench/assets/app.css`
- Modify: `workbench/assets/app.js`
- Create: `workbench/assets/nav.js`
- Create: `workbench/assets/legacy-pages.js`
- Create: `workbench/assets/legacy-channels.js`
- Create: `workbench/assets/pages/her-today.js`
- Create: `workbench/assets/pages/her-memory.js`
- Create: `workbench/assets/pages/her-growth.js`
- Create: `workbench/assets/pages/bili-today.js`
- Create: `workbench/assets/pages/bili-footprint.js`
- Create: `workbench/assets/pages/bili-manage.js`
- Create: `workbench/assets/pages/system-settings.js`
- Create: `workbench/assets/pages/system-tools.js`
- Create: `workbench/assets/pages/system-logs.js`
- Create: `workbench/assets/pages/system-data.js`
- Create: `workbench/assets/pages/system-principles.js`
- Test: `workbench/test/shell.test.mjs`
- Modify: `workbench/test/assets.test.mjs`

**Interfaces:**
- Consumes: `router.js`、`lib.js`、旧 `pages/*.js`、旧 `channels.js`。
- Produces:
  - `page = { id, nav, slug, label, order, badge?(ctx), enter(root, ctx), leave(), host? }`
  - `ctx = { status, statusAt, go(nav, slug), onStatus(fn) -> unsubscribe, setBadge(navId, level), refreshStatus(), actions }`；`onStatus` 的回调参数是最新 `/api/status` 的 `data`（失败传 `null`）。
  - `NAV: { id, label, pages: page[] }[]`
  - `PAGES: page[]`
  - `resolveRoute(rawHash) -> { nav, slug, page }`
  - `shellBadge(navId, status, extra?) -> 'ok'|'warn'|'bad'|null`

- [ ] **Step 1: 写外壳与注册表测试**

`test/shell.test.mjs` 导入 `NAV`、`PAGES`、`resolveRoute`、`shellBadge`，断言：

```js
assert.deepEqual(NAV.map((n) => n.id), ['her', 'bili', 'channels', 'system'])
assert.equal(NAV[0].pages.length, 3)
assert.equal(NAV[1].pages.length, 3)
assert.equal(NAV[2].pages.length, 3)
assert.equal(NAV[3].pages.length, 5)
assert.equal(new Set(PAGES.map((p) => p.id)).size, PAGES.length)
for (const p of PAGES) {
  assert.equal(typeof p.id, 'string')
  assert.equal(typeof p.nav, 'string')
  assert.equal(typeof p.slug, 'string')
  assert.equal(typeof p.label, 'string')
  assert.equal(typeof p.enter, 'function')
  assert.equal(typeof p.leave, 'function')
}
assert.equal(resolveRoute('#overview').page.id, 'her-today')
assert.equal(resolveRoute('#channels/qq').page.id, 'channels-qq')
assert.equal(resolveRoute('#nope').page.id, 'her-today')
assert.equal(shellBadge('her', { her: { running: false } }), 'bad')
assert.equal(shellBadge('channels', { channels: { qq: { running: true, loggedIn: true }, wx: { running: false } } }), 'bad')
```

`test/assets.test.mjs` 改为：
- 保留 `[hidden]` 断言。
- 断言 `index.html` 有 `id="view"`、`id="nav"`、`id="subtabs"`、`id="theme-toggle"`、`id="open-her"`，并在 `</body>` 前加载 `app.js`。
- 断言 `theme-boot.js` 的 `<script>` 在 `theme.css` / `app.css` 之前。
- 断言 `index.html` 不含 `id="qq-dot"`、`id="wx-shot"`、`id="speech-save"`、`id="chat-input"`、`data-page="overview"`。
- 断言 `legacy-channels.js` 含旧通道 DOM ID（`qq-dot`、`wx-shot`、`speech-save`、`chat-input`），旧 `channels.js` 仍含 `wx/scan`。
- 断言 `pages/data.js` 不含 `wx/scan`。
- 旧人工确认断言先继续读 `channels.js` 的 3 个 `confirm(\`人工代操作`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/shell.test.mjs test/assets.test.mjs`
Expected: FAIL，`nav.js` 不存在、`index.html` 仍是旧结构。

- [ ] **Step 3: 实现外壳 HTML 与样式**

`index.html` 只保留：

```html
<html lang="zh-CN">
<head>
  <script src="/assets/theme-boot.js"></script>
  <link rel="stylesheet" href="/assets/theme.css" />
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <div class="shell">
    <aside class="spine">
      <a class="brand" href="#her/today"><b>大肥鱼</b><span>她的工作台</span></a>
      <nav id="nav" class="spine-nav" aria-label="工作台导航"></nav>
      <div class="spine-foot">
        <button id="theme-toggle" aria-pressed="false">夜</button>
        <button id="open-her">打开她的界面</button>
        <span class="meta" id="version">v0.1.0</span>
      </div>
    </aside>
    <main class="work">
      <header class="page-head">
        <div><h1 id="page-title"></h1><span class="meta" id="page-sub"></span></div>
        <div class="page-actions" id="page-actions"></div>
      </header>
      <nav id="subtabs" class="subtabs" role="tablist" aria-label="二级页签"></nav>
      <section id="view" class="view"></section>
    </main>
  </div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>
```

`app.css` 用主题变量重写基础样式：`.shell` 两栏、`.spine` 216px 固定、`.work` 内容区 max-width 1180px、`.page` 是卡片网格（`display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:16px`），`.view` 只做挂载、`.subtabs` 下划线页签；`<900px` 时 `.shell` 单列、`.spine` 变顶部条、`.page` 单列。保留旧页面仍在用的 `.card`、`.row`、`.chips`、`.chip`、`.stage`、`.msgs`、`.fish-stats`、`.videos`、`.table`、`.logbox` 等类名。所有颜色走变量，不写死深色。

- [ ] **Step 4: 实现路由、注册表与旧页面包装**

`legacy-pages.js`：

```js
export function legacyPage({ id, nav, slug, label, order, source, host }) {
  return {
    id, nav, slug, label, order, ...(host ? { host } : {}),
    enter(root) { source.enter(root) },
    leave() { source.leave?.() },
  }
}
```

P0 的 11 个页面文件只做包装，并分别导出 `herToday`、`herMemory`、`herGrowth`、`biliToday`、`biliFootprint`、`biliManage`、`systemSettings`、`systemTools`、`systemLogs`、`systemData`、`systemPrinciples`：`her-today` / `her-growth` 共用旧 `overview`，`her-memory` 用旧 `memory`；三个 B 站页共用旧 `bili` 且 `host: 'bili-legacy'`；五个系统页分别用旧 `env` / `tools` / `data` / `data` / `principles`，其中 `system-logs` 与 `system-data` 共用 `host: 'system-data-legacy'`。

`legacy-channels.js` 把旧 `index.html` 里 `<main data-page="channels">` 的内部 HTML **原样**放进一个模板字符串，只在首次进入时 `root.innerHTML = HTML`，随后 `initChannels({ isActive: () => document.body.dataset.nav === 'channels' })`；再次进入只 `refreshChannels()`。这是全计划唯一允许的 `innerHTML`，内容全是静态标记，不插入上游文本。

`nav.js` P0 版本：三个通道页都指向 `legacy-channels.js` 的同一个 `enter/leave`，`host: 'channels-legacy'`，id 分别是 `channels-overview` / `channels-qq` / `channels-wx`，slug 是 `overview` / `qq` / `wx`。`resolveRoute` 先用 `normalizeRoute`，再在 `NAV` 里按 `nav + slug` 找；找不到回落 `her/today`。`shellBadge` 的规则：

- `her`：`status.her.running && status.her.http === '200'` → `ok`，否则 `bad`。
- `channels`：取 `channels.qq` / `channels.wx` 里最差的一个；掉线 / 没跑 → `bad`，未登录 / 无障碍树异常 → `warn`，否则 `ok`。
- `bili`：返回 `extra.bili || null`；由她·今天或 B 站页通过 `ctx.setBadge('bili', level)` 提供。
- `system`：永远 `null`。

`app.js`：
- 首次进入创建 `<section class="page" hidden>` 挂到 `#view`，按 `page.host || page.id` 复用根节点；切页只隐藏旧根、显示新根，不销毁旧 DOM。
- 每次进入设置根节点 `data-page` 为 `page.id`、`document.body.dataset.nav` 为一级页 id，清空 `ctx.actions`，调用 `page.enter(root, ctx)`；离开调用 `page.leave()`。
- `ctx.onStatus` 监听 `window` 的 `workbench:status`，返回取消函数；`ctx.setBadge` 更新侧栏点；`ctx.refreshStatus()` 立刻拉一次 `/api/status`。
- 共享 `/api/status` 只有一个定时器：当前 `nav === 'channels'` 用 3 秒，否则 30 秒；`/notify` 60 秒。
- 路由切换用 `history.replaceState`；`hashchange` 调 `show`；初始无 hash 时替换为 `#her/today`。
- 主题按钮切 `html.dataset.theme`、写 `localStorage['fish.theme']`、更新 `aria-pressed` 和按钮文字（日间显示“夜”，夜间显示“日”）。
- 侧栏“打开她的界面”调 `openHer()`。

- [ ] **Step 5: 跑测试与旧功能冒烟**

Run: `cd workbench && node --test`
Expected: 全绿；旧 `channels.js` / 旧页面模块仍被 P0 包装器引用，旧 hash 能落到对应页。

- [ ] **Step 6: 提交**

```bash
git add workbench/index.html workbench/assets/app.css workbench/assets/app.js \
  workbench/assets/nav.js workbench/assets/legacy-pages.js workbench/assets/legacy-channels.js \
  workbench/assets/pages/her-today.js workbench/assets/pages/her-memory.js workbench/assets/pages/her-growth.js \
  workbench/assets/pages/bili-today.js workbench/assets/pages/bili-footprint.js workbench/assets/pages/bili-manage.js \
  workbench/assets/pages/system-settings.js workbench/assets/pages/system-tools.js workbench/assets/pages/system-logs.js \
  workbench/assets/pages/system-data.js workbench/assets/pages/system-principles.js \
  workbench/test/shell.test.mjs workbench/test/assets.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 四页外壳、主题开关、路由注册与旧页面落位"
```

---

### Task 5: 她 · 今天

**Files:**
- Modify: `workbench/assets/pages/her-today.js`
- Modify: `workbench/test/pages.test.mjs`（本任务创建）

**Interfaces:**
- Consumes: `ctx.status`、`ctx.onStatus`、`ctx.setBadge`、`ctx.go`；`lib.js` 的 `card` / `el` / `fillStats` / `segment` / `emptyState` / `errorText` / `writeError` / `humanChip`。
- Produces: `export const herToday`，不再有 `host`。

- [ ] **Step 1: 写失败测试**

`test/pages.test.mjs`（本任务先把所有页面模块和读取辅助都导入；后续任务只追加断言，不再改头部）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { herToday } from '../assets/pages/her-today.js'
import { herMemory } from '../assets/pages/her-memory.js'
import { herGrowth } from '../assets/pages/her-growth.js'
import { biliToday } from '../assets/pages/bili-today.js'
import { biliFootprint } from '../assets/pages/bili-footprint.js'
import { biliManage } from '../assets/pages/bili-manage.js'
import { systemSettings } from '../assets/pages/system-settings.js'
import { systemTools } from '../assets/pages/system-tools.js'
import { systemLogs } from '../assets/pages/system-logs.js'
import { systemData } from '../assets/pages/system-data.js'
import { systemPrinciples } from '../assets/pages/system-principles.js'
const src = (name) => readFileSync(new URL(`../assets/pages/${name}`, import.meta.url), 'utf8')

test('她·今天契约与数据源', () => {
  assert.equal(herToday.id, 'her-today')
  assert.equal(herToday.nav, 'her')
  assert.equal(herToday.slug, 'today')
  const s = src('her-today.js')
  for (const call of ["fish('status')", "fish('state')", "fish('bili/status')", "fish('tools')",
    "fish('events?limit=40')", "fish('beliefs')", "fish('home')", "fish('away')",
    "local('/api/status.log')", "fish('rules')"]) assert.match(s, new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(s, /inbox\s*\?\s*fish\('inbox'\)/)
  assert.match(s, /refresh\(\{\s*inbox:\s*false\s*\}\)/)
  assert.match(s, /postFish\('wake'/)
  assert.match(s, /postFish\('say'/)
  assert.match(s, /postFish\('decide'/)
  assert.doesNotMatch(s, /persona/)
  assert.doesNotMatch(s, /innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL，`herToday.slug` 仍是 P0 包装器或端点缺失。

- [ ] **Step 3: 实现页面**

从旧 `pages/overview.js` 迁移行为，按 spec 6.2 重排：待裁决条 → hero（状态、阶段、天数、四个数字）→ 时间线 / 她留下的话 → 世界摘要（B 站、通道）→ 你不在的时候 → 最近动作 → 叫醒 / 跟她说一句 / 信箱。

- `load({ inbox = false })`：`inbox` 为 true 才请求 `/inbox`；进入页面调用 `load({ inbox: true })`，60 秒刷新调用 `load({ inbox: false })`。
- `/bili/status` 成功后按 `!s.installed ? 'bad' : s.cooling ? 'warn' : 'ok'` 调 `ctx.setBadge('bili', level)`；失败设 `'bad'`。
- 待裁决用 `rules.pending`；批准 / 驳回后重读 `rules` 和 `beliefs`。
- “跟她说一句”支持一张图；成功展示她这一轮说的话，不保留历史。
- 空态按 spec 6.2 的中文原句；每张卡独立 `errorText` / `writeError`，不整页白屏。
- `leave()` 清掉 60 秒定时器；再次进入重新读取，不叠加定时器。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/pages/her-today.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 她·今天页，巡检首屏与世界摘要"
```

---

### Task 6: 她 · 记忆

**Files:**
- Modify: `workbench/assets/pages/her-memory.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: `fish()`；`segment()`、`card()`、`el()`。
- Produces: `export const herMemory`，只读，无写请求。

- [ ] **Step 1: 写失败测试**

追加到 `test/pages.test.mjs`：

```js
test('她·记忆只读且分五段', () => {
  const s = src('her-memory.js')
  assert.equal(herMemory.id, 'her-memory')
  assert.equal(herMemory.slug, 'memory')
  for (const call of ["fish('events?'", "fish('diary')", "fish('reports')", "fish('beliefs')", "fish('templates')"]) {
    assert.ok(s.includes(call), call)
  }
  assert.match(s, /事件[\s\S]*日记[\s\S]*日报[\s\S]*判断[\s\S]*模板/)
  assert.doesNotMatch(s, /postFish|local\(|innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL，仍是旧 `memory` 包装器。

- [ ] **Step 3: 实现页面**

迁旧 `pages/memory.js` 的读取逻辑，顶部用 `segment()` 做五段。事件段保留类型 / 条数筛选并写明“只做类型和数量筛选，不提供全文检索”；日记段用衬线、宽行距，不可见时只给日期目录和说明；日报用 `pre` 保留 Markdown；判断四段原样列出；模板表格列出 id、阶段、问什么、一次性、来过、次数、最近。全部只读。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/pages/her-memory.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 她·记忆页，事件与日记分段阅读"
```

---

### Task 7: 她 · 成长

**Files:**
- Modify: `workbench/assets/pages/her-growth.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: `fish('state')`、`fish('beliefs')`、`fish('rules')`。
- Produces: `export const herGrowth`，只读。

- [ ] **Step 1: 写失败测试**

```js
test('她·成长只读，没有调人格滑杆', () => {
  const s = src('her-growth.js')
  assert.equal(herGrowth.id, 'her-growth')
  assert.equal(herGrowth.slug, 'growth')
  for (const k of ['pendingGate', 'stageForced', 'beliefCount', 'tension', 'solidCount', 'scarCount', 'stanceReady']) {
    assert.ok(s.includes(k), k)
  }
  assert.doesNotMatch(s, /postFish|local\(|innerHTML|type:\s*'range'/)
  assert.match(s, /这里没有数值滑杆/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现页面**

按 spec 6.4：阶段卡、数字卡、最近 8 条判断、张力摘要（只给数量与第一对原话）、疤与拒绝摘要、立场是否就绪、规则摘要链接到 `#system/tools`。不提供裁决按钮，不提供任何输入控件。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/pages/her-growth.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 她·成长页，只读阶段与判断"
```

---

### Task 8: B 站 · 今天

**Files:**
- Modify: `workbench/assets/pages/bili-today.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: `fish()` / `postFish()`；`ctx.setBadge('bili', level)`。
- Produces: `export const biliToday`。

- [ ] **Step 1: 写失败测试**

```js
test('B站·今天不自动扫评论，只做两个快捷开关', () => {
  const s = src('bili-today.js')
  assert.equal(biliToday.id, 'bili-today')
  assert.equal(biliToday.slug, 'today')
  for (const call of ["fish('bili/status')", "fish('comment')", "fish('comment-body?",
    "fish('history?days=", "fish('outings')", "fish('risk')", "fish('owner')", "fish('config')",
    "postFish('wake?focus=browse'", "postFish('risk'"]) assert.ok(s.includes(call), call)
  assert.match(s, /comment\s*=\s*true/)
  assert.match(s, /comment:\s*false/)
  assert.match(s, /browse:\s*\{\s*enabled/)
  assert.match(s, /comment:\s*\{\s*enabled/)
  assert.doesNotMatch(s, /browse\.perDay|comment\.perDay|persona|innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现页面**

按 spec 6.5：顶部四个数字；待回复只给“读正文”；今天看了什么给封面 / 标题 / UP / 时间 / 行内抽帧；出门卡给人工叫醒；开关卡只翻转 `browse.enabled` / `comment.enabled`；登录卡未存 cookie 时给“去管理存登录”，`ui.ownerHintDismissed` 只在这里写；风控卡冷却时才显示解冻。`/comment` 只在进入页面或点“刷新评论”时调用，写操作后的回读传 `comment: false`。成功后 `ctx.setBadge('bili', risk?.cooling ? 'warn' : 'ok')`。B 站三个页进入时都读一次 `/bili/status` 更新侧栏点；足迹 / 管理页只把它用于状态点，不重复日常卡。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/pages/bili-today.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): B站·今天页，日常介入与两个快捷开关"
```

---

### Task 9: B 站 · 足迹

**Files:**
- Modify: `workbench/assets/pages/bili-footprint.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: `fish()`；`segment()`。
- Produces: `export const biliFootprint`，只读。

- [ ] **Step 1: 写失败测试**

```js
test('B站·足迹只读，视频与评论分段', () => {
  const s = src('bili-footprint.js')
  assert.equal(biliFootprint.id, 'bili-footprint')
  assert.equal(biliFootprint.slug, 'footprint')
  for (const call of ["fish('history?days=", "fish('footprint?days=", "fish('comment-body?",
    "fish('cover/", "fish('sheet/", "fish('bili/status')"]) assert.ok(s.includes(call), call)
  assert.match(s, /视频足迹[\s\S]*评论足迹/)
  assert.doesNotMatch(s, /postFish|local\(|innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现页面**

按 spec 6.6：视频足迹按天折叠，默认展开最近一天，天数 7 / 14 / 30；每条封面懒加载、标题新窗口打开、UP、时间、时长、播放量、按需抽帧。评论足迹按时间倒序，正文缺失给“读正文”，标注 BV 号和视频链接。空态用“还没看过什么”“她还没在 B 站发过评论”。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/pages/bili-footprint.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): B站·足迹页，按天看视频与评论"
```

---

### Task 10: B 站 · 管理（含共享配置表单）

**Files:**
- Create: `workbench/assets/config-form.js`
- Modify: `workbench/assets/pages/bili-manage.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: `fish('config')`、`postFish('config')`、`postFish('owner')`、`postFish('risk')`；`parseList()`。
- Produces:
  - `configGroup({ title, keys, labels, note?, onSaved? }) -> { root, setConfig(config), setStatus(text, level) }`
  - `export const biliManage`

- [ ] **Step 1: 写失败测试**

```js
test('B站·管理收拢 B 站配置，不回显 cookie', () => {
  const s = src('bili-manage.js')
  assert.equal(biliManage.id, 'bili-manage')
  assert.equal(biliManage.slug, 'manage')
  for (const k of ['browse.perDay', 'browse.topN', 'browse.deepRead', 'browse.danmaku',
    'browse.keywords', 'browse.window', 'browse.voices', 'video.perDay', 'video.frames',
    'comment.perDay', 'comment.replyPerDay', 'comment.scanEveryMin', 'comment.atOwner',
    'avoid.keywords', 'avoid.upMids', 'avoid.minDuration', "fish('bili/status')"]) assert.ok(s.includes(k), k)
  assert.doesNotMatch(s, /growthDays|notify\.enabled|memory\.docBudget|persona|lastShown|lastScanAt/)
  assert.match(s, /type:\s*'password'/)
  assert.match(s, /if\s*\(cookie\)/)
  assert.match(s, /postFish\('owner'/)
  assert.match(s, /postFish\('risk'/)
  assert.doesNotMatch(s, /innerHTML/)
})
test('配置表单对缺失 / 错误类型是 Null-safe 的', () => {
  const s = readFileSync(new URL('../assets/config-form.js', import.meta.url), 'utf8')
  assert.match(s, /Array\.isArray/)
  assert.match(s, /typeof\s+value\s*===\s*'boolean'/)
  assert.match(s, /parseList/)
  assert.doesNotMatch(s, /innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现共享配置表单**

从 `pages/env.js` 搬 `LABELS`、`control`、`editors`、`setPath`、`group` 的逻辑到 `config-form.js`，但每个页面传入自己的 `labels`，不共享全局标签。`configGroup` 的规则：
- 顶层键值是布尔 / 数字 / 字符串 / 数组；数组用逗号分隔，`parseList(text, currentValue)` 判数字。
- `setConfig(config)` 对 `null` / 缺失键显示空值，不抛错。
- 保存只发 `{ [key]: value }` 的顶层 patch；保存后由页面重新 `GET /config` 回读。
- `lastShown` / `lastScanAt` 永不渲染。

- [ ] **Step 4: 实现 B 站 · 管理**

按 spec 6.7 六组折叠卡：登录、风控、浏览、看画面、评论、避让。登录组：mid、昵称、cookie（`type='password'`，留空不改），显示是否已存 / 是否带 csrf / 登录账号名；`postFish('owner', body)` 只带填了的字段；测试 cookie 发 `{ test: true }`。风控组解冻二次确认。其余四组用 `configGroup`。页面顶部写明“这些配置只影响她在 B 站的行为；成长与记忆设置在系统 · 设置”。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add workbench/assets/config-form.js workbench/assets/pages/bili-manage.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): B站·管理页与共享配置分组表单"
```

---

### Task 11: `/api/status` 通用通道映射

**Files:**
- Modify: `workbench/server.mjs:605-608`
- Modify: `workbench/test/server.test.mjs`

**Interfaces:**
- Consumes: `qqStatus()`、`wxStatus()`、`herStatus()`、`qqLogin`。
- Produces: `/api/status` 新 shape：

```js
{
  at,
  qq: { ...qq, login: qqLogin },
  wx, her, log,
  channels: { qq: { ...qq, login: qqLogin }, wx }
}
```

- [ ] **Step 1: 写失败测试**

在 `server.test.mjs` 加：

```js
test('/api/status 保留旧键并新增 channels 映射', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/status`)
  const d = await r.json()
  for (const k of ['at', 'qq', 'wx', 'her', 'log', 'channels']) assert.ok(k in d, k)
  assert.deepEqual(d.qq.login, d.channels.qq.login)
  assert.equal(d.qq.running, d.channels.qq.running)
  assert.equal(d.wx.label, d.channels.wx.label)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/server.test.mjs`
Expected: FAIL，`channels` 不存在。

- [ ] **Step 3: 实现映射**

只改 `status()`：先构造 `qqWithLogin = { ...qq, login: qqLogin }`，返回旧键和 `channels: { qq: qqWithLogin, wx }`。不新增路由，不改 BFF。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/server.test.mjs`
Expected: PASS，原有 Host / Origin / BFF 测试全绿。

- [ ] **Step 5: 提交**

```bash
git add workbench/server.mjs workbench/test/server.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): /api/status 增加通用 channels 映射并保留旧键"
```

---

### Task 12: 通道共享辅助与 QQ

**Files:**
- Create: `workbench/assets/channels/shared.js`
- Create: `workbench/assets/channels/qq.js`
- Create: `workbench/test/channels.test.mjs`

**Interfaces:**
- Consumes: `ctx.status.channels.qq`、`ctx.onStatus`、`ctx.refreshStatus`、`local()`。
- Produces:
  - `confirmHuman(action: string, detail?: string) -> boolean`
  - `scopeChip({ id, label, checked, onToggle }) -> HTMLElement`
  - `export const qq`：`{ id:'qq', label:'QQ', order:10, badge(status), summary(status, ctx), renderPanel(root, ctx), refresh(ctx), leave(), humanActions:['send'] }`

- [ ] **Step 1: 写失败测试**

`test/channels.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { qq } from '../assets/channels/qq.js'

test('QQ 适配器契约', () => {
  assert.equal(qq.id, 'qq')
  assert.equal(qq.order, 10)
  for (const f of ['badge', 'summary', 'renderPanel', 'refresh', 'leave']) assert.equal(typeof qq[f], 'function')
  assert.deepEqual(qq.humanActions, ['send'])
})
test('QQ 人工发送有确认与人工标记', () => {
  const s = readFileSync(new URL('../assets/channels/qq.js', import.meta.url), 'utf8')
  assert.match(s, /confirmHuman\(/)
  assert.match(s, /人工发送/)
  assert.match(s, /humanChip\(\)/)
  assert.match(s, /\/api\/qq\/send/)
  assert.doesNotMatch(s, /innerHTML/)
  const srv = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(srv, /operator:\s*'human'/)
  assert.match(srv, /channel:\s*'qq'/)
  assert.match(srv, /channel:\s*'wx'/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/channels.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 shared.js**

`confirmHuman(action, detail)` 用模板字符串：``confirm(`人工代操作：${action}${detail ? `\n\n${String(detail).slice(0, 120)}` : ''}`)``。`scopeChip` 是旧 `channels.js` 的 chip 逻辑，去掉 `innerHTML`，用 `el()` 拼。动作日志仍由服务端 `note()` 写，前端不新增日志接口。

- [ ] **Step 4: 实现 QQ 通道**

从旧 `channels.js` 拆出 QQ 相关逻辑，按 spec 6.9 分四段：消息 / 说话范围 / 掉线提醒 / 登录与 WebUI。要点：
- `renderPanel` 只建一次骨架，订阅 `ctx.onStatus`；`refresh` 应用状态并加载当前分段数据；`leave` 取消订阅、清定时器。
- 消息：`/api/qq/recent`、`/api/qq/history`、`/api/qq/send`；发送前 `confirmHuman`，按钮带 `humanChip()`。
- 说话范围：`/api/qq/scope` GET/POST；保存后可选重启，勾选时用普通 `confirm`（不是人工代操作，不计入 `confirmHuman`）。
- 掉线提醒：`/api/watch` GET/POST、`/api/watch/test`。
- 登录取 `/api/qq/panel`、`/api/qq/qr`；启停 / 重启走 `/api/qq/*`，完成后 `ctx.refreshStatus()`。
- `badge(status)`：`!running || login.phase === 'kicked'` → `bad`；`!loggedIn` → `warn`；否则 `ok`。
- `summary(status, ctx)` 返回 `{ lines, actions }`；actions 里“去 QQ”用 `ctx.go('channels', 'qq')`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd workbench && node --test test/channels.test.mjs`
Expected: PASS（注册表断言在 Task 14 创建 `registry.js` 后追加）。

- [ ] **Step 6: 提交**

```bash
git add workbench/assets/channels/shared.js workbench/assets/channels/qq.js workbench/test/channels.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 通道共享辅助与 QQ 交互面板"
```

---

### Task 13: 微信通道

**Files:**
- Create: `workbench/assets/channels/wx.js`
- Modify: `workbench/test/channels.test.mjs`

**Interfaces:**
- Consumes: `ctx.status.channels.wx`、`local()`、`confirmHuman()`。
- Produces: `export const wx`，契约同 `qq`，`order: 20`，`humanActions: ['type', 'key']`。

- [ ] **Step 1: 写失败测试**

```js
import { wx } from '../assets/channels/wx.js'

test('微信适配器保留画面与人工代操作', () => {
  const s = readFileSync(new URL('../assets/channels/wx.js', import.meta.url), 'utf8')
  assert.equal(wx.id, 'wx')
  assert.equal(wx.order, 20)
  for (const p of ['/api/wx/frame.jpg', '/api/wx/click', '/api/wx/type', '/api/wx/key',
    '/api/wx/scope', '/api/wx/save', '/api/wx/peek', '/api/wx/close-extra',
    '/api/fish/wx/scan', '/api/gc']) assert.ok(s.includes(p), p)
  assert.match(s, /confirmHuman\(/)
  assert.match(s, /humanActions:\s*\['type',\s*'key'\]/)
  assert.match(s, /clearInterval/)
  assert.doesNotMatch(s, /innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/channels.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现微信通道**

按 spec 6.10 分三段：实时画面 / 允许说话 / 维护。
- 画面：只有当前分段可见且 `wx.running` 时启动约 1 秒的 `setInterval` 拉 `/api/wx/frame.jpg?t=`；切段 / 离开 / 停止时 `clearInterval`。点画面按 `naturalWidth / rect.width` 换算坐标，POST `/api/wx/click` 只记日志。
- 打字 / 回车 / Esc：`confirmHuman()` 后 POST `/api/wx/type` / `/api/wx/key`；结果写状态行。
- 允许说话：`/api/wx/scope` GET/POST；检测失败时禁用保存；名单为空显示“她开不了口”；名字坏成问号时提示重新勾选。
- 维护：`/api/wx/save`、`/api/wx/peek`、`/api/wx/close-extra`、`/api/fish/wx/scan`、`/api/gc`、`/api/frames`；清理二次确认。
- `badge(status)`：`!running` → `bad`；`health.tree.status !== 'ok'` → `warn`；否则 `ok`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/channels.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/channels/wx.js workbench/test/channels.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 微信通道实时画面与允许说话"
```

---

### Task 14: 通道总览、说话节奏、注册表与外壳接线

**Files:**
- Create: `workbench/assets/channels/speech.js`
- Create: `workbench/assets/channels/overview.js`
- Create: `workbench/assets/channels/registry.js`
- Modify: `workbench/assets/nav.js`
- Modify: `workbench/test/channels.test.mjs`
- Modify: `workbench/test/assets.test.mjs`

**Interfaces:**
- Consumes: `CHANNELS`、`qq`、`wx`、`ctx.go`、`ctx.status`。
- Produces:
  - `export const CHANNELS = [qq, wx].sort((a,b) => a.order - b.order)`
  - `renderSpeechCard(ctx) -> { root, refresh() }`
  - `export const channelsOverview`，id `channels-overview`、slug `overview`、nav `channels`、order `0`。
  - `nav.js` 的 `channelPages = CHANNELS.map(...)`，id `channels-<id>`，slug `<id>`。

- [ ] **Step 1: 写失败测试**

追加到 `test/channels.test.mjs`：

```js
import { CHANNELS } from '../assets/channels/registry.js'

test('通道注册表按 order 排序', () => {
  assert.deepEqual(CHANNELS.map((c) => c.id), ['qq', 'wx'])
})
test('总览遍历注册表，不写死 QQ / 微信', () => {
  const s = readFileSync(new URL('../assets/channels/overview.js', import.meta.url), 'utf8')
  assert.match(s, /CHANNELS\.map|for\s*\(const\s+\w+\s+of\s+CHANNELS\)/)
  assert.doesNotMatch(s, /if\s*\(\s*(id|ch)\.id\s*===\s*'qq'/)
  assert.match(s, /renderSpeechCard/)
  assert.match(s, /\/api\/status\.log/)
})
test('说话节奏是共享模块，键扁平', () => {
  const s = readFileSync(new URL('../assets/channels/speech.js', import.meta.url), 'utf8')
  for (const k of ['enabled', 'minGapSeconds', 'maxPerMinute', 'maxPerHour']) assert.ok(s.includes(k), k)
  assert.match(s, /\/api\/speech/)
  assert.doesNotMatch(s, /speech\.enabled|speech\.minGapSeconds/)
})
```

`test/assets.test.mjs` 改为：
- 人工确认断言：`assets/channels/shared.js` 含 `confirm(\`人工代操作`；`qq.js` + `wx.js` 合计 3 个 `confirmHuman(` 调用（QQ 发送 1 个，微信打字 / 按键 2 个）。
- `wx/scan` 改断言在 `assets/channels/wx.js`。
- 断言 `assets/channels/registry.js` 导出 `CHANNELS`；`assets/channels/overview.js` 遍历 `CHANNELS`。
- 断言 `index.html` 与 `legacy-channels.js` 都不再被 `nav.js` 引用（`nav.js` 不含 `legacy-channels`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/channels.test.mjs test/assets.test.mjs`
Expected: FAIL，`registry.js` / `overview.js` 不存在，`nav.js` 仍指向 legacy。

- [ ] **Step 3: 实现 speech.js 与 overview.js**

`speech.js`：`renderSpeechCard(ctx)` 拉 `/api/speech`，显示开关 / 间隔 / 每分钟 / 每小时 / 最近一小时统计；编辑用页面内展开区，保存 POST `/api/speech`，保存后重读。键扁平，不加 `speech.` 前缀。

`overview.js`：按 spec 6.8 四张卡（QQ、微信、说话节奏、她 8710）+ 最近动作（`/api/status.log` 最近 20 条）。状态点由 `channel.badge(status)` 给。通道卡按钮来自 `channel.summary(status, ctx)`；“去 QQ / 去微信”只 `ctx.go`，不重载。她卡显示运行、事件数、最后写入、HTTP；停止沿用 hold 语义并写到几点恢复。页面订阅 `ctx.onStatus`，离开取消。

- [ ] **Step 4: 接线 nav.js**

删除 P0 的 legacy channel 包装，改为：

```js
import { CHANNELS } from './channels/registry.js'
import { channelsOverview } from './channels/overview.js'

const channelPages = CHANNELS.map((ch) => ({
  id: `channels-${ch.id}`,
  nav: 'channels',
  slug: ch.id,
  label: ch.label,
  order: ch.order,
  badge: (ctx) => ch.badge?.(ctx.status?.channels?.[ch.id]),
  enter: async (root, ctx) => { await ch.renderPanel(root, ctx); await ch.refresh?.(ctx) },
  leave: () => ch.leave?.(),
}))
```

`NAV` 的通道组改为 `[channelsOverview, ...channelPages]`。`legacy-channels.js` 保留文件但不被引用；不删除。

- [ ] **Step 5: 跑全量测试**

Run: `cd workbench && node --test`
Expected: 全绿；旧 `channels.js` 仍在仓库里，但不再被 `nav.js` 引用。

- [ ] **Step 6: 提交**

```bash
git add workbench/assets/channels/speech.js workbench/assets/channels/overview.js \
  workbench/assets/channels/registry.js workbench/assets/nav.js \
  workbench/test/channels.test.mjs workbench/test/assets.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 通道总览、说话节奏与注册表接线"
```

---

### Task 15: 系统 · 设置 与 系统 · 工具与规则

**Files:**
- Modify: `workbench/assets/pages/system-settings.js`
- Modify: `workbench/assets/pages/system-tools.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: `configGroup()`、`fish('config')`、`fish('tools')`、`fish('rules')`、`fish('selfcheck?net=1')`、`postFish('config')`。
- Produces: `export const systemSettings`、`export const systemTools`。

- [ ] **Step 1: 写失败测试**

```js
test('系统·设置只留成长 / 通知 / 对话 / 记忆', () => {
  const s = src('system-settings.js')
  assert.equal(systemSettings.id, 'system-settings')
  assert.equal(systemSettings.slug, 'settings')
  for (const k of ['growthDays', 'wakesPerDay', 'daily', 'diary', 'absenceAfterDays',
    'notify.enabled', 'chat.rotateAfter', 'chat.replyChars',
    'memory.docBudget', 'memory.beliefsShown', 'memory.sleepEveryDays']) assert.ok(s.includes(k), k)
  assert.doesNotMatch(s, /browse\.|video\.|comment\.|avoid\.|owner\.|tools\.restrict|observe\.|persona/)
  assert.match(s, /配置搬家/)
})
test('工具白名单只在系统·工具与规则', () => {
  const s = src('system-tools.js')
  assert.equal(systemTools.id, 'system-tools')
  assert.equal(systemTools.slug, 'tools')
  for (const k of ['tools.restrict', 'tools.allow', "fish('tools')", "fish('rules')", "fish('selfcheck?net=1')"]) {
    assert.ok(s.includes(k), k)
  }
  assert.match(s, /重启 DSH 后生效/)
  assert.doesNotMatch(s, /persona|innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现系统·设置**

用 `configGroup()` 四组：成长、通知、对话、记忆，每组独立保存、保存后回读 `/config`。顶部“配置搬家”卡列出 B 站 / 通道 / 工具 / 观测的归属并给 `ctx.go` 链接。`persona` 不出现。

- [ ] **Step 4: 实现系统·工具与规则**

迁旧 `pages/tools.js`：工具清单 chip、白名单文本域、保存后提示“重启 DSH 后生效”；规则分层只读，待裁决链接到 `#her/today`；自检按钮才联网，结果 ✓ / ✗ + 怎么修 + 原始返回折叠。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add workbench/assets/pages/system-settings.js workbench/assets/pages/system-tools.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 系统设置与工具规则页"
```

---

### Task 16: 系统 · 日志 与 系统 · 数据

**Files:**
- Modify: `workbench/assets/pages/system-logs.js`
- Modify: `workbench/assets/pages/system-data.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: `fish()`、`postFish()`、`local('/api/frames')`、`local('/api/gc')`、`configGroup()`。
- Produces: `export const systemLogs`、`export const systemData`。

- [ ] **Step 1: 写失败测试**

```js
test('系统·日志四分段与导出', () => {
  const s = src('system-logs.js')
  assert.equal(systemLogs.id, 'system-logs')
  assert.equal(systemLogs.slug, 'logs')
  for (const call of ["fish('events?", "local('/api/status.log')", "fish('ledger?",
    "fish('log?lines=", "/api/fish/log/export", "postFish('log/clear'"]) assert.ok(s.includes(call), call)
  assert.match(s, /她的时间线[\s\S]*人工动作[\s\S]*工具台账[\s\S]*运行日志/)
  assert.match(s, /confirm\(/)
  assert.doesNotMatch(s, /persona|innerHTML/)
})
test('系统·数据危险操作在底部，观测只在数据页', () => {
  const s = src('system-data.js')
  assert.equal(systemData.id, 'system-data')
  assert.equal(systemData.slug, 'data')
  for (const call of ["/api/fish/backup", "postFish('backup/restore'", "postFish('import'",
    "postFish('reset'", "fish('paths')", "fish('update?", "fish('avatar/info'", "postFish('avatar'",
    "observe.enabled", "observe.port", "local('/api/frames')", "local('/api/gc'"]) assert.ok(s.includes(call), call)
  assert.match(s, /输入\s*restore|confirm:\s*'restore'/)
  assert.match(s, /输入\s*reset|confirm:\s*'reset'/)
  assert.doesNotMatch(s, /browse\.|comment\.|growthDays|persona|innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现系统·日志**

四段：她的时间线（类型 / 条数）、人工动作（`/api/status.log` 20 条，人工 chip）、工具台账（日期 / 工具名）、运行日志（`/log?lines=`、导出、清空二次确认）。日志与原始返回用等宽字体、可换行、可滚动。顶部写明“她的时间线是记忆，不是运行日志；运行日志只用于排障”。

- [ ] **Step 4: 实现系统·数据**

迁旧 `pages/data.js`，按 spec 6.14 重排：备份与恢复、导入、观测参数、更新检查、数据路径、头像与媒体、帧存档；重置与清空等危险操作放最下面。恢复 / 重置保留输入 `restore` / `reset` 和上游 confirm 字面量；路径不默认铺在页面上；头像上限文案按现有 4MB 请求体 / 2MB 原图写清楚。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add workbench/assets/pages/system-logs.js workbench/assets/pages/system-data.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 系统日志与数据运维页"
```

---

### Task 17: 系统 · 原理

**Files:**
- Modify: `workbench/assets/pages/system-principles.js`
- Modify: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: 无网络请求；本地 `/assets/principle-loop.svg`、`/assets/principle-memory.svg`。
- Produces: `export const systemPrinciples`。

- [ ] **Step 1: 写失败测试**

```js
test('系统·原理是静态页，不依赖插件', () => {
  const s = src('system-principles.js')
  assert.equal(systemPrinciples.id, 'system-principles')
  assert.equal(systemPrinciples.slug, 'principles')
  assert.match(s, /principle-loop\.svg/)
  assert.match(s, /principle-memory\.svg/)
  assert.doesNotMatch(s, /fish\(|postFish\(|local\(|innerHTML/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现页面**

迁旧 `pages/principles.js` 的内容，保留两张图、六个理论卡、开发者的话；图片加 `loading="lazy"`。不请求任何插件路由。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/pages.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workbench/assets/pages/system-principles.js workbench/test/pages.test.mjs
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "feat(workbench): 系统原理静态页"
```

---

### Task 18: 收尾、无硬编码审计、README 与验收清单

**Files:**
- Modify: `workbench/assets/app.css`
- Modify: `workbench/test/assets.test.mjs`
- Modify: `workbench/README.md`
- Test: `workbench/test/assets.test.mjs`

**Interfaces:**
- Consumes: 前 17 个任务。
- Produces: P5 验收状态；旧文件仍保留，只标记不再引用。

- [ ] **Step 1: 写收尾测试**

在 `test/assets.test.mjs` 追加：

```js
import { readdirSync } from 'node:fs'
const list = (dir) => readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => f.endsWith('.js'))

test('新页面与新通道没有 innerHTML', () => {
  const files = [...list('assets/pages'), 'app.js', 'nav.js', 'config-form.js',
    ...list('assets/channels').map((f) => 'channels/' + f)]
  for (const f of files) assert.doesNotMatch(read(f), /innerHTML/, f)
})

test('窄屏与长文本有兜底', () => {
  const css = read('app.css')
  assert.match(css, /@media\s*\(max-width:\s*900px\)/)
  assert.match(css, /overflow-wrap:\s*anywhere/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
})

test('旧文件只保留、不被新外壳或新页面引用', () => {
  const app = read('app.js') + read('nav.js')
  const pages = list('assets/pages').map((f) => read('pages/' + f)).join('\n')
  for (const old of ['pages/overview.js', 'pages/bili.js', 'pages/memory.js', 'pages/env.js',
    'pages/tools.js', 'pages/data.js', 'pages/principles.js', 'channels.js']) {
    const re = new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    assert.doesNotMatch(app, re)
    assert.doesNotMatch(pages, re)
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/assets.test.mjs`
Expected: FAIL，CSS 缺少窄屏 / 换行 / 焦点 / reduced-motion，或新外壳仍引用旧页面。

- [ ] **Step 3: 补 CSS 与 README**

CSS：`@media (max-width: 900px)` 单列 / 顶部条；`.x`、`.bubble`、`.quote`、`.log-line`、`.vbody`、`.doc` 加 `overflow-wrap:anywhere`；`:focus-visible` 2px `--accent` 外圈；`prefers-reduced-motion: reduce` 关闭淡入和状态点过渡；画面 `max-height:50vh`。

README：把八页说明改成四页 IA 与二级页签；写清旧 hash 兼容一个版本、主题存储键、通道适配器 / 页面注册表、测试命令 `cd workbench && node --test`、P0–P5 状态和未部署边界。旧文件标注“保留一个发布版本，下一版删除”。

- [ ] **Step 4: 全量测试**

Run: `cd workbench && node --test`
Expected: 全绿；原有 `server.test.mjs`、`bff.test.mjs`、`routes.test.mjs`、`security.test.mjs` 不回归。

- [ ] **Step 5: 手工验收**

按 spec 13.2 在 8710 / 8788 都运行时逐项走：默认落点、日 / 夜刷新保持、390px 窄屏、B 站五个写动作、QQ 启停 / 扫码 / 人工发送、微信画面 / 点按 / 打字 / 回车 / Esc / 允许说话 / 补扫 / 清理、系统工具白名单 / 自检 / 日志 / 备份 / 路径 / 头像、跨站 POST 403 / 错误 Host 403 / `assets/../server.mjs` 404。停 8710 验证错误态前先取得用户同意，验证完恢复。记录完成项与未完成项，不把 UI 打开写成消息收发已验收。

- [ ] **Step 6: 提交**

```bash
git add workbench/assets/app.css workbench/test/assets.test.mjs workbench/README.md
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "chore(workbench): 收尾响应式、可访问性与改版说明"
```

---

## Self-Review Notes

- Spec 4.4 配置归属逐项落在 Task 10（B 站全部）、Task 14（说话节奏）、Task 15（成长 / 通知 / 对话 / 记忆 / 工具）、Task 16（观测）；`persona` 在测试里逐个文件禁止。
- Spec 4.5 原交互窗口能力对应 Task 12（QQ）、Task 13（微信）、Task 14（总览 / 节奏 / 她 8710）、Task 8（B 站日常）、Task 16（日志 / 数据）。
- Spec 13.1 的九类自动化断言分别落在 `theme.test.mjs`、`lib.test.mjs`、`router.test.mjs`、`shell.test.mjs`、`pages.test.mjs`、`channels.test.mjs`、`assets.test.mjs`、`server.test.mjs`。
- Review Focus 五类输入的落点：`localStorage` 异常 → Task 1 的 VM 测试；配置缺失 / 类型错误 → Task 2 的 `parseList` 与 Task 10 的 null-safe 断言；上游不可达 → 各页面 `errorText` / `writeError` 的源码断言与 Task 18 手工错误态；文本注入 → Task 18 的 `innerHTML` 扫描；长文本与窄屏 → Task 18 的 CSS 断言与 390px 手工验收。
- 旧文件不删除：Task 18 只验证“不被引用”；删除旧 `pages/*.js` / `channels.js` / `legacy-channels.js` 留到验收后的下一个版本，并须单独取得删除批准。
- 所有任务都以 `node --test` 的可执行断言结束；浏览器交互项在 Task 18 Step 5 手工验收，不用单测冒充。
