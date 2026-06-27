---
name: fix-ci-e2e-flake
description: 诊断并修复本仓库（VSCode 范式桌面编辑器）在 CI 上偶发、但本地稳定通过的 Playwright e2e 失败（flake）。当用户提到 “CI e2e 偶发失败 / flaky / 本地跑没问题但 CI 挂了 / e2e 不稳定 / @p0 @p1 spec 偶尔红”，或贴出 Playwright 的 toHaveCount / toBeVisible / timeout 报错、`expect(locator)` call log 时使用。聚焦“区分真回归 vs 环境/写法 flake”的通用流程；具体哪个 spec、哪条断言由 agent 当场判断。
disable-model-invocation: true
---

# 修复 CI 偶发 e2e 失败（flake）

本仓库 e2e 用 Playwright + `_electron` 启动真实 Electron，通过 `window.__E2E__` 探针调服务。CI 偶发、本地稳过的失败**绝大多数不是产品 bug，而是断言写法不够鲁棒，或 CI 环境噪音（extension host 崩溃、进程启动慢、定时器竞态）**。核心套路：**判定真回归 vs flake → 读 call log 的“失败形态” → 把断言收敛到“被测对象本身” → 本地验证 happy path 不破 → 经验追加到案例库/速记**。

> ⚠️ 第一原则：**不要为了让 CI 变绿而削弱对被测行为的覆盖**。鲁棒化 = 排除背景噪音干扰，被测断言强度不变。只能靠放宽真正的被测断言才能过 → 它可能是真回归，别盖住。

## 判定流程

1. **真回归 vs flake**：本地 `--repeat-each=5` 能否复现（本地稳过+CI 偶发→flake；本地也挂→回归）；同 commit 重跑能过=flake，每次必挂=回归/结构性缺口；`git log -p` 看失败 spec 是否刚改过；核对 CI 堆栈绝对路径（`D:\a\...` 是 runner 路径）语义对得上你改的目录。
2. **读 call log 失败形态**：count **波动**=背景元素间歇出现（噪音污染全局 count）；count/received **稳定停错值**=被测对象自身没就位（真回归/定时器没触发/fire-once 空转）；`waiting for locator` 恒 0=渲染没发生/探针没触发/选择器错；timeout 且无元素=往前看前置步骤。
3. **已知噪音源**：extension host 偶发崩溃（`ExtensionHostClientService._handleCrash` 发背景 toast + error 日志）；进程启动慢/重启类（记忆 `e2e-relaunch-flake-windows`）；renderer 定时器竞态（auto-hide/auto-read 在 CI 晚几百 ms）。
4. **最小且鲁棒的修复**（优先对齐同文件已鲁棒化的兄弟断言）：噪音污染**列表**→`.filter({hasText:'<被测唯一文案>'})` 收敛；噪音污染**全局单值/一次性状态**→从源头禁用无关子系统（先 grep 确认无 spec 依赖）；定时器/异步竞态→`expect.poll`/`toHaveCount({timeout})`，少用固定 `waitForTimeout`+硬断言；纯环境型→别强改产品，记录案例库。
5. **验证**：`pnpm --filter @universe-editor/editor exec playwright test e2e/specs/<spec>.ts [--repeat-each=5]`；全量 `pnpm e2e`（输出多，只截错误）。本地无法复现 CI 噪音是常态——目标是“鲁棒化没破坏 happy path”。
6. **沉淀**：把“失败形态→根因→修法”追加到案例库，并新增/更新一条速记（与案例号互相引用）。这是本 skill 长期价值所在。

## 速记（判定信号速查，先扫这里再读对应案例）

