---
name: filewatcher-debounce-test-flaky
description: fileWatcherMainService 的 debounce 测试在全量 vitest 下偶发 5s 超时，单跑必过，是 parcel native watcher 时序问题非回归
metadata: 
  node_type: memory
  type: project
  originSessionId: bf3100b3-2d98-49a4-ae6b-07075cf86648
---

`apps/editor/src/main/services/fileWatcher/__tests__/fileWatcherMainService.test.ts` 的 "debounces rapid writes into a small number of batches" 用例，在 `pnpm exec vitest run`（全量 main project）高负载下偶发 `Test timed out in 5000ms`；单独 `vitest run --project main fileWatcherMainService` 必过（6 tests）。

**Why:** 该用例依赖真实 `@parcel/watcher` 原生后端的事件投递时序，全量套件并发挤占下原生 watcher 回调延迟超过 5s 默认 timeout。与被测代码无关。

**How to apply:** 跑全量编辑器单测看到此用例超时时，先单独重跑确认；单跑通过即视为环境 flake，不要当回归处理。与 [[e2e-parcel-watcher-multiworker-crash]] 同源（都是 parcel watcher 在多 worker/高并发下的时序问题）。
