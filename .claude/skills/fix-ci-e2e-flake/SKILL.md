---
name: fix-ci-e2e-flake
description: 诊断并修复本仓库（VSCode 范式桌面编辑器）在 CI 上偶发、但本地稳定通过的 Playwright e2e 失败（flake）。当用户提到 “CI e2e 偶发失败 / flaky / 本地跑没问题但 CI 挂了 / e2e 不稳定 / @p0 @p1 spec 偶尔红”，或贴出 Playwright 的 toHaveCount / toBeVisible / timeout 报错、`expect(locator)` call log 时使用。聚焦“区分真回归 vs 环境/写法 flake”的通用流程；具体哪个 spec、哪条断言由 agent 当场判断。
disable-model-invocation: true
---

# 修复 CI 偶发 e2e 失败（flake）

本仓库 e2e 用 Playwright + `_electron` 启动真实 Electron，通过 `window.__E2E__` 探针调服务。CI 偶发、本地稳过的失败**绝大多数不是产品 bug，而是断言写法不够鲁棒，或 CI 环境噪音（extension host 崩溃、进程启动慢、定时器竞态）**。核心套路：**先判定是不是真回归 → 读 Playwright call log 看“失败形态” → 把断言收敛到“被测对象本身”而非全局状态 → 本地验证 happy path 不破 → 把经验追加到本文件案例库**。

> ⚠️ 第一原则：**不要为了让 CI 变绿而削弱对被测行为的覆盖**。鲁棒化 = 排除背景噪音干扰，同时对“被测对象自身行为”的断言强度不变。如果只能靠放宽真正的被测断言才能过，那它可能是真回归，别盖住。

## 判定流程

### 1. 先区分：真回归 vs flake
- **本地能否复现**：让用户/自己本地重复跑同一个 spec 多次（`pnpm exec playwright test <spec> --repeat-each=5`）。本地稳过 + CI 偶发 → 强烈指向环境/写法 flake；本地也能挂 → 当真回归查。
- **失败是否“间歇”**：CI 上同一 commit 重跑能过 = flake 特征。每次必挂 = 回归。
- **看改动历史**：失败 spec 相关代码最近有没有动过（`git log -p` 该 spec 及被测模块）。刚改完就挂，优先怀疑回归。
- **核对 checkout 路径**：堆栈里的绝对路径（如 `D:\a\universe-editor\universe-editor\...` 是 CI runner 路径）要和你正在改的工作目录对得上语义；本仓库常有并行 checkout，别改了一份没在 CI 跑的代码。

### 2. 读 Playwright call log 的“失败形态”
报错下方的 `Call log` 是金矿，不同形态指向不同根因：

- **count 在多个值之间反复波动**（如本案的 `1 × ... "1"` / `... "2"` 交替）→ **有背景元素间歇出现/消失**。被测对象可能已正确就位，是别的东西在干扰全局计数。→ 多半是断言用了**全局选择器 + 精确 count**，被背景噪音破坏。
- **count 稳定停在某个非期望值**（一直 1，期望 0）→ 被测对象自身没按预期消失/出现，更可能是**真回归**或定时器没触发。
- **`waiting for locator` 一直 0 个**（期望可见却始终找不到）→ 渲染没发生 / 探针没触发 / 选择器写错 / 时序太早。
- **timeout 且毫无元素** → 上游步骤（命令、探针、waitForRestored）就没成功，往前看前置步骤。

### 3. 定位背景噪音来源（flake 的常见元凶）
CI 资源紧张、无显卡、进程调度抖动，会触发本地不出现的副作用。已知噪音源：
- **Extension host 偶发崩溃**：`apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` 的 `_handleCrash()` 会在崩溃时发**非 sticky Warning toast**（`"…extension host crashed… Restarting…"`）和（超限时）**sticky Error toast**。这些 toast 会污染任何对 `notification-toast-item` / `notification-center-item` 做**全局 count** 的断言。
- **进程启动慢 / 重启类用例**：见记忆 `e2e-relaunch-flake-windows` —— 重启类 @p1 报 “Process failed to launch” 多为环境问题，非回归。
- **定时器竞态**：auto-hide / auto-read 等 renderer 定时器在 CI 上可能晚几百毫秒触发，固定 `waitForTimeout` 易被甩开。

### 4. 应用最小且鲁棒的修复
按失败形态选手段，**优先对齐同文件里已经鲁棒化的兄弟断言**：
- **背景噪音污染全局 count** → 把选择器用 `.filter({ hasText: '<被测对象的唯一文案>' })` 收敛到被测对象本身，再断言其 count/可见性。让背景 toast 进出都不影响断言。
- **定时器/异步竞态** → 用 `expect(...).toHaveCount/toBeVisible({ timeout })` 或 `expect.poll(...)` 轮询，**别用固定 `waitForTimeout` 再硬断言**（除非是“验证某物在 N 秒后仍在”这种必须等待的语义）。
- **前置步骤噪音** → 用例开头先 `clearAll` / 重置到干净状态（本仓库通知用例已用 `workbench.action.notifications.clearAll` 清理启动噪音）。
- **纯环境型 flake（启动失败等）** → 若确认非回归，不要强改产品代码；记录到记忆/案例库，必要时与用户确认是否给该 spec 加重试或标注。

### 5. 验证
```bash
# 跑改动的 spec，happy path 不能破
pnpm --filter @universe-editor/editor exec playwright test e2e/specs/<spec>.ts
# 想压一下稳定性：
pnpm --filter @universe-editor/editor exec playwright test e2e/specs/<spec>.ts --repeat-each=5
# 全量冒烟（输出多，只截错误）：
pnpm e2e
```
本地无法复现 CI 的崩溃噪音是正常的——**本地验证的目标是“鲁棒化没破坏被测行为的正常路径”**，而非复现 flake 本身。

### 6. 沉淀经验
修完后，把这次的“失败形态 → 根因 → 修法”追加到下面的**案例库**，并视情况写/更新一条记忆（见仓库根 `memory/`，如已有的 `e2e-relaunch-flake-windows`）。这是本 skill 长期价值所在。

## 案例库