1. call log count **波动**=背景噪音；count **卡死错值**=更像真回归。先分清。
2. extension host CI 偶发崩溃，污染一切对通知做全局 count 的断言——按文案过滤。
3. 鲁棒化 ≠ 放宽被测断言。别用“变绿”掩盖真回归。
4. 异步/定时器用 `toHaveCount({timeout})`/`expect.poll`，少用固定 `waitForTimeout`+硬断言。
5. 同 spec/同文件内若有步骤已“按文案过滤/已加固”、有的还在“全局 count/裸 evaluate”，后者是遗留薄弱点，优先对齐复用兄弟方法。
6. CI 堆栈路径是 runner 路径（`D:\a\...`），语义对齐即可，别因路径不同误判改错 checkout。
7. 本地无法复现 CI 噪音是常态；本地验证目标是“没破坏 happy path”。
8. 噪音污染**列表**（可 filter）→改 spec 收敛；污染**全局单值/一次性内部状态**（bell badge、`_hasRevealed`）或**产品自身一次性动作**→spec 层无法隔离，从源头禁用噪音子系统/修产品（先 grep 确认无 spec 依赖）。同一噪音源可同时打挂多个看似无关的 spec。（案例 2/11）
9. **retry 救得回=瞬时竞态（flake）；救不回=结构性问题（test 超时击穿/真回归/产物缺口）**。分类第一信号，先看这个再读 call log。
10. spec 内 poll/service retry 预算（20s、180s）远大于全局 test `timeout`（30s）时，**test 超时才是真天花板**，宽 poll 是摆设。依赖子进程冷启动的 spec 用 `test.slow()` 抬 test 超时；CI 资源紧（2 核跑 4 worker）放大冷启动，`workers/expect.timeout` 按 `process.env['CI']` 分档。（案例 3）
11. 本地手跑单 LSP spec 前确保产物链齐：`pnpm ext:build`（生成 `extensions/*/dist`）+ `extension-host/dist` + `vendor/typescript-language-server`。缺 → 符号全空 `[]`/探针方法缺失，**是产物问题不是回归**。正规跑法是根 `pnpm e2e`。
12. **本地稳过 + CI 每次必挂 + received 空 + retry 救不回 = 伪 flake**（CI 漏装运行时产物，尤其**非 pnpm workspace 的 vendor**——`pnpm install`/`pnpm build` 不碰它）。别去 spec 层加超时。鉴别捷径：**同类功能“A 能跑 B 不能”的不对称**（md LSP ✓ / ts LSP ✗）。修 CI 时 `vendor-install.mjs` 可能连带 submodule，e2e job 没 `submodules: recursive`，只精准 `npm --prefix vendor/<x> ci`。（案例 4）
13. **`expect.poll` 里“盲按按键”（`keyboard.press`）是危险范式**：按键落到**当前 DOM 焦点**，被测 UI 未就位时打进别的控件（编辑器 `TEXTAREA`），**污染被测对象自身**（改文档→破坏 fixture），且**加宽窗口无效**（received 卡初值）。正解：把按键**门控在“目标已聚焦/就位”前置**（探针读状态，如 `isReferencePeekFocused()`）。诊断：fire 后盲按几次并打印 `document.activeElement`+光标，看是否随 Enter 递增。（案例 5）
14. **报错 `page.evaluate: Execution context was destroyed, ...navigation` = harness 时序 flake，不是被测断言失败**。凡“fire 后页面会 reload/导航，再 `page.evaluate(__E2E__...)`”的 PO 步骤都要对此鲁棒（捕获→重等 `domcontentloaded`+`__E2E__`→重试）。同文件已有兄弟方法（`waitForRestored`）做过加固时必须对齐复用，别留裸 evaluate。见 `WorkbenchPO._evaluateWhenRestored`。（案例 6，并入速记 5）
15. **config 已按 `process.env['CI']` 分档 `expect.timeout` 时，spec 硬编码 `{timeout:5000}` 会把 CI 分档盖回本地值**（5000===本地默认=分档失效）。received 稳定空 `""` + 等“编辑器/Monaco 首帧就位”（冷启动敏感）→ 查这步是否钉死局部 `timeout`，删掉让它继承 config 默认。**只改触发 flake 的那个谓词**，别批量改稳过用例。与速记 10 互补（一个抬 test 级，一个让 expect 级吃 CI 分档）。（案例 7）
16. **报错 Node `fs` 的 `EBUSY/EPERM/ENOTEMPTY rmdir`、栈在 `finally`/teardown 清理步 = Windows 文件锁清理竞态**，不是被测断言失败。根因：spec 自建 tmp workspace→`openWorkspace`，`finally` 删 tmpDir 时 **Electron app 还没被 fixture 关闭**（`await use(app)` 之后才 `closeApp`），句柄/watcher 仍占目录；`force:true` 不重试 EBUSY。修法：`fs.rm` 加 `maxRetries:10, retryDelay:200`。只改触发 flake 的 spec。（案例 8）
17. **`runCommand(动作)` + 紧跟 `expect.poll(只读状态)` 的分离范式，若动作是 fire-once 且依赖异步就位的前置 → received 卡死初值 + 加宽窗口无效**。典型：`focusActiveEditorGroup` 依赖 Monaco 实例 `FileEditorRegistry.register`（model 异步加载后），`monacoEditor` toBeVisible 只是 DOM 挂载；命令在 register 前 fire→静默 no-op，poll 只读不重 fire→恒 false。鉴别：**失败在前置 setup 步 + received 稳定卡初值 + 该步“fire 一次后只 poll 读”**。修法：**把动作放进 poll 谓词**，抽 PO helper。与速记 13 同源（该重做的动作没进 poll）。（案例 9）
18. **报错 `Test timeout of 30000ms exceeded`（而非 poll 自己的 message）+ received 是初值 = test 级超时击穿**，不是被测断言失败。重 spec（自己 `electron.launch`）前置开销大（launch+firstWindow+whenRestored+openWorkspace），若 poll 窗口 `timeout` ≥ 全局 test `timeout`（30s），test 天花板先到。常见成因：**从兄弟 spec 裁剪复制时漏抄 `test.setTimeout`/更大 poll 窗口**。修法：diff 兄弟对齐。鉴别“环境慢 vs 产物缺口”：**Ubuntu CI ✓ 但 Windows CI ✗ = 纯 Windows 慢**（进程创建贵+Defender 扫 spawn），不是产物缺失（那会两端都挂，见速记 12）。（案例 10）
19. **同一 flaky spec 二进宫、形态从「`Test timeout`」变「poll 自己的窗口超时 + received 恒初值」= 上轮只治了天花板（速记 18），真根因还在，八成是产品 bug**。60s poll 对一次性动作恒 0 ≠ 等不够，而是**那次动作根本没发生且永不重试**（fire-once 依赖异步前置）。查链路：**“响应事件去操作某个异步启动的资源”时，若资源的 in-flight 启动 Promise 没被 await，启动期事件会被静默丢弃**。修法范式：**操作前先 `await Promise.allSettled([...in-flight 启动 Promise])` 再读资源句柄**；修产品+加回归单测（pending spawn mock 模拟“事件撞 in-flight 启动”），别动 spec。（案例 11）
20. **报错 `Target page/context/browser has been closed`（区别于速记 14 的 `Execution context was destroyed`）先验证是不是 main 进程真崩**：抓 main 退出码，Windows `3221225477`=`0xC0000005` 访问违例=native 段错误（无 `render/child-process-gone` 事件、无 stderr、`crashReporter.start` 一开就不复现的 heisenbug）。**定位真回归 vs 环境放大的决定性方法是三组对照**：①单实例 `--workers=1` 重复多次 ②多实例 `--workers=6` 重复多次 ③多实例+禁用嫌疑子系统。**单实例怎么跑都不崩、只有多实例崩 = 测试并发放大的（常为第三方 native 库的）跨进程竞态**，真实用户单实例永不触发；**进程内**串行化修复无效（强力负结果），产品 try/catch 接不住段错误。正解：触发该 native 路径的用例 `tag:'@serial'` 隔离到 `--workers=1`。（案例 12）
21. **报错「Worker teardown timeout」（而非「Test timeout」或被测断言失败）+ 所有测试 pass = worker 收尾关 app 时卡死，根因在“关 app”链路，别去 spec 层找**。两步定位：①**graceful close 为何挂**——Playwright `app.close()` 走 Electron `before-quit` 的 renderer veto 链（`confirmShutdown`→各 `onBeforeShutdown` participant），任何 participant 在 headless 弹**无人应答的模态框**就让 `app.close()` 永不 resolve；②**强杀为何不彻底**——`closeApp` 超时只 `SIGKILL` **main PID**，**Windows 杀父不杀子**，node-pty/agent/ext-host 成孤儿、占管道句柄 → worker 撞 30s teardown（posix 不复现正因此差异）。修法两处互补、均不削弱断言：**Fix A 源码侧 E2E 门控**——凡 quit-chain 上会弹“headless 无人应答 modal”的 participant 按 `isE2E`（`window[E2E_PROBE_ENABLED_KEY]===true`，复用 `windowActions.ts` 先例）短路放行，让 graceful quit+`will-quit` 正常清子进程；**Fix B harness 侧 tree-kill**——`closeApp` 超时强杀改 `taskkill /pid <pid> /T /F`（Windows，`execFileSync` 同步、try/catch 吞码），非 Windows 不变。`/T` 按 parent-PID 递归，只漏 `detached:true` 独立进程组（本仓库仅外部终端打开器）。（案例 13）
22. **`page.evaluate` 里「滚动/触发后等固定 N 帧 raf 再读布局量（scrollHeight/rect）」是危险范式**：虚拟化列表（@tanstack）经 `ResizeObserver` **异步**测量进视口的行，固定帧数在慢机/并发 CI 不够，读到「估算→实测」**过渡中的瞬时值**，污染被测对象自身。**鉴别决定性信号**：`--workers=1 --repeat-each=N` 全过、`--workers=4` 全挂（received 单调爬升到某稳定值=测量收敛过程被采样）——**并发是放大器=竞态 flake，非产品回归**（与速记 9「retry 救不回=结构性」互补：retry 同样并发故救不回，但单 worker 能稳过，所以仍是 flake）。**注意 `--repeat-each` 默认按 config `workers` 跑（本仓库 4），易误判「本地也恒挂」**；必须显式 `--workers=1` 对照。修法：把「等固定帧」改为「**等布局量连续 K 帧不变（测量收敛）再采**」的 `settle()`，测的才是用户看到的稳定值；被测断言强度不变。（案例 14）

