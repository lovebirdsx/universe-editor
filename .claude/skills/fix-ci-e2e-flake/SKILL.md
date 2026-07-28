---
name: fix-ci-e2e-flake
description: 诊断并修复 CI 偶发、本地稳过的 Playwright e2e 失败（flake）。当用户提到 CI e2e 偶发失败 / flaky / 本地跑没问题但 CI 挂了 / e2e 不稳定，或贴出 toHaveCount / toBeVisible / timeout 报错、expect(locator) call log 时使用。
---

# 修复 CI 偶发 e2e 失败（flake）

本仓库 e2e 用 Playwright + `_electron` 启动真实 Electron，通过 `window.__E2E__` 探针调服务。CI 偶发、本地稳过的失败**绝大多数不是产品 bug，而是断言写法不够鲁棒，或 CI 环境噪音（extension host 崩溃、进程启动慢、定时器竞态）**。核心套路：**判定真回归 vs flake → 读 call log 的“失败形态” → 把断言收敛到“被测对象本身” → 本地验证 happy path 不破 → 经验追加到案例库**。

> ⚠️ 第一原则：**不要为了让 CI 变绿而削弱对被测行为的覆盖**。鲁棒化 = 排除背景噪音干扰，被测断言强度不变。只能靠放宽真正的被测断言才能过 → 它可能是真回归，别盖住。

## 判定流程

1. **真回归 vs flake**：本地 `--repeat-each=5` 能否复现（本地稳过+CI 偶发→flake；本地也挂→回归）；同 commit 重跑能过=flake，每次必挂=回归/结构性缺口；**retry 救得回=瞬时竞态（flake），救不回=结构性（test 超时击穿/真回归/产物缺口）**——分类第一信号；`git log -p` 看失败 spec 是否刚改过；怀疑回归时 `git stash` 纯净基线复跑（对比前两边都先 `pnpm build`）；核对 CI 堆栈绝对路径（`D:\a\...` 是 runner 路径）语义对得上你改的目录。
2. **读 call log 失败形态**：count **波动**=背景元素间歇出现（噪音污染全局 count）；count/received **稳定停错值**=被测对象自身没就位（真回归/定时器没触发/fire-once 空转）；`waiting for locator` 恒 0=渲染没发生/探针没触发/选择器错；timeout 且无元素=往前看前置步骤；**元素 visible 但 click 超时 + `... intercepts pointer events`=被兄弟元素遮挡**（hit-target 检查走 elementFromPoint，水平布局溢出时常见，见案例 42）。
3. **已知噪音源**：extension host 偶发崩溃（`ExtensionHostClientService._handleCrash` 发背景 toast + error 日志）；renderer 定时器竞态（auto-hide/auto-read 在 CI 晚几百 ms）。
4. **最小且鲁棒的修复**（优先对齐同文件已鲁棒化的兄弟断言——同文件内有的步骤已加固、有的还裸，后者是遗留薄弱点）：噪音污染**列表**→`.filter({hasText:'<被测唯一文案>'})` 收敛；噪音污染**全局单值/一次性状态**→从源头禁用无关子系统（先 grep 确认无 spec 依赖）；定时器/异步竞态→`expect.poll`/`toHaveCount({timeout})`，少用固定 `waitForTimeout`+硬断言；纯环境型→别强改产品，记录案例库。
5. **验证**：诊断前先确认产物链是新的（`pnpm build`；手跑单 LSP spec 还需 `pnpm ext:build`+`extension-host/dist`+`vendor/typescript-language-server`，缺→符号空/探针缺=产物问题非回归）。`pnpm --filter @universe-editor/editor exec playwright test e2e/specs/<spec>.ts [--repeat-each=5]`；全量 `pnpm e2e`（输出多，只截错误）。本地无法复现 CI 噪音是常态——目标是“鲁棒化没破坏 happy path”。
6. **沉淀**：把“失败形态→根因→修法”追加到 `references/cases.md`（**信号行必填**），并在下方「案例索引」补一行。这是本 skill 长期价值所在。

## 案例索引（按失败信号速查，命中后去 `references/cases.md` 读详情）