> 每条：失败形态 → 根因 → 修法 → 文件锚点。新经验往下追加。

### 案例 1：通知 toast 全局 count 被 extension host 崩溃 toast 污染
- **现象**：`smoke.notification.spec.ts` 的 `@p0` 用例，断言 `notification-toast-item` 全局 `toHaveCount(0)` 在 CI 偶发超时；call log 显示 count 在 `1 ↔ 2` 反复波动。本地 Windows 稳过。
- **根因**：测试通知自身 3s 后正常 auto-read 隐藏，但 CI 上 extension host 偶发崩溃，`ExtensionHostClientService._handleCrash()` 发出非 sticky Warning toast（`"…extension host crashed… Restarting…"`），恰在断言的 8s 窗口内间歇冒出，使**全局** toast count 回不到 0。波动的 `1↔2` 正是“测试 toast 之外多了一条背景 toast”的信号。
- **修法**：把第 3 步断言从全局选择器收敛到被测对象——`.filter({ hasText: 'This is a test notification.' })` 后再 `toHaveCount(0)`。与同文件步骤 5/6 早已采用的“按文本过滤、容忍背景通知”写法一致。对“测试通知自身 auto-read 消失”的覆盖强度不变。
- **锚点**：
  - spec：`apps/editor/e2e/specs/smoke.notification.spec.ts`
  - 噪音源：`apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts`（`_handleCrash`）
  - toast 渲染（每条含 `<p class="message">{n.message}</p>`，可 `hasText` 过滤）：`packages/workbench-ui/src/feedback/notifications/NotificationsToast.tsx`
  - auto-read 3s 定时器：`apps/editor/src/renderer/services/notification/NotificationService.ts`
- **教训**：凡对”可能存在背景同类元素”的列表（通知、问题面板、输出等）做断言，**默认按被测对象的唯一文案过滤，而非全局精确 count**。

### 案例 2：extension host 崩溃噪音污染「全局单值」状态（bell badge + Output 一次性 auto-reveal）—— 根治噪音源
- **现象**：同一轮 CI 偶发挂两个 spec：
  1. `smoke.notification.spec.ts` `@p0` 第 4 步 bell badge 断言 `.not.toMatch(/\d/)` 超时，received `”1”`。
  2. `smoke.output.spec.ts` `@p1` `first error log reveals Output…`，`panelVisible` context key 轮询期望 `true` 实得 `false`，10s 超时。
  本地 Windows 均稳过。
- **根因**：同一个噪音源——CI 上 extension host 子进程偶发 spawn/崩溃（`ExtensionHostClientService._handleCrash()`）——两种污染路径：
  1. 崩溃发的**非 sticky Warning toast 是未读的**，使全局 `unreadCount=1`，`NotificationStatusContribution` 把 bell text 渲染成 `”1”`。这里 bell badge 反映的是**全局 unreadCount**，`”1”` 是产品的**正确行为**，不是 bug。
  2. 崩溃会**写 error 日志**，先于测试触发 `ErrorLogAutoRevealContribution` 的**窗口内一次性** auto-reveal（`_hasRevealed=true`）。随后 spec 主动关 panel，再 `triggerUnexpectedError` 时 `_hasRevealed` 已 true，不再揭示，`panelVisible` 永远 `false`。噪音**抢占了”首个 error”语义**。
- **关键判断（为何不在 spec 层鲁棒化）**：
  - 失败 1 的 bell badge 是**全局单值**，不像案例 1 的列表可按文案 `.filter()` 收敛——要保留 `.not.toMatch(/\d/)` 的同时排除噪音，spec 层只能删/弱化断言，违反第一原则。
  - 失败 2 的 `_hasRevealed` 是**产品内部一次性状态**，spec 无法重置，除非加侵入式测试钩子。
  - 二者都不是产品 bug，被测功能（auto-read、auto-reveal）本身正确。**唯一不削弱被测断言的解法是消除噪音源本身**。
- **修法**：e2e 下**不启动 extension host**。在 `ExtensionsContribution._boot()` 开头加 `isE2E`（`window.__UNIVERSE_E2E_ENABLED__`）短路 return——等价于 VSCode 测试的 `--disable-extensions` 约定。前置确认：**没有任何 spec 依赖 extension host / SCM 功能**（`getScmSourceControlCount` 探针无 spec 调用），故零覆盖损失。一处改动根治两个 flake，两个 spec 断言保持原样。`--repeat-each=3` 共 12 case 全绿，`pnpm check` 全绿。
- **锚点**：
  - 修复点：`apps/editor/src/renderer/contributions/ExtensionsContribution.ts`（`_boot` 开头 isE2E 短路）
  - isE2E 范式：`window[E2E_PROBE_ENABLED_KEY]`（`apps/editor/src/shared/e2e/contract.ts`），既有先例 `main.tsx` / `windowActions.ts`
  - 噪音源：`ExtensionHostClientService._handleCrash`（Warning toast）+ 崩溃 error 日志
  - 失败 1 机制：`NotificationStatusContribution`（bell text = String(unreadCount)）
  - 失败 2 机制：`ErrorLogAutoRevealContribution`（`_hasRevealed` 一次性标志）
- **教训**：当噪音污染的是**全局单值 / 一次性内部状态**（而非可过滤的列表），spec 层无法在不削弱被测断言的前提下隔离它——这时正解是**从源头消除噪音**（e2e 禁用与被测功能无关的子系统），而不是改 spec。先 grep 确认该子系统无 spec 依赖，再门控。