## 案例库

> 每条：现象 → 根因 → 修法 → 锚点。教训已并入对应速记。新经验往下追加。

### 案例 1：通知 toast 全局 count 被 ext host 崩溃 toast 污染（速记 1/2）
- **现象**：`smoke.notification.spec.ts` `@p0`，`notification-toast-item` 全局 `toHaveCount(0)` CI 偶发超时，count `1↔2` 波动。本地稳过。
- **根因**：测试 toast 3s 后正常 auto-read，但 ext host 偶发崩溃发背景 Warning toast，污染**全局** count。
- **修法**：断言收敛到被测对象——`.filter({ hasText: 'This is a test notification.' })` 后再 `toHaveCount(0)`，对齐同文件兄弟步骤。
- **锚点**：spec `smoke.notification.spec.ts`；噪音源 `ExtensionHostClientService._handleCrash`；toast（含 `<p class="message">`）`packages/workbench-ui/src/feedback/notifications/NotificationsToast.tsx`；auto-read `NotificationService.ts`。

### 案例 2：ext host 崩溃污染「全局单值/一次性状态」（bell badge + Output auto-reveal）——根治噪音源（速记 8）
- **现象**：同轮挂两 spec——`smoke.notification` bell badge `.not.toMatch(/\d/)` 收到 `"1"`；`smoke.output` `panelVisible` 期望 true 实得 false。本地稳过。
- **根因**：同一噪音源 `_handleCrash`：①崩溃 Warning toast 未读→`unreadCount=1`→bell text `"1"`（产品正确行为）；②崩溃 error 日志抢占首个 error→`ErrorLogAutoRevealContribution._hasRevealed` 一次性置真→后续 spec 的 reveal 失效。全局单值/一次性状态 spec 层无法 filter。
- **修法**：e2e 不启动 ext host——`ExtensionsContribution._boot` 开头 `isE2E` 短路 return（等价 `--disable-extensions`）。先 grep 确认无 spec 依赖 ext host/SCM，零覆盖损失。
- **锚点**：修复点 `ExtensionsContribution.ts`（`_boot`）；isE2E=`window[E2E_PROBE_ENABLED_KEY]`（`shared/e2e/contract.ts`，先例 `main.tsx`/`windowActions.ts`）；机制 `NotificationStatusContribution`、`ErrorLogAutoRevealContribution`。

