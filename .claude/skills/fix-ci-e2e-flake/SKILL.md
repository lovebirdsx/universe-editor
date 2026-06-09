---
name: fix-ci-e2e-flake
description: 诊断并修复本仓库（VSCode 范式桌面编辑器）在 CI 上偶发、但本地稳定通过的 Playwright e2e 失败（flake）。当用户提到 “CI e2e 偶发失败 / flaky / 本地跑没问题但 CI 挂了 / e2e 不稳定 / @p0 @p1 spec 偶尔红”，或贴出 Playwright 的 toHaveCount / toBeVisible / timeout 报错、`expect(locator)` call log 时使用。聚焦“区分真回归 vs 环境/写法 flake”的通用流程；具体哪个 spec、哪条断言由 agent 当场判断。
version: 1.0.0
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
- **教训**：凡对“可能存在背景同类元素”的列表（通知、问题面板、输出等）做断言，**默认按被测对象的唯一文案过滤，而非全局精确 count**。

## 易踩坑速记
1. call log 的 count **波动** = 背景噪音；count **卡死在错值** = 更像真回归。先分清。
2. extension host 在 CI 偶发崩溃，会污染一切对通知做全局 count 的断言——按文案过滤。
3. 鲁棒化 ≠ 放宽被测断言。别用“变绿”掩盖真回归。
4. 异步/定时器用 `toHaveCount({timeout})` / `expect.poll`，少用固定 `waitForTimeout` + 硬断言。
5. 同一 spec 内若有的步骤已“按文案过滤”、有的还在“全局 count”，后者就是遗留薄弱点，优先对齐。
6. CI 堆栈路径是 runner 路径（`D:\a\...`），与本地工作目录语义对齐即可，别因路径不同误判改错 checkout。
7. 本地无法复现 CI 噪音是常态；本地验证目标是“没破坏 happy path”。

## 关键参考路径
- `apps/editor/e2e/specs/` —— 所有 e2e spec；`@p0` 阻塞 CI，`@p1` 次级
- `apps/editor/e2e/fixtures/electronApp.ts` —— `workbench` fixture、`runCommand` / `waitForRestored` / `statusBar` 等封装
- `apps/editor/src/renderer/e2e/probe.ts` —— `window.__E2E__` 探针（`triggerUnexpectedError` 等）
- `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` —— extension host 崩溃→通知（CI 噪音主源）
- 仓库根 `memory/e2e-relaunch-flake-windows.md` —— 重启类 flake 的环境性结论

## 其它

- 后续用skill，发现有新的经验，可以自动更新本SKILL.md