### 案例 3：LSP 冷启动类 spec 被 30s test 级超时击穿（outline 硬失败 + 一组冷启动 flaky）
- **现象**：一轮 CI 里 `smoke.outline.spec.ts` `@p1`（切文件后符号消失回归测）**硬失败**——`retries:1` 重试仍挂；同轮另有 3 个 flaky（重试救回）：`smoke.editor.spec.ts` `@p0`（newUntitledFile 挂 Monaco）、`smoke.editorResolver.spec.ts` `Reopen With…`、`smoke.peekNavigation.spec.ts`。本地稳过。
- **判定关键——重试能否救回是分水岭**：retry 救得回的是瞬时竞态（flake）；**救不回的 outline 是结构性超时**，每次都撞同一堵墙。看失败形态：outline 是**超时**（poll 到一半 test 被 kill），不是符号拿到 `[]`（后者才是 LSP 真挂/回归）。
- **根因**：
  1. **outline 硬失败**：`playwright.config.ts` 全局 `timeout:30_000`（每 test 30s），但 outline spec 自己写了累计约 115s 的 poll 预算（单 poll 20s，`OutlineService` retry budget 甚至 180s，注释明说 “cold tsserver start can take a minute or more”）。**作者意图给宽预算，却被 30s test 上限拦腰截断**——CI 上 tsserver 冷启动 + 4 Electron 抢 2 核,30s 内出不来符号,test 在第一个 poll 就被杀,后面 20s poll 根本用不上。本地 tsserver 热/机器快,30s 够,故本地不复现。
  2. **3 个 flaky**：冷启动竞态被默认 5s `expect` 超时甩开（@p0 是 Monaco 首次懒加载首帧 >5s）；editorResolver 是 `keyboard.type('File')` 后立刻 `Enter`,与 QuickPick 异步过滤渲染抢时序,旧列表还在就回车选错项。
  3. **放大器**：`workers:4` 在 2 核 runner 上,4 个 Electron 互相饿死冷启动,把"勉强够"推过临界,Windows 尤甚。
- **修法（均不削弱被测断言）**：
  1. 给 LSP 冷启动 spec 加 `test.slow()`（×3 → 90s test 超时），匹配 spec 里已有的 20s poll 和 service 的 180s retry 预算：`smoke.outline` / `smoke.peekNavigation` / `smoke.markdownLsp` 在 test body 首行调 `test.slow()`；`smoke.gotoSymbol` 三个 case 在 `describe` 内顶部调一次 `test.slow()` 覆盖全部。
  2. CI 上抬 expect 默认超时：`expect.timeout = process.env['CI'] ? 10_000 : 5_000`（对齐冷启动首帧,本地仍 5s 抓真延迟）。
  3. CI 上降并行：`workers = process.env['CI'] ? 2 : 4`（牺牲墙钟换稳定,缓解 2 核争抢）。
  4. editorResolver QuickPick：把 `type+Enter` 改成**先 poll 到目标项可见再确认**——`await expect(page.getByRole('option',{name:'File Editor'})).toBeVisible()` 后再 `Enter`,对齐 peek 的 poll-press 范式。
- **本地验证产物坑（重要）**：本地直接在 `apps/editor` 里 `electron-vite build` + `playwright test` 会让所有 LSP 类 spec 拿到空符号 `[]`/`getOutlineSymbols is not a function`——因为**绕过了 LSP 产物链**。e2e 跑的是 `out/` 产物 + 从源 `extensions/*/dist` 加载内置扩展;正确链路是根 `pnpm e2e`（= `turbo build` + editor e2e）。若手动跑单 spec,先确保 `pnpm ext:build`（生成 `extensions/{typescript,markdown}/dist`）与 `packages/extension-host/dist`、`vendor/typescript-language-server` 都在,否则 typescript 扩展因缺 `UNIVERSE_TSLS_CLI` 对应产物而不注册 provider,outline/gotoSymbol 全空。`.runtime-resources/` 仅打包需要,dev/e2e 非打包模式从源 dist 加载。
- **锚点**：
  - 配置：`apps/editor/e2e/playwright.config.ts`（`timeout` / `expect.timeout` / `workers`）
  - spec：`apps/editor/e2e/specs/smoke.{outline,peekNavigation,markdownLsp,gotoSymbol,editorResolver}.spec.ts`
  - service 预算：`apps/editor/src/renderer/services/languageFeatures/OutlineService.ts`（`PULL_RETRY_BUDGET_MS=180_000`）
  - LSP 产物链：`apps/editor` `ext:build` / `runtime:stage` 脚本；`extensions/typescript/src/extension.ts`（缺 `UNIVERSE_TSLS_CLI` 即不激活）
- **教训**：spec 内 poll 预算（20s×N）与 service retry 预算（180s）远大于全局 test `timeout`（30s）时,**test 级超时才是真正的天花板**,宽 poll 是摆设——CI 冷启动会精准命中这条缝。对依赖子进程冷启动的 spec,test 超时要显式抬到匹配其 poll 预算（`test.slow()` 或 `setTimeout`）。retry 能救回=瞬时竞态,救不回=结构性问题（超时/真回归）,这是第一个该看的信号。

### 案例 4：outline 在 CI「每次必挂 + 拿到空符号 []」——根因是 CI 漏装非 workspace 的 vendor 依赖（伪 flake，实为产物缺口）
- **现象**：`smoke.outline.spec.ts` `@p1`「keeps showing symbols after switching files」在 **Windows + Ubuntu 都总是失败**（retry 救不回），`expect.poll(20s)` 拿到 `Received: []`（符号恒空）。本地稳过。同轮 Ubuntu 另有 `smoke.peekNavigation` Enter-follow 偶发 flaky（这个才是真竞态）。
- **判定关键——"总是挂 + received 空 + retry 救不回" 三连 = 不是 flake 是结构性缺口**：按速记 9,救不回先排除瞬时竞态；按速记 1,received 稳定为 `[]`（而非波动）指向"被测对象自身没就位",更像真问题。再按速记 11 顺产物链查,而不是去 spec 层加超时（加了也没用，provider 根本没注册）。
- **根因（产物链断在 CI 配置，不在产品代码）**：
  1. outline 是**唯一依赖 typescript LSP** 的 e2e spec（gotoSymbol/peekNav/markdownLsp 全走 **markdown** LSP）。
  2. typescript 扩展激活硬依赖 `UNIVERSE_TSLS_CLI`/`UNIVERSE_TSLS_TSSERVER`（`extensions/typescript/src/extension.ts:53` 缺失即 `return`，不注册任何 provider），二者由 main 的 `resolveTsServerPaths()` 指向 `vendor/typescript-language-server/node_modules/.../cli.mjs`+`tsserver.js`。
  3. `vendor/typescript-language-server/node_modules` **不在 pnpm workspace 内**（npm 子项目，`node_modules` 被 .gitignore），只由 `scripts/release/vendor-install.mjs` 装，而该脚本仅 `agent:build`/`runtime:stage`/`package:win` 调用。
  4. CI 的 e2e job 只跑 `pnpm install --frozen-lockfile` + `pnpm build`，**从未装这个 vendor**（`git log -S vendor-install -- .github/workflows/ci.yml` 为空 = 该 spec 自 `4a1443f` 引入起在 CI 就 100% 挂，只是被误当 flake）。
  5. 对照：markdown 扩展 deps 为 `{}`，进程内直接 `createMdServer`，无需 vendor → 所以 markdown 系 spec 在 CI 能跑、typescript outline 全空。这个"一个 LSP 能跑一个不能"的不对称是最强信号。