### 案例 3：LSP 冷启动类 spec 被 30s test 级超时击穿（速记 9/10）
- **现象**：`smoke.outline` `@p1` 硬失败（retry 救不回，超时而非拿到 `[]`）；同轮 `smoke.editor`/`editorResolver`/`peekNavigation` flaky（retry 救回）。本地稳过。
- **根因**：全局 test `timeout:30_000`，但 outline spec poll 预算累计 ~115s（`OutlineService` retry 180s）——**test 上限拦腰截断宽 poll**；CI tsserver 冷启动+4 Electron 抢 2 核，30s 内出不来符号。`editorResolver` 是 `type('File')` 后立刻 Enter 抢 QuickPick 渲染。
- **修法**（均不削弱断言）：LSP 冷启动 spec 加 `test.slow()`（→90s）；`expect.timeout=CI?10_000:5_000`；`workers=CI?2:4`；editorResolver 改“先 poll 到目标项可见再 Enter”。
- **锚点**：`playwright.config.ts`（`timeout`/`expect.timeout`/`workers`）；`smoke.{outline,peekNavigation,markdownLsp,gotoSymbol,editorResolver}.spec.ts`；`OutlineService.ts`（`PULL_RETRY_BUDGET_MS=180_000`）；`extensions/typescript/src/extension.ts`（缺 `UNIVERSE_TSLS_CLI` 即不激活）。

