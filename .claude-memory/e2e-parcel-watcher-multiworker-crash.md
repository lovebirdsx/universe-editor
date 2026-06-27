---
name: e2e-parcel-watcher-multiworker-crash
description: simpleFileDialog 切 workspace 用例在多 worker e2e 偶发 main 进程 0xC0000005 崩溃，是 @parcel/watcher windows backend 跨进程竞态，已 @serial 隔离
metadata: 
  node_type: memory
  type: project
  originSessionId: 0b4d999b-051e-4340-b002-c321a5b9eda5
---

`smoke.simpleFileDialog.spec.ts` 的「openFolder ... OK switches the workspace」用例在**本地全量 e2e（多 worker）** 偶发挂，报 `Target page, context or browser has been closed`（栈在 `QuickInputPO.waitForHidden`）。

**真相**：不是 harness flake，是 **main 进程 native 访问违例 `0xC0000005`（退出码 3221225477）**——无 render/child-process-gone 事件、无 stderr、crashReporter 一开就不复现的 heisenbug。

**根因**：`@parcel/watcher` 2.5.6 windows backend 在**多 Electron 实例并发**重订阅（切 workspace 触发 `fileWatcherMainService._subscribe` 的 unsubscribe→subscribe）时的跨进程 native 竞态。三组对照实验证明：单实例（`--workers=1`）跑多少次都不崩；只有多实例（`--workers=6`）才崩；多实例禁用 watch 也不崩。**单实例永不触发 = 非产品 bug，真实用户不受影响**。该用例单测试内切两次 workspace（openWorkspace + 对话框 OK），两次 back-to-back 重订阅放大了它。

**进程内串行化修复无效**（管不了别的进程，实测仍 3/144 崩，已还原）；产品侧 try/catch 接不住 native 段错误。

**已采用的修复**：给该用例打 `tag: '@serial'`，`pnpm e2e`（package.json）与 `ci.yml` 都拆成「并行趟 `--grep-invert "@visual|@serial"` + 串行趟 `--grep @serial --workers=1`」，CI 串行步限 `matrix.shard == 1`。不改产品、不削弱断言、保留 watch 的 e2e 覆盖。

**Why**：这是排查 `0xC0000005` / 多 worker 偶发崩溃的范本——若再遇到「单实例稳过、多实例才崩」的 native 崩溃，按此结论直接走 `@serial` 隔离，别再花时间在产品代码里找 bug 或试进程内串行化。

详见 skill `fix-ci-e2e-flake` 案例 12 + 速记 20。相关已知本机 flake：[[e2e-restore-specs-flaky-locally]]。