- **修法**：在 e2e job 的 Build 步骤前加一步 `npm --prefix vendor/typescript-language-server ci`。**不能**直接调完整 `vendor-install.mjs`/`agent:build`——它还遍历 `claude-agent-acp` submodule，而 e2e job 的 checkout 没有 `submodules: recursive`（只有 package-windows 有），submodule 为空时脚本 `exit(1)`。故只精准装 typescript-language-server 这一个 vendor。Linux/Windows 共用该步（不加 `if:`）。被测断言一字未改。
- **同轮 peekNavigation flake**：是真竞态——Enter-follow 那步 `expect.poll` 的 10s 窗口在 CI 冷启动下被甩开，而 `test.slow()` 已给 90s test 预算，poll 窗口才是真天花板（速记 10）。把窗口按 CI 分档 `process.env['CI'] ? 20000 : 10000`，poll-press 范式不变。
- **锚点**：
  - CI 修复点：`.github/workflows/ci.yml`（e2e job，Build 前加 vendor `npm ci`）
  - 产物依赖链：`extensions/typescript/src/extension.ts:53`（缺 env 即不激活）→ `apps/editor/src/main/services/extensionHost/{extensionHostMainService.ts:195,tsServerPaths.ts}` → `scripts/release/vendor-install.mjs`（`VENDOR_DIRS`）
  - vendor tracked 面：`vendor/typescript-language-server/{package.json,package-lock.json}` 入库、`node_modules` ignore
  - peek 窗口分档：`apps/editor/e2e/specs/smoke.peekNavigation.spec.ts`
- **教训**：本地稳过 + CI **每次必挂** + received **空** + retry **救不回**，这是"伪 flake"——根因往往是 CI 漏装某个运行时产物（尤其**非 pnpm workspace 的 vendor**：`pnpm install`/`pnpm build` 不会碰它）。别去 spec 层加超时（provider 没注册，等多久都是空）。鉴别捷径：**同类功能里"A 能跑 B 不能"的不对称**（md LSP ✓ / ts LSP ✗）——差异处就是缺的那环。修 CI 时注意 vendor-install 可能连带 submodule 依赖，按需只装用得到的那个 vendor，别引入 e2e job 没 checkout 的 submodule。

### 案例 5：peekNavigation「20s 窗口仍超时，停在 a.md」——根因是 poll-press 盲按 Enter 污染被测对象自身（测试设计缺陷，非产品 bug）
- **现象**：`smoke.peekNavigation.spec.ts` `@p1`「Enter follows the reference to the target file」在 Ubuntu CI 偶发挂，`expect.poll` 20s 超时，received 稳定为 `…/a.md`（期望含 `other.md`）。本地 Windows 稳过（每次 ~3.2s）。**注意这是案例 4「同轮 peekNavigation flake」那条的续集**——案例 4 当时只把 poll 窗口从 10s 抬到 20s，但**没根治**，现在 20s 仍挂，说明不是单纯时序。
- **判定关键——窗口已加宽仍超时 + received 稳定（非波动）= 不是"等不够"，是被测对象进不去就位状态**：按速记 1，received 稳定 `a.md`（非波动）指向"被测对象自身没就位"，更像结构性问题而非背景噪音。按速记 13，先怀疑 spec 自己的 poll-press 范式有没有副作用。
- **根因（测试自污染，产品无 bug）**：spec 用 `expect.poll` **盲按** `page.keyboard.press('Enter')` 来"避免 racing the open"。但 peek 是 `peekDefinition` fire 后**异步**打开的；按键落到**当前 DOM 焦点**：peek 没开时焦点在编辑器 `TEXTAREA.inputarea`。于是早期的 Enter **被打进编辑器**，在光标 (5,12)（链接 `[cross](other.md#gamma)` 内）插入换行（诊断实测：3 次 Enter 后光标从 (5,12) → (8,1)，live model 被改），**打断链接**；而 `peekDefinition` 的异步解析读到的是已损坏的 live model → 解析为空 → peek **永不打开** → 引用树永不聚焦 → Enter 永远在编辑器里空转 → 活动编辑器恒为 a.md。本地快、peek 在第一次 Enter 前就开好并聚焦（诊断：iter#0 即 `inRefTree=true`），故不复现；慢速 CI（xvfb + 2 核抢 4 worker）peek 开得慢，污染抢先。
- **判定捷径（诊断脚本）**：写一次性 diag spec，fire peek 后**盲按几次 Enter**并打印 `document.activeElement` 类名 + `getActiveEditorCursor()`。看到"未聚焦 peek 时 activeElement=TEXTAREA + 光标随 Enter 递增行号" = 实锤自污染。本地即可复现机制（无需复现 CI flake 本身）。
- **修法（不削弱被测断言）**：**把 Enter 按键门控在"引用树已聚焦"上**——只有 peek 树持有 DOM 焦点时才按 Enter，否则只轮询不按，杜绝编辑器污染。按套路 F「spec 通过探针调，不戳 DOM」加探针 `isReferencePeekFocused()`（`document.activeElement?.closest('.ref-tree')`，复用产品 `PeekNavigationContribution` 同款 `.ref-tree` 检测）。最终断言仍是 `getActiveEditorUri()` toContain `other.md`，被测行为（聚焦的 peek 里 Enter→跳转）覆盖强度不变。本地 `--repeat-each=5` 全绿，typecheck+lint 干净。
- **锚点**：
  - spec：`apps/editor/e2e/specs/smoke.peekNavigation.spec.ts`（poll 谓词内先 `isReferencePeekFocused()` 再 `press('Enter')`）
  - 新探针：`apps/editor/src/shared/e2e/contract.ts`（`isReferencePeekFocused`）+ `apps/editor/src/renderer/e2e/probe.ts`（实现）
  - 产品检测同款选择器：`apps/editor/src/renderer/contributions/PeekNavigationContribution.ts`（`active.closest('.ref-tree')`）