### 案例 4：outline CI 每次必挂 + 拿到空 []——CI 漏装非 workspace 的 vendor（伪 flake/产物缺口，速记 12）
- **现象**：`smoke.outline` `@p1` 在 **Windows+Ubuntu 都总挂**（retry 救不回），`expect.poll(20s)` received 恒 `[]`。本地稳过。
- **根因**：outline 是**唯一依赖 typescript LSP** 的 spec（其余走 markdown LSP）。ts 扩展激活硬依赖 `UNIVERSE_TSLS_CLI`/`TSSERVER`（指向 `vendor/typescript-language-server/node_modules/...`），该 vendor **不在 pnpm workspace 内**（npm 子项目，`node_modules` ignore），只由 `vendor-install.mjs` 装；CI e2e job 只 `pnpm install`+`pnpm build`，**从未装它** → provider 没注册，符号恒空。不对称信号：md LSP ✓ / ts LSP ✗。
- **修法**：e2e job Build 前加 `npm --prefix vendor/typescript-language-server ci`（**不能**调完整 `vendor-install.mjs`——它遍历 `claude-agent-acp` submodule，而 e2e job 没 `submodules: recursive`）。同轮 peekNavigation flake 是真竞态，poll 窗口按 CI 分档 `CI?20000:10000`。
- **锚点**：`.github/workflows/ci.yml`（e2e job）；`extensions/typescript/src/extension.ts`（缺 env 不激活）；`scripts/release/vendor-install.mjs`（`VENDOR_DIRS`）；`vendor/typescript-language-server/{package.json,package-lock.json}` 入库、`node_modules` ignore。

### 案例 5：peekNavigation 20s 窗口仍超时停在 a.md——poll-press 盲按 Enter 污染被测对象自身（速记 13）
- **现象**：`smoke.peekNavigation` `@p1`「Enter follows the reference」Ubuntu CI 偶发挂，`expect.poll` 20s 超时，received 稳定 `…/a.md`（案例 4 加宽到 20s 没根治）。本地稳过。
- **根因**：spec 用 `expect.poll` **盲按** `keyboard.press('Enter')`；peek 异步打开前焦点在编辑器 `TEXTAREA`，早期 Enter 打进编辑器、在链接处插换行**破坏 link** → `peekDefinition` 解析空 → peek 永不打开 → Enter 永远空转。慢 CI peek 开得慢，污染抢先。
- **修法**：把 Enter **门控在“引用树已聚焦”**——加探针 `isReferencePeekFocused()`（`document.activeElement?.closest('.ref-tree')`），只在聚焦时按。断言不变。
- **锚点**：`smoke.peekNavigation.spec.ts`；新探针 `shared/e2e/contract.ts`+`renderer/e2e/probe.ts`；产品同款选择器 `PeekNavigationContribution.ts`（`.ref-tree`）。

### 案例 6：disposableLeak whenRestored 评估时 Execution context was destroyed——重启 PO 末步裸 evaluate（速记 5/14）
- **现象**：`smoke.disposableLeak` `@p1` Ubuntu CI 偶发挂，`page.evaluate: Execution context was destroyed`，栈在 `WorkbenchPO.waitForRestartRestore()` 末步 `evaluate(whenRestored)`。本地稳过。
- **根因**：`restart`→`win.reload()`（IPC 异步）；慢 CI 上 reload 导航未完全 commit 时这次裸 evaluate 与上下文切换重合被销毁。同文件兄弟 `waitForRestored()` 早已加固，此处是遗留裸 evaluate。
- **修法**：抽共享私有 `_evaluateWhenRestored()`（捕获→重等 `domcontentloaded`+`__E2E__`→重试 ≤3），两处末步复用。
- **锚点**：`WorkbenchPO.ts`（`_evaluateWhenRestored`）；`windowActions.ts`（`RestartEditorAction`→`win.reload()`）；`probe.ts`（`whenRestored`）。

