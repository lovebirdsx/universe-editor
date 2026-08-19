---
name: tsgo-optional-di-param-ci-only-typecheck-fail
description: 可选注入服务参数破坏 createInstance 类型推断；Windows tsgo 漏报、CI Linux tsgo/tsc 报错——"CI typecheck 挂、本地绿"先用 tsc 复现
metadata:
  type: project
---

构造函数尾参写成可选注入服务（`@IFoo private readonly _foo?: IFoo`）会破坏 DI `createInstance(ctor)` 重载：`GetLeadingNonServiceArgs` 的 `[...infer TFirst, BrandedService]` 匹配不了可选元组末位，剥离中断 → 回落 `SyncDescriptor0<unknown>` 重载 → 调用点报 `unknown 不能赋给 IDisposable` / `缺 ctor` 连锁错误（案例：AcpSessionService 的 `_envSnapshot?`，commit 07bf617b 引入、CI 连红两次）。

**Why**：tsgo（`@typescript/native-preview`，同版本 7.0.0-dev.20260707.2）存在跨平台行为分歧——Windows 版对该条件类型场景**漏报**，Linux 版（CI）与官方 tsc 一致报错。本地清 tsbuildinfo、重建 platform dist 都复现不了。

**How to apply**：
- 注入服务一律必选；"可无"语义用必选参数 + 调用点判空，或测试传 stub（共享 stub 放 `__tests__/stubXxxService.ts`）。
- 遇到「CI typecheck 挂、本地 tsgo 绿」：别怀疑缓存，直接 `pnpm exec tsc -p tsconfig.web.json --noEmit --tsBuildInfoFile $TEMP/x.tsbuildinfo` 用 tsc 复现，tsc 报错即真错。
- tsc 与 tsgo 的 DOM lib 有已知差异（如 `PerformanceEventTiming.interactionId` tsc 5.x 不认识），tsc 复现时忽略这类 lib 差异噪音。

相关：[[builtin-agent-skills-user-extension-commands]]（引入该参数的功能）、[[tsgo-stale-tsbuildinfo-phantom-typecheck-errors]]（另一类 tsgo 假信号：幽灵报错）。