- **教训**：**`expect.poll` 里"盲按按键"是危险范式**——按键落到当前焦点，被测 UI 未就位时会打进别的控件（这里是编辑器），**污染被测对象自身的状态**（改文档→破坏 fixture→连锁让被测功能根本无法触发）。慢速 CI 把"按键落点"的竞态放大。正解是**把按键门控在"目标已就位/聚焦"的前置条件上**（探针读状态），而不是盲按 + 加宽窗口。加宽窗口对自污染型失败无效（多按几次只会污染更多）。


### 案例 6：disposableLeak「whenRestored 评估时 Execution context was destroyed」——根因是重启 PO 末步用裸 evaluate，没对齐同文件已加固的兄弟方法
- **现象**：`smoke.disposableLeak.spec.ts` `@p1`「Restart Editor leaves no un-disposed Disposables」仅在 Ubuntu CI 偶发挂，报 `page.evaluate: Execution context was destroyed, most likely because of a navigation`，栈顶在 `WorkbenchPO.ts:151` 的 `waitForRestartRestore()` 末步 `this.page.evaluate(() => window.__E2E__!.whenRestored())`。本地 Windows 稳过。
- **判定关键——报错是 Playwright 基础设施错（"导航中评估上下文被销毁"），不是被测断言失败**：失败的不是 `expect(report).toBeNull()` 这个被测断言，而是 PO 的导航等待步骤，被测行为（leak 检测）根本没跑到。按速记 5，**同文件兄弟方法 `waitForRestored()`（47-63 行）早已针对完全相同的 "Execution context was destroyed" 做了"重试 + 重等探针"加固**，而 `waitForRestartRestore()` 第 151 行那次 `whenRestored()` 是**遗留的裸 evaluate**——这就是该对齐的薄弱点。
- **根因（harness/PO 时序，产品无 bug）**：`restartEditor` → `hostService.restart()` → IPC → main `win.reload()`，reload 是 IPC 异步的。`waitForRestartRestore()` 注册 `load` 监听 → fire 命令 → `await load` → `waitForFunction(__E2E__)` → 裸 `evaluate(whenRestored)`。在慢速 CI（xvfb + 2 核抢 4 worker）上，reload 导航尚未完全 commit 时这次 evaluate 与上下文切换重合，执行上下文被销毁抛错。本地快、reload 在评估前已 commit，故不复现。
- **修法（不削弱被测断言）**：把"对 context 销毁鲁棒的 whenRestored 评估"抽成共享私有方法 `_evaluateWhenRestored()`（捕获 `Execution context was destroyed` → 重等 `domcontentloaded` + `__E2E__` → 重试，上限 3 次），让 `waitForRestored()` 与 `waitForRestartRestore()` 末步都改用它。一处加固消除遗留薄弱点，两处对齐，被测断言一字未改。本地 `--repeat-each=3`（6 case）全绿，e2e tsconfig typecheck + eslint 干净。
- **锚点**：
  - 修复点：`apps/editor/e2e/pages/WorkbenchPO.ts`（新私有方法 `_evaluateWhenRestored`；`waitForRestored` 与 `waitForRestartRestore` 末步复用）
  - 重启机制：`apps/editor/src/renderer/actions/windowActions.ts`（`RestartEditorAction` → `IHostService.restart()` → main `win.reload()`）
  - 探针 whenRestored：`apps/editor/src/renderer/e2e/probe.ts`（`lifecycleService.when(LifecyclePhase.Restored)`）
- **教训**：**凡是"fire 后页面会导航/reload，再 `page.evaluate` 探针"的 PO 步骤，evaluate 都要对 `Execution context was destroyed` 鲁棒（重等探针就绪后重试）**，因为慢速 CI 上导航 commit 时机会与评估重合。若同文件已有兄弟方法（如 `waitForRestored`）针对此做过加固，**新/遗留的同类步骤必须对齐复用**——别留裸 evaluate（速记 5）。这类失败的标志：报错是 Playwright 的 "context destroyed/navigation" 而非被测断言本身。