### 案例 7：gotoSymbol activeEditorLanguageId poll 5s 超时 received 恒 ""——硬编码 timeout 盖掉 CI 分档（速记 15）
- **现象**：`smoke.gotoSymbol` `@p1` Windows CI 偶发挂，首步 `expect.poll(getContextKey('activeEditorLanguageId'),{timeout:5000})` received 恒 `""`。本地稳过。
- **根因**：`config` 已把 CI `expect.timeout` 分档为 10s（为 Monaco 冷启动首帧留余量），但这步**硬编码 `{timeout:5000}`** 盖回本地默认 → CI 分档失效。同型散落 4 spec。
- **修法**：删掉这 4 个 spec 里 `activeEditorLanguageId` poll 的 `{timeout:5000}`，继承 config 默认。断言不动。**只改触发 flake 的谓词**，别批量改稳过用例。
- **锚点**：`smoke.{gotoSymbol,peekNavigation,markdownLsp,markdownPreview}.spec.ts`；`playwright.config.ts:11`（`expect.timeout=CI?10_000:5_000`）。

### 案例 8：editorTabDnD EBUSY rmdir in finally——Windows 文件锁清理竞态，fs.rm 缺重试（速记 16）
- **现象**：`smoke.editorTabDnD` `@p1` 本地 Windows 偶发挂，`EBUSY: ...rmdir`，栈在末尾 `finally` 的 `fs.rm(tmpDir)`；被测断言此前已过。
- **根因**：spec 自建 tmp workspace→`openWorkspace`；`finally` 删 tmpDir 时 **Electron app 还没被 fixture 关闭**（`await use(app)` 后才 `closeApp`），pinned 文件句柄+watcher 仍占目录；`force:true` 不重试 EBUSY。split/多 pinned 文件故独此偶发。
- **修法**：`fs.rm` 加 `maxRetries:10, retryDelay:200`（Node 内建 Windows 重试退避）。同型裸清理一并对齐（explorerDnD/explorerExternalWatch 等）；单文件删除（update spec）不属此竞态，不动。
- **锚点**：`smoke.editorTabDnD.spec.ts`（`finally` 的 `fs.rm`）；关闭时序 `electronApp.ts`（`await use(app)` 后才 `closeApp`）。

### 案例 9：commandPalette editorFocus poll 5s 超时 received 恒 false——fire-once focus 在 Monaco 注册前空转（速记 17）
- **现象**：`smoke.commandPalette` `@p0` CI 偶发挂，失败在**前置 setup**（`expect.poll(getContextKey('editorFocus')).toBe(true)`，紧跟 `runCommand('focusActiveEditorGroup')`），received 恒 false。本地稳过。
- **根因**：`focusActiveEditorGroup` 是 fire-once，依赖 Monaco 实例 `FileEditorRegistry.register`（model 异步加载后）；`monacoEditor` toBeVisible 只是 DOM 挂载。冷启动慢时命令在 register 前 fire→静默 no-op；poll 只读 key 不重 fire→恒 false，加宽无效。
- **修法**：把 fire 命令**放进 poll 谓词**（每轮重 fire 直到翻 true），抽 PO helper `workbench.focusActiveEditorGroup()`。替换本 spec + `smoke.editorFocus.spec.ts`（同型前置）。已有多步交互的 focus 不动。
- **锚点**：`WorkbenchPO.ts`（`focusActiveEditorGroup()`）；`editorActions.ts`（`FocusActiveEditorGroupAction.run`，拿不到实例返回 false）；`FileEditor.tsx`（`applyModel` 内 register）。

### 案例 10：aiCommitMessage Test timeout 30000ms，SCM count 0——裁剪兄弟 spec 漏抄 test.setTimeout（速记 18）
- **现象**：`smoke.aiCommitMessage.spec.ts` `@p1` **仅 Windows CI** 失败（retry 救不回），`Test timeout of 30000ms`（非 poll message），received 恒 0。本地 Windows ✓ + Ubuntu CI ✓。
- **根因**：与兄弟 `@p0` `aiCommitMessage.generate.spec.ts` 几乎逐行相同，但漏抄 `test.setTimeout(120_000)`，poll 窗口只写 `30_000`==全局 test `timeout` → poll 是摆设；自己 `electron.launch` 前置开销大，Windows 慢→30s 击穿。Ubuntu/本地够快。
- **修法**：对齐兄弟——加 `test.setTimeout(120_000)`，poll 窗口→`60_000`。同轮 jsonOutline 符号 poll `10000`→`20000`（对齐 TS outline）。断言不动。
- **锚点**：`smoke.aiCommitMessage.spec.ts`、`smoke.jsonOutline.spec.ts`；基准 `aiCommitMessage.generate.spec.ts`、`smoke.outline.spec.ts:57`；`playwright.config.ts:6`（`timeout:30_000`）。