- call log count **波动**=背景噪音 → 案例 1；全局单值/一次性状态同轮多挂=同一噪音源打一片 → 案例 2
- `Test timeout of 30000ms exceeded`（非 poll message）=test 天花板击穿 → 案例 3/10/32
- CI 每次必挂+本地稳过+received 恒空+retry 救不回=伪 flake（CI 缺产物）→ 案例 4
- `expect.poll` 里 `keyboard.press` 后 received 稳定错值=盲按污染被测对象 → 案例 5
- `Execution context was destroyed ... navigation`（fire 后页面 reload/导航再 evaluate）→ 案例 6
- 冷启动首 poll 恒 `""`：局部硬编码 timeout 盖 CI 分档 / 首 poll 漏带大 timeout → 案例 7/25/31
- `EBUSY/EPERM rmdir` 栈在 teardown=Windows 文件锁 → 案例 8；`ENOTEMPTY`+`.json.tmp`=storage 原子写竞态 → 案例 17
- `runCommand`+`expect.poll` 分离、received 卡死初值=fire-once 在就位前空转 → 案例 9
- click 把状态切离默认后 received 恒卡默认值=mount 后 fire-and-forget reconcile 迟到覆盖 → 案例 27
- 上轮修完形态变了仍挂=只治了表象，复合根因继续剥 → 案例 11/30/40
- `Target page ... has been closed`+退出码 0xC0000005：单实例过、多实例崩=parcel watcher → 案例 12/16/44；sharedApp 下崩点飘忽受害者无辜 → 案例 26
- `Worker teardown timeout`+测试全过：有 fixture 名=quit 链 veto → 案例 13；无 fixture 名=孤儿子进程握 CDP pipe → 案例 45
- 滚动采样 received 单调爬升、`--workers=1` 过 `--workers=4` 挂=测量瞬时值 → 案例 14
- 滚动恢复断言 frac 异常（RAF 过冲/虚拟双峰/像素中点落末条）→ 案例 15/34/41
- 仅 CI Windows 确定性挂+涉及 tmp 路径/git=8.3 短路径 → 案例 18；URI 字符串稳定差 `%7E`/`~` → 案例 29
- 新 spec `--repeat-each` 批量挂、received 恒他人写入值=多层叠加 → 案例 19
- `--workers=1` 确定性全挂+stash 回 HEAD 仍挂=既有脆弱点被激活，别当环境噪音 → 案例 20/30
- sharedApp 多 ghost tab / 跨 spec 状态泄漏=reload 不拆 main 态 → 案例 21/40
- 关闭编辑器后紧接 model 操作、修改静默丢失=dispose 竞态 → 案例 22
- 某提交后多 spec 同红形态各异=`git show` 看时序变更波及面 → 案例 23；补了 `.catch` 仍挂=永久 pending → 案例 24
- `extension host may only execute _workbench.* commands not "<ext.cmd>"`=激活竞态 → 案例 35
- 拖拽 spec received 恒 0（稳定卡值）=drop 在 Monaco 就位前 fire → 案例 36
- workspace 切换后紧接的命令 received 恒初值=host 异步 re-pin 窗口 → 案例 37
- 等满 timeout 恒 not found 且该时长==产品放弃点=根本没就位（产品 bug）→ 案例 38
- click 侧栏后 received 恒 explorer / 快照 `Explorer [pressed]`=后台逻辑抢容器 → 案例 39/40
- 元素 visible 但 click 超时+`intercepts pointer events`、本地全绿=en-US+1280 窗口溢出遮挡 → 案例 42；点击超高 Monaco `.view-lines` 容器中心、CI relayout 后中心滑出可见区被 Welcome/标签栏挡 → 案例 54
- `toBeFocused` 恒 inactive+无 workspace 冷启动=bootstrap 一次性焦点恢复抢焦 → 案例 43；测试中途 openWorkspace 后编辑器区内焦点被抢=workspace restore 窗口 editor 分支裸抢 → 案例 53
- 纯黑页+probe 恒无+业务无关 spec 同轮随机挂=bootstrap RPC 被 gate 丢弃 → 案例 33
- 本机裸 `electron.launch` 报 `Process failed to launch!`（exitCode=9）、CI 正常=本机环境 → 案例 28
- 失败仅集中 DnD 类且重跑能过=headless 手势时序 → 案例 46；锁屏时剪贴板用例必败 → 案例 47
- chord 用例卡 `defocusEditor` 等 focus 变 false+retry 秒过=defocus 时序噪声（观察中）→ 案例 48
- 列表相等断言 received 是 expected 前缀子集+采样点为固定 sleep=增量渲染截半，poll 到收敛 → 案例 49
- sash 拖拽/尺寸持久化 spec，reload 后目标 pane 高度稳定卡等分值=异步 reconcile 落后于 Allotment 首次布局、preferredSize 挂载后是 no-op → 案例 50；**修完同断言再挂**=等分值经 onChange→debounce 落盘污染磁盘，恢复路径修得再好读的也是脏值，须收窄落盘权到用户动作 → 案例 50b；**再挂且诊断现场 mem==DOM==贪心值**（磁盘干净）=mem 记账被 onChange 覆盖、storedSizesKey/target 读脏 mem 锁死，恢复目标必须读独立的 persisted 权威源（save 序列化也走它）+settle 窗口内持续校验 → 案例 50c
- ACP 配置写入后立即建 session、echo agent received 恒 `"[]"`=异步镜像池 stale 滤空 wire 列表 → 案例 51
- `[MonacoLoader] not initialized` 栈过同步探针=poll 回调抛异常击穿等待 → 案例 52（**已修又再发**时先核对 main 上修复真实存在：`git log -S`）

## 关键参考路径
- `apps/editor/e2e/specs/` —— 所有 e2e spec；`@p0` 阻塞 CI，`@p1` 次级
- `apps/editor/e2e/fixtures/electronApp.ts` —— `workbench` fixture、`runCommand`/`waitForRestored`/`statusBar` 封装、`closeApp`
- `apps/editor/src/renderer/e2e/probe.ts` —— `window.__E2E__` 探针
- `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` —— ext host 崩溃→通知（CI 噪音主源）

## 其它
- 后续用本 skill，发现新经验，按判定流程第 6 步同步更新案例库与索引
- 修复了某个e2e本身测试稳固性的问题，那么需要整体评估一下所有e2e是否也存在同样的问题，并一并修复