### 案例 7：gotoSymbol「activeEditorLanguageId poll 5s 超时，received 恒空 ""」——根因是 spec 硬编码 `{ timeout: 5000 }` 盖掉了 config 的 CI expect 分档
- **现象**：`smoke.gotoSymbol.spec.ts` `@p1`「opens one quick pick…jumps the cursor」在 Windows CI 偶发挂，第一步 `expect.poll(() => getContextKey('activeEditorLanguageId'), { timeout: 5000 }).toBe('markdown')` 超时，received 稳定为 `""`（context key 初值）。本地稳过。
- **判定关键——received 稳定空（非波动）+ 这一步等的是「编辑器/Monaco 首帧就位」而非 LSP**：按速记 1，received 稳定 `""` 指向被测对象自身没就位；这步只是等打开 .md 后语言 id 被设上（Monaco 懒加载首帧），是案例 3「@p0 newUntitledFile 挂 Monaco 首帧 >5s」同型的冷启动首帧问题，不是符号/LSP。
- **根因（spec 局部超时盖掉全局 CI 分档）**：`playwright.config.ts:11` 已**特意**把 CI 的 `expect.timeout` 分档为 `10_000`（注释明说为 Monaco lazy-load / LSP warmup 的 cold first-frame 留余量），但这些 spec 在这一步**硬编码了 `{ timeout: 5000 }`**，把 config 的 CI 值盖回 5s——而 5000 恰好等于本地默认，等于 CI 分档对这步**完全失效**。CI 上 2 核抢 4(降档后 2) worker，Monaco 首帧 >5s 时被甩开。这是 config 加 CI 分档**之前**留下的遗留局部超时（速记 5：同类断言里别处已享受全局分档，这步还钉死 5s = 遗留薄弱点）。同型散落在 4 个 spec：gotoSymbol(×3)、peekNavigation、markdownLsp、markdownPreview。
- **修法（不削弱被测断言）**：删掉这 4 个 spec 里 `activeEditorLanguageId` poll 的显式 `{ timeout: 5000 }`，让它走 config 默认（CI 10s / 本地 5s）。断言 `.toBe('markdown')` 一字不改；本地仍 5s 抓真延迟，CI 自动享受 10s 冷启动余量。**刻意只改触发 flake 的这个谓词**——specs 里还有大量其它 `{ timeout: 5000 }`（editorTabDnD/explorer/history 等稳过用例），无差别批量改属过度修改，违反最小鲁棒化原则，留作潜在隐患不动。本地 gotoSymbol 3 case 全绿，e2e tsconfig typecheck + eslint 干净。
- **锚点**：
  - 修复点：`apps/editor/e2e/specs/smoke.{gotoSymbol,peekNavigation,markdownLsp,markdownPreview}.spec.ts`（删 `activeEditorLanguageId` poll 的 `{ timeout: 5000 }`）
  - 被盖掉的全局分档：`apps/editor/e2e/playwright.config.ts:11`（`expect.timeout = CI ? 10_000 : 5_000`）
- **教训**：config 已按 `process.env['CI']` 给 `expect.timeout` 做了冷启动分档时，**spec 里任何硬编码 `{ timeout: 5000 }` 都会把 CI 分档盖回本地值**（5000===本地默认，等于分档失效）。对「等编辑器/Monaco 首帧就位」这类冷启动敏感步骤，**别在 poll 里写死超时，让它继承 config 默认**，CI 才能吃到加宽窗口。与案例 3 的 `test.slow()` 互补：`test.slow()` 抬 test 级天花板，去掉局部 `timeout` 让 expect 级吃到 CI 分档——二者都是「让真正的天花板匹配冷启动预算」。

### 案例 8：editorTabDnD「`EBUSY: resource busy or locked, rmdir` in finally」——清理竞态，非断言失败，`fs.rm` 缺 Windows 重试
- **现象**：`smoke.editorTabDnD.spec.ts` `@p1`「drag tab to another group moves the editor」在本地 Windows 偶发挂，报 `Error: EBUSY: resource busy or locked, rmdir 'C:\...\Temp\ue2-tabdnd-XXX'`。栈顶在 spec **末尾 `finally` 的 `fs.rm(tmpDir)`**（line 120），而被测断言（tab 移动到另一 group，line 113-118）此前已全部通过。
- **判定关键——报错是 Node `fs` 的 `EBUSY rmdir`、栈在 `finally` 清理步，不是被测断言失败**：和案例 6（context destroyed）同类——失败的是 harness/清理基础设施，不是 `expect`。被测行为正确，flake 在 teardown。
- **根因（Windows 文件锁清理竞态，产品无 bug）**：spec 自建 tmp workspace（`mkdtemp` + 写 alpha/beta 两文件）→ `openWorkspace(tmpDir)`。测试体结束后**fixture 才 `closeApp`**（`electronApp.ts` 的 `await use(app)` 之后），所以 spec 自己的 `finally` 删 tmpDir 时 **Electron app 仍打开着这个 workspace**：编辑器打开的两个 pinned 文件句柄 + chokidar 目录 watcher 在瞬时窗口内仍占着目录，Windows 上 rmdir 即 `EBUSY`。`force: true` 只吞 ENOENT，**不重试 EBUSY**。本地快/句柄释放及时则不复现。为何独此 spec 偶发：它 split 两个 group、同时开 alpha/beta 两 pinned 文件，结束时占用句柄最多、释放最慢，EBUSY 窗口被放大（兄弟 spel 如 explorerDnD 仅开一个目录、句柄少）。
- **修法（不削弱被测断言）**：给该 `fs.rm` 加 `maxRetries: 10, retryDelay: 200`——Node `fs.rm`/`rm` 自带的、专为 Windows `EBUSY/EPERM/ENOTEMPTY` 设计的重试退避，骑过句柄释放窗口。被测断言一字未改。本地 `--repeat-each=5` 全绿，e2e typecheck + eslint 干净。**同型裸清理已一并对齐**：`grep "fs\.rm\(|rmSync\("` 全量排查后，把所有 openWorkspace/tmp-workspace 类的裸 `{ recursive, force }`（无重试）都补上同款 `maxRetries`/`retryDelay`——`smoke.{explorerDnD,explorerExternalWatch(×3),explorerRowHeight,layoutPersistence}.spec.ts`。**例外**：`smoke.update.spec.ts` 删的是单个配置文件（非 recursive、非 app 打开的 workspace 目录），不属此锁竞态，保持裸 `force`。多数 `rmSync` 早已带 `maxRetries`（restore 类 spec），本次只补齐漏网的裸清理。
- **锚点**：
  - 修复点：`apps/editor/e2e/specs/smoke.editorTabDnD.spec.ts`（`finally` 的 `fs.rm` 加 `maxRetries`/`retryDelay`）
  - 关闭时序：`apps/editor/e2e/fixtures/electronApp.ts`（`electronApp` fixture：`await use(app)` 后才 `closeApp`，故 spec 的 `finally` 早于 app 关闭）
  - 同型裸清理（潜在隐患，暂不动）：`smoke.{explorerDnD,explorerRowHeight,explorerExternalWatch,...}.spec.ts` 的 `fs.rm(..., { recursive, force })`
- **教训**：报错是 **Node `fs` 的 `EBUSY/EPERM rmdir` 且栈在 `finally`/teardown 清理步** = Windows 文件锁清理竞态，不是被测 bug 也不是断言 flake。根因是 spec 的 `finally` 删 tmp workspace 时 Electron app 还没被 fixture 关闭（句柄/watcher 仍占目录），`force: true` 不重试 EBUSY。正解是 `fs.rm` 加 `maxRetries`/`retryDelay`（Node 内建 Windows 重试），别移到别处删或 sleep 硬等。只改触发 flake 的 spec。