### 案例 11：aiCommitMessage poll 自己的 60s 窗口耗尽 SCM 恒 0——案例 10 续集，根因升级为 host-relaunch 真竞态（产品 bug，速记 8/19）
- **现象**：同 spec 仍仅 Windows CI 偶发挂，但形态变为 **poll 自己的 60s 窗口超时**（案例 10 的 setTimeout/poll 已在位生效），`getScmSourceControlCount()` 恒 0。
- **根因（产品真竞态）**：git `activate` fire-once（`workspace.rootPath` 空即 return）；spec launch 后 `openWorkspace` 切 workspace，依赖 host relaunch 重新 activate。`_onWorkspaceChanged` 只重启**已 live** 的 tier，而 `_connect` 在 `await host.start`（spawn）期间 `this._trusted` 尚未赋值——启动期 swap 落此窗口 → 事件被静默丢弃 → host pin 空 workspace → SCM 恒 0。Windows 慢 spawn 放大。**真实用户启动后立刻开文件夹也会踩**。
- **修法（修产品）**：`_onWorkspaceChanged` 开头先 `await Promise.allSettled([_startingTrusted, _startingRestricted])` 等 in-flight start settle 再读 tier 状态。加回归单测（pending `host.start` mock 模拟“swap 撞 in-flight spawn”）。e2e 断言不动。
- **锚点**：`ExtensionHostClientService.ts`（`_onWorkspaceChanged`，竞态窗口 `_connect` vs `this._trusted` 赋值）；`extensions/git/src/extension.ts`（fire-once activate）；回归测试 `__tests__/ExtensionHostClientService.test.ts`。

### 案例 12：simpleFileDialog Target page has been closed——@parcel/watcher windows backend 跨进程 native 竞态，单实例永不触发（速记 20）
- **现象**：`smoke.simpleFileDialog` `@p1`「OK switches workspace」**本地全量 e2e** 偶发挂（~1/5~1/36），`Target page...has been closed`，栈在 `QuickInputPO.waitForHidden`。同文件不切 workspace 的用例从不挂。
- **根因**：诊断 main 退出码=Windows `0xC0000005` 访问违例（native 段错误）。三组对照：单实例怎么跑都不崩、多实例才崩、多实例禁 watch 不崩 → `@parcel/watcher` 2.5.6 windows backend 在**多进程并发**重订阅（切 workspace）时 native 竞态。**进程内**串行队列修复无效（仍崩=进程间竞争）。真实用户单实例永不触发。
- **修法**：触发用例 `tag:'@serial'` 隔离到 `--workers=1`——`pnpm e2e` 与 `ci.yml` 各拆并行趟（`--grep-invert "@visual|@serial"`）+串行趟（`--grep @serial --workers=1`，CI 串行步限 `matrix.shard==1`）。不改产品、不削弱断言、保留 watch 覆盖。
- **锚点**：`smoke.simpleFileDialog.spec.ts`（`@serial`）；`apps/editor/package.json`（`"e2e"` 两趟）；`.github/workflows/ci.yml`（e2e job 两步）；噪音源 `fileWatcherMainService._subscribe`。

