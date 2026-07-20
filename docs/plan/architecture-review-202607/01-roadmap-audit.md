# 01 · 上一轮可维护性路线图落地审计

> 核查日期：2026-07-19（距 [2026-06-28 路线图](../maintainability-roadmap/README.md) 3 周，其间 408 个提交）。
> 方法：逐条对照当前代码 + `git log --since=2026-06-28`。状态：✅已完成 / 🟡部分完成 / ❌未动 / ⚠️已过时。

## 01 · main 主进程健壮性

| 条目 | 原级别 | 现状态 | 证据/说明 |
|---|---|---|---|
| 统一子进程管理抽象 ChildProcessManager | P0 | ✅ 已完成 | `apps/editor/src/main/services/process/managedChildProcess.ts`（262 行，含 SIGTERM→SIGKILL 2s 升级、树杀、统一 onDidExit、单测）。commit `a9d9e9e6`（新增抽象）、`3dce86b7`（收编 acpHost/acpTerminal/extensionHost/terminal）、`2289b762`（收编 textSearch）。残留裸 spawn 仅为一次性 `where` 探测（claudeBinary:591 / codexBinary:540）与 detached 外部打开（hostMainService），属合理不收编场景 |
| 子进程 kill 缺强制超时 | P0 | ✅ 已完成 | `managedChildProcess.ts:176-193` kill() 内置 SIGTERM→(killTimeoutMs=2000)→SIGKILL 升级 + warn 日志；textSearch 已迁移（`textSearchMainService.ts:231`） |
| ACP stdio 流无背压 | P0 | ❌ 未动 | `managedChildProcess.ts:117-118` stdout/stderr 仍直接 `fire(data)`；全 main 侧无 `pause()/resume()/highWaterMark`（grep 零命中）。注：流式卡顿的主因（renderer 侧 O(L²) 重解析）已在 02 解决，此条紧迫性下降 |
| main DI `undefined` padding 脆弱 | P1 | ✅ 已完成 | 采纳方案 B：`main-services.ts:88-96` 注释明确改为 `registerSingletonFactory`（type-checked 构造调用），`main-services.ts:111-130` AcpHost/AcpTerminal/ExtensionHost 等均走具名工厂，改签名即编译错 |
| 关键 main 服务零测试 | P1 | ✅ 已完成 | 六个点名目录全部有测试：`window/__tests__/`（4 个）、`fileWatcher/`、`userData/`、`workspace/`（2 个）、`textSearch/`、`codexConfig/` 各有 `*.test.ts`；另 `2289b762` 补 host/codexBinary 测试 |
| windowMainService 职责过载拆分 | P1 | 🟡 部分完成 | 前置的"先补测试"已完成；仅抽出 `windowsJumpList.ts`，主文件 `windowMainService.ts` 现 725 行（比路线图时还大），未做 WindowFactory / WindowSessionStore / WindowLifecycle 拆分 |
| P2（AI 配置热重载竞态 / 生命周期文档） | P2 | ❌ 未动 | 未见对应改动，维持低危评估 |

## 02 · ACP/AI 业务核心