### 案例 9：commandPalette「`editorFocus` poll 5s 超时，received 恒 false」——根因是 fire-once focus 命令在 Monaco 实例注册前空转，poll 只读 key 不重 fire
- **现象**：`smoke.commandPalette.spec.ts` `@p0`「Enter key does not leak…」在 CI 偶发挂，但失败行是**前置 setup**（第 91 行 `await expect.poll(() => getContextKey('editorFocus')).toBe(true)`，紧跟 `runCommand('focusActiveEditorGroup')`），**不是被测断言**（被测是后面 split 成两组 + uri 不变）。received 稳定 `false`，5000ms 超时。本地稳过。
- **判定关键——失败在前置步、received 稳定 false（非波动）、是「等编辑器/Monaco 首帧就位」类冷启动敏感步**：按速记 1，received 稳定指向「被测对象自身没就位」；按速记 9，这是 setup 步而非被测断言失败。再按速记 13 思路看 spec 范式有无副作用——这里不是盲按键，而是**「动作 fire 一次 + poll 只读状态」的分离范式**，动作没放进 poll。
- **根因（测试范式缺陷，产品无 bug）**：`focusActiveEditorGroup` 是 **fire-once**——它 `run` 时经 `FileEditorRegistry.get()` 取 Monaco 实例才 `editor.focus()`+同步 `editorFocus`；而该实例在 `FileEditor.tsx` 的 `applyModel`（model **异步**加载后）才 `FileEditorRegistry.register`。spec 第 86 行 `monacoEditor` toBeVisible 只代表 DOM 挂载，register 尚未完成。冷启动慢时命令在 register 前触发 → `focusEditorInput` 返回 false → 静默 no-op；而第 91 行的 poll **只读 context key、从不重新 fire focus** → `editorFocus` 永远停在 false，**加宽窗口无效**（等多久都没人再去 focus）。本地快、register 在命令前已完成，故不复现。
- **修法（不削弱被测断言）**：把「fire focus 命令」**放进 poll 谓词**，每轮重 fire 直到 `editorFocus` 翻 true——抽成 PO helper `workbench.focusActiveEditorGroup()`（`expect.poll(async()=>{ await runCommand('focusActiveEditorGroup'); return getContextKey('editorFocus') }).toBe(true)`）。替换本 spec 两处同范式（第 31、91 行）+ 同型遗留薄弱点 `smoke.editorFocus.spec.ts:11`（同为 `newUntitledFile` 后立即 fire-once focus 的**前置 setup**）。其余 `editorGroupSwitch:205`/`quickAccess:83` 前面已有多步交互、Monaco 早注册，非冷启动首帧风险，不动（避免过度修改）。被测断言一字未改，本地 `--repeat-each=3`（18 case）全绿，e2e typecheck+lint 干净。
- **锚点**：
  - 修复点：`apps/editor/e2e/pages/WorkbenchPO.ts`（新 `focusActiveEditorGroup()`：fire-in-poll）；`smoke.{commandPalette,editorFocus}.spec.ts` 改用之
  - fire-once 命令：`apps/editor/src/renderer/actions/editorActions.ts`（`FocusActiveEditorGroupAction.run` → `focusEditorInput`，拿不到实例返回 false 即 no-op）
  - 实例注册时机：`apps/editor/src/renderer/workbench/editor/FileEditor.tsx:345`（`applyModel` 内 `FileEditorRegistry.register`，model 异步加载后）；`editorFocus` 同步：`apps/editor/src/renderer/services/editor/editorFocus.ts`
- **教训**：**「`runCommand(动作)` + `expect.poll(只读状态)`」是危险的分离范式**——若动作是 fire-once 且依赖某个**异步就位**的前置（这里是 Monaco 实例注册），动作在前置就位前触发会静默 no-op，而 poll 只读状态、永不重 fire → received 卡死在初值、**加宽窗口无效**（同速记 13「盲按 + 加宽无效」的近亲：根因都是「该重做的动作没进 poll」）。正解是**把动作本身放进 poll 谓词**，每轮重做直到状态满足。鉴别：失败在 setup 步 + received 稳定卡初值 + 该步在「fire 一次后只 poll 读」。