### 案例 13：Worker teardown timeout 30000ms（所有测试 pass）——graceful close 被 headless modal 卡死 → SIGKILL 只杀 main PID → Windows 孤儿进程树阻塞 teardown（速记 21）
- **现象**：仅 Windows CI，`Worker teardown timeout of 30000ms exceeded` + `1 error was not a part of any test`，而所有测试 `passed`。最后运行的 spec 是 terminal(node-pty)/windows(多窗口)/sessionChanges(ACP session)。本地 Windows+Ubuntu CI 不复现。
- **根因（两段链路）**：①graceful close 卡死——`app.close()`→Electron `before-quit`→`confirmQuit`→renderer veto→`SessionShutdownParticipant._maybeVeto`，有 `running` session 时弹 `_dialog.confirm` 模态框，headless 无人应答 → `app.close()` 永不 resolve；②强杀不彻底——`closeApp` 10s 超时 `SIGKILL` **只杀 main PID**，因 graceful 被打断 `will-quit`（清子进程）没跑 → node-pty/ACP agent/ext host 成孤儿、占管道句柄 → worker 撞 30s。Windows 杀父不杀子，故仅 Windows。
- **修法（两处互补，均不削弱断言、零覆盖损失）**：**Fix A** `SessionShutdownParticipant._maybeVeto` 在算出 `running` 后加 `isE2E` 短路 `return false`，让 graceful quit+`will-quit` 正常清子进程（复用 `windowActions.ts` 先例；单测跑在 `window` undefined 的 renderer-node，无覆盖损失）。**Fix B** `closeApp` 超时强杀改 tree-kill：Windows `execFileSync('taskkill',['/pid',String(pid),'/T','/F'],{stdio:'ignore'})`（try/catch 吞码），非 Windows 保持 `SIGKILL`。
- **边界**：`detached:true` 仅 `hostMainService.ts` 外部终端打开器（非 teardown 孤儿，无 spec 触发），`/T` 覆盖真正孤儿（main PID 非 detached 后代）。
- **锚点**：Fix A `SessionShutdownParticipant.ts`（`_maybeVeto`）；Fix B `e2e/fixtures/electronApp.ts`（`forceKillTree`+`closeApp`）；isE2E 先例 `windowActions.ts`、常量 `shared/e2e/contract.ts`；卡死链路 `src/main/index.ts`（`before-quit`/`will-quit`）→`windowMainService.confirmQuit`→`SessionShutdownParticipant._maybeVeto`。

### 案例 14：agentsScrollbarStable maxJump 1.27（>0.25）——固定帧采样读到虚拟化测量过渡瞬时值，并发放大（速记 22）
- **现象**：`smoke.agentsScrollbarStable` `@p1` 仅 Windows CI，retry 3 次救不回，`maxJump≈1.27`（阈值 0.25）。采样 `[5267,4723,…,7454,8880,…,16904,16904,…]` 单调爬升到 16904 后稳定。用户报「本地稳过」。
- **判定关键**：本地 `--repeat-each=3`（默认吃 config `workers:4`）**也 3/3 全挂**，险些误判产品回归；显式 `--workers=1 --repeat-each=5` **5/5 全过**，`--workers=4 --repeat-each=4` **4/4 全挂** → **并发是放大器=竞态 flake**，单 worker 稳过证明 `estimateRow` 估算在测量完成后确实接近真实，产品没回归（commit `f4dc6365` 引入该 spec 时是绿的）。
- **根因**：spec 采样循环每段滚动后只等**固定 2 帧 raf** 就读 `scrollHeight`；@tanstack 经 `ResizeObserver` **异步**测量进视口的行，慢机/并发下行还顶着 `estimateRow` 没测完，采到「估算→实测」**过渡瞬时值**（单调爬升正是收敛过程）→ 相邻采样落在不同收敛阶段 → maxJump 虚高。污染的是被测对象 scrollHeight 自身。
- **修法**：把「等固定帧」换成 `settle()`——等 `scrollHeight` **连续 4 帧不变（测量收敛）**或耗尽 120 帧预算再采。被测断言（稳定值间伸缩 <25%、首末漂移 <30%）不动。验证：原必挂的 `--workers=4 --repeat-each=8`（32 次）全过。
- **锚点**：`smoke.agentsScrollbarStable.spec.ts`（`settle()` 采样）；`ChatBody.tsx`（`estimateRow`/`useVirtualizer`/`measureElement`，`getTotalSize()` 喂 `.timelineVirtual` 高度）。

## 关键参考路径
- `apps/editor/e2e/specs/` —— 所有 e2e spec；`@p0` 阻塞 CI，`@p1` 次级
- `apps/editor/e2e/fixtures/electronApp.ts` —— `workbench` fixture、`runCommand`/`waitForRestored`/`statusBar` 封装、`closeApp`
- `apps/editor/src/renderer/e2e/probe.ts` —— `window.__E2E__` 探针
- `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` —— ext host 崩溃→通知（CI 噪音主源）
- 仓库根 `memory/e2e-relaunch-flake-windows.md` —— 重启类 flake 的环境性结论

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件