| 条目 | 原级别 | 现状态 | 证据/说明 |
|---|---|---|---|
| 连接生命周期显式状态机 | P0 | ✅ 已完成 | `acpSessionConnection.ts`（145 行）：`connecting/connected/failed/closed` 单向状态机，文件头注释明确替代旧 flag soup，并修复"连接失败静默丢弃排队 prompt"（现 reject 明确错误 + whenSettled 必 settle）。commit `a6b7f66f` |
| acpSession.ts 上帝文件拆分（1816 行） | P1 | 🟡 部分完成 | 已抽出 `acpSessionModel.ts`(498)/`acpSessionCost.ts`(47)/`acpSessionConnection.ts`/`acpSessionContent.ts`/`acpSessionStatus.ts`/`acpSessionUpdateMeta.ts`；主文件降至 1640 行，但 `applyUpdate` 大 switch（acpSession.ts:1019-1156）与流式缓冲仍在主类内 |
| acpSessionService 依赖过载（14 注入） | P1 | 🟡 部分完成 | 已抽 `acpSessionRegistry.ts`（153 行，commit `7caa992e`）与 `acpSessionRestoreCoordinator.ts`（432 行）；但 facade 本体现 1250 行、构造注入约 16 个，比路线图时更重（新功能持续堆入） |
| 流式 markdown 全文重解析 O(L²) | P1 | ✅ 已完成 | `markdownIncremental.ts` 的 `parseMarkdownStreaming`：只解析新增尾部、输出与全量解析逐字节一致、parse 可注入供测试计数。commit `3ab2f02f` |
| 16ms 批处理与 immediate set 竞态 | P1 | ✅ 已完成 | `acpSession.ts:1599-1638`：所有 timeline/messages 写入统一走 `_batchedTx()`，并新增 `_setImmediate` 守卫——dev 下 pending tx 时立即写会 throw，生产降级为普通 set |
| agentActions 单文件 1213 行 | P2 | ✅ 已完成 | commit `13b6f595`：拆为 8 个按域文件 + `_agentShared.ts`，原文件仅剩 13 行转发 |
| 错误类分散 | P2 | ✅ 已完成 | `acpErrors.ts`（53 行）合并 ACP 错误家族 |

## 03 · platform 内核

| 条目 | 原级别 | 现状态 | 证据/说明 |
|---|---|---|---|
| index.ts re-export 改分组 barrel | P1 | ✅ 已完成 | `packages/platform/src/index.ts` 现仅 37 行，只 re-export 各子目录 barrel；`index.test.ts` 覆盖检查兜底"导出未被 barrel 收纳" |
| CommandsRegistry/MenuRegistry 重复 ID 静默覆盖 | P1 | ✅ 已完成 | `commandRegistry.ts:103-104` 重复 id `console.warn`，`:35` 提供显式 override 抑制选项；`menuRegistry.ts:146-147` 对 exact duplicate 同样 warn |
| 关键内核补测试 | P1 | ✅ 已完成 | editorGroupModel / editorService / configurationService / derivedImpl 测试全部存在 |
| observable 环检测 dev 告警 | P2 | ✅ 已完成 | `derivedImpl.ts:28-45`：`checkEnabled` 按上游保持 false，新增 `warnCyclicDerived`（dev-only、每 derived 一次的非致命 warn），正是路线图建议的替代方案 |

## 04 · renderer 框架

| 条目 | 原级别 | 现状态 | 证据/说明 |
|---|---|---|---|
| View 注册"三处必改"收口单点 | P0 | ✅ 已完成 | `BuiltInViewsContribution.ts:26+` 全部改用 `registerViewWithComponent`（描述符 + 组件单点声明，`services/views/ViewComponentRegistry.ts`）；`ViewComponentsContribution.ts` 已删除，跨文件 componentKey 字符串耦合消失 |
| contributions/index.ts 709 行按相位分文件 | P1 | ✅ 已完成 | `contributions/registration/{blockStartup,blockRestore,afterRestore,eventually}.ts` 四文件就位，`contributions/index.ts` 降至 49 行 |
| 大组件缺 memo | P1 | ✅ 已完成 | `EditorGroupView.tsx:393` memo、`:262` EditorTab 独立 memo；`MessageContent.tsx:61` memo |
| bootstrap main.tsx 命令式装配改表驱动 | P1 | ✅ 已完成 | commit `298ff665` "IPC 代理服务装配改为声明表驱动"。注：main.tsx 因新功能已增至 845 行，装配机制本身已收口 |
| workbench-ui 迁移债 / action id 常量 | P2 | 🟡 机会型推进中 | 维持"动到就迁"策略，符合原计划定位 |

## 05 · 扩展系统