## 易踩坑速记
1. call log 的 count **波动** = 背景噪音；count **卡死在错值** = 更像真回归。先分清。
2. extension host 在 CI 偶发崩溃，会污染一切对通知做全局 count 的断言——按文案过滤。
3. 鲁棒化 ≠ 放宽被测断言。别用“变绿”掩盖真回归。
4. 异步/定时器用 `toHaveCount({timeout})` / `expect.poll`，少用固定 `waitForTimeout` + 硬断言。
5. 同一 spec 内若有的步骤已“按文案过滤”、有的还在“全局 count”，后者就是遗留薄弱点，优先对齐。
6. CI 堆栈路径是 runner 路径（`D:\a\...`），与本地工作目录语义对齐即可，别因路径不同误判改错 checkout。
7. 本地无法复现 CI 噪音是常态；本地验证目标是”没破坏 happy path”。
8. 噪音污染**列表**（可按文案过滤）→ 改 spec 收敛断言；噪音污染**全局单值 / 一次性内部状态**（bell badge、`_hasRevealed`）→ spec 层无法隔离，从源头禁用噪音子系统（先 grep 确认无 spec 依赖）。同一噪音源（extension host 崩溃）可同时打挂多个看似无关的 spec。
9. **retry 救得回 = 瞬时竞态（flake）；救不回 = 结构性问题（test 超时被击穿 / 真回归）**。这是分类第一信号,先看这个再读 call log。
10. spec 内 poll/service retry 预算（20s、180s）远大于全局 test `timeout`（30s）时,**test 超时才是真天花板**,宽 poll 是摆设。依赖子进程冷启动的 spec 要 `test.slow()` 把 test 超时抬到匹配其 poll 预算。CI 资源紧（2 核跑 4 worker）会放大冷启动,可 `workers/expect.timeout` 按 `process.env['CI']` 分档。
11. 本地手跑单 LSP spec 前确保产物链齐：`pnpm ext:build`（生成 `extensions/*/dist`）+ `extension-host/dist` + `vendor/typescript-language-server`。少了 → 符号全空 `[]` 或探针方法缺失,**是产物问题不是回归**。正规跑法是根 `pnpm e2e`。
12. **本地稳过 + CI 每次必挂 + received 空 + retry 救不回 = 伪 flake**（CI 漏装运行时产物,尤其**非 pnpm workspace 的 vendor**——`pnpm install`/`pnpm build` 不碰它）。别去 spec 层加超时,provider 没注册等多久都是空。鉴别捷径:**同类功能"A 能跑 B 不能"的不对称**(md LSP ✓ / ts LSP ✗),差异处就是缺的那环。修 CI 时:`vendor-install.mjs` 可能连带 submodule(claude-agent-acp),e2e job 没 `submodules: recursive`,只精准 `npm --prefix vendor/<x> ci` 装用得到的那个,别引入没 checkout 的 submodule。
13. **`expect.poll` 里"盲按按键"(`keyboard.press`)是危险范式**:按键落到**当前 DOM 焦点**,被测 UI 未异步就位时会打进别的控件(如编辑器 `TEXTAREA`),**污染被测对象自身**(改文档→破坏 fixture→连锁让被测功能无法触发)。慢速 CI 把"按键落点"竞态放大,且**加宽 poll 窗口无效**(多按几次只会污染更多,received 稳定卡在初值)。正解:把按键**门控在"目标已聚焦/就位"前置条件**上(探针读状态,如 `isReferencePeekFocused()`),只在就位时才按。诊断捷径:fire 后盲按几次并打印 `document.activeElement` + 光标位置,看光标是否随 Enter 递增=实锤自污染(本地即可复现机制)。
14. **报错是 `page.evaluate: Execution context was destroyed, most likely because of a navigation` = harness 时序 flake,不是被测断言失败**。凡"fire 后页面会 reload/导航,再 `page.evaluate(__E2E__...)`"的 PO 步骤,evaluate 都要对此鲁棒(捕获该错→重等 `domcontentloaded`+`__E2E__`→重试),因为慢速 CI 上导航 commit 会与评估重合。若同文件已有兄弟方法(如 `waitForRestored`)做过该加固,新/遗留同类步骤**必须对齐复用**,别留裸 evaluate(并入速记 5)。reload 类 PO 见 `WorkbenchPO._evaluateWhenRestored`。
15. **config 已按 `process.env['CI']` 分档 `expect.timeout` 时,spec 里硬编码 `{ timeout: 5000 }` 会把 CI 分档盖回本地值**(5000===本地默认=分档失效)。received 稳定空 `""` + 这步等的是"编辑器/Monaco 首帧就位"(冷启动敏感) → 查这步是否钉死了局部 `timeout`。修法:删掉该 poll 的显式 `{ timeout: 5000 }` 让它继承 config 默认,断言不动,CI 自动吃到加宽窗口。与速记 10 的 `test.slow()` 互补(一个抬 test 级天花板,一个让 expect 级吃 CI 分档)。**只改触发 flake 的那个谓词,别无差别批量改稳过用例的 5000**(过度修改)。
16. **报错是 Node `fs` 的 `EBUSY/EPERM/ENOTEMPTY rmdir`、栈在 `finally`/teardown 清理步 = Windows 文件锁清理竞态,不是被测断言失败**(同案例 6 的 harness flake 家族)。根因:spec 自建 tmp workspace→`openWorkspace`,测试体 `finally` 删 tmpDir 时 **Electron app 还没被 fixture 关闭**(`electronApp` fixture `await use(app)` 之后才 `closeApp`),打开的文件句柄 + chokidar watcher 仍占目录;`force: true` 只吞 ENOENT **不重试 EBUSY**。修法:`fs.rm` 加 `maxRetries: 10, retryDelay: 200`(Node 内建的 Windows 重试退避),断言不动。split/多 pinned 文件的 spec 句柄最多、窗口最大,故独此偶发。只改触发 flake 的 spec,别无差别改其它裸 `force:true` 清理。
17. **`runCommand(动作)` + 紧跟 `expect.poll(只读状态)` 的分离范式,若动作是 fire-once 且依赖异步就位的前置,会 received 卡死初值 + 加宽窗口无效**(案例 9)。典型:`focusActiveEditorGroup` 依赖 Monaco 实例 `FileEditorRegistry.register`(model 异步加载后才注册),`monacoEditor` toBeVisible 只是 DOM 挂载、register 未完成;冷启动慢时命令在 register 前 fire→静默 no-op,而 poll 只读 `editorFocus`、从不重 fire→恒 false。鉴别:**失败在前置 setup 步 + received 稳定卡初值(非波动) + 该步「fire 一次后只 poll 读」**。修法:**把动作放进 poll 谓词**(每轮重 fire 直到状态满足),抽 PO helper(`workbench.focusActiveEditorGroup()`)。与速记 13(盲按+加宽无效)同源——根因都是「该重做的动作没进 poll」;与速记 9 互参(失败在 setup 步≠被测断言失败)。只改冷启动首帧风险的步(`newUntitledFile`后立即 focus),前面已有多步交互的 focus(Monaco 早注册)不动。

## 关键参考路径
- `apps/editor/e2e/specs/` —— 所有 e2e spec；`@p0` 阻塞 CI，`@p1` 次级
- `apps/editor/e2e/fixtures/electronApp.ts` —— `workbench` fixture、`runCommand` / `waitForRestored` / `statusBar` 等封装
- `apps/editor/src/renderer/e2e/probe.ts` —— `window.__E2E__` 探针（`triggerUnexpectedError` 等）
- `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` —— extension host 崩溃→通知（CI 噪音主源）
- 仓库根 `memory/e2e-relaunch-flake-windows.md` —— 重启类 flake 的环境性结论

## 其它

- 后续用skill，发现有新的经验，可以自动更新本SKILL.md