| 条目 | 原级别 | 现状态 | 证据/说明 |
|---|---|---|---|
| fs 网关 symlink realpath 纵深防御 | P1 | ✅ 已完成 | commit `2d1c0048`；`MainThreadFs.ts:10-13,57-91`：文本 policy 通过后再经 `IFileService.realpath` 二次校验（含 cwd 规范化、8.3 短名处理），配套 `__tests__/MainThreadFs.test.ts` |
| API 版本兼容策略缺失 | P1 | ✅ 已完成 | `packages/extension-api/COMPATIBILITY.md`：版本承诺口径表、engines.universe 协商语义、契约测试作"API 表面快照"抓手 |
| extension-api 零测试 | P1 | ✅ 已完成 | `packages/extension-api/src/__tests__/index.test.ts` + 独立 `vitest.config.ts` |
| extensionService.ts 职责过载（959 行） | P1 | ✅ 已完成 | 拆出 `activationService.ts` / `commandRegistry.ts` / `languageProviderRegistry.ts`，主文件降至 779 行。⚠️ 期间发生**双 host→单 host + Workspace Trust** 重构（commit `bbe55b10`），原文档中的双 host 背景描述已过时，条目本身不受影响 |
| git repository.ts 拆分 / activation 常量 | P2 | ❌ 未动 | 未见对应拆分与 ActivationEvents 常量 |

## 06 · 性能与工程化

| 条目 | 原级别 | 现状态 | 证据/说明 |
|---|---|---|---|
| 启动 perf 打点细化 | P1 | ✅ 已完成 | `shared/perf/marks.ts` 从 12 个增至 25 个 mark，含点名的 `extHostDidSpawn`（:27）与 `rendererDidInitializeMonaco`（:68） |
| CI 启动耗时门禁 | P1 | 🟡 部分完成 | `ci.yml:213-226` `@perf` job 采集 timeline 落盘 artifact（observe-only）；`:437-485` bench 与 committed baseline 软对比。处于"先 soft 观察"阶段，hard-fail 门禁未启 |
| e2e flaky 系统化 | P1 | ✅ 已完成 | `apps/editor/e2e/RUNBOOK.md`（@p0 阻塞 / @serial 单 worker / @flaky 非阻塞分类表）；双平台 `@flaky` 独立 job。另有超出路线图的 e2e 基座重构：`packages/e2e-harness` + `e2e-contract` 抽包（commit `001044bc`）。@parcel/watcher 竞态根治未做（@serial 仍 --workers=1），已登记 RUNBOOK |
| turbo typecheck 依赖 build | P2 | ✅ 已处理（决策保留） | `turbo.json:3` 长注释论证必要性，即"评估后确认不改"，条目关闭 |
| will-quit 同步落盘 pretty-print | P2 | ✅ 已完成 | `main/storage.ts:130` 同步路径改紧凑 stringify |
| bundle size 可观测 | P2 | ✅ 已完成 | ci.yml:472-478 gzip 对基线比对 |
| dist 重建 DX（dev:full / DEVELOPMENT.md） | P2 | ❌ 未动 | 无 `dev:full` 脚本、无 DEVELOPMENT.md |

## 总结

**整体落地率：P0 4/5 完成（80%），P1 15/19 完成、4 项部分完成（无一未动），多数 P2 已顺手做掉。** 多个 commit 直接标注 (P0)/(P1)/(P2)，路线图被系统性消化。

- **基本完成的主轴**：03 platform 全清；04 renderer P0+三个 P1 全清；05 扩展系统 4 个 P1 全清；01 的子进程抽象与测试安全网；02 的状态机与两个流式性能项；06 的打点与 flaky 治理。README 第一梯队三条（子进程收编 / 注册链去手工化 / 补测试安全网）可整体宣告收官。
- **仅剩的欠账**（已并入新一轮矩阵）：① ACP stdio 背压（唯一未动 P0，建议降 P2"先测量再决定"）；② windowMainService 拆分（测试已就位）；③ acpSession / acpSessionService 收尾拆分 + 防回涨；④ 启动耗时 hard 门禁。
- **建议废弃的条目**：全部已 ✅ 条目；turbo typecheck（有书面论证保留）；05 中基于"双 host 隔离"表述的背景描述（单 host + Workspace Trust 重构后过时）。
