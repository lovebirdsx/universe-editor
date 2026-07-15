# E2E Flaky RUNBOOK

> 本文件登记 E2E 已知的不稳定（flaky）/环境性失败：**根因 + workaround + 判定标准**。
> 目的：让开发者快速区分「真回归」与「环境噪声」，避免误判和盲目重跑。
>
> 维护约定：新发现一类 flaky 时在此登记一行，并在 `.claude/memory/` 留对应详细 memory。

---

## 分类与 CI 策略

| 类别 | tag | CI 处理 | 阻塞门禁? |
|---|---|---|---|
| 核心冒烟（必过） | `@p0` | 并行趟，shard×2 | **是** |
| 一般冒烟 | `@p1` | 并行趟，shard×2 | 是 |
| 回归守护（bug guard） | `@regression` | 单独并行趟，shard×2；本地 `pnpm e2e` 默认排除 | 是 |
| 跨进程 native 竞态隔离 | `@serial` | 单独串行趟 `--workers=1`，仅 shard 1 | 是 |
| 已知不稳定（headless 偶发） | `@flaky` | 单独趟、`continue-on-error`，仅产报告 | **否** |
| 启动性能观测 | `@perf` | 单独趟、`continue-on-error`，写 startup-metrics 工件 | 否 |
| 视觉回归 | `@visual` | 默认排除 | 否 |

- 并行趟统一 `--grep-invert "@visual|@serial|@flaky|@perf|@regression"`，把视觉/串行/不稳定/性能/回归守护用例从主门禁里剥离。
- `@flaky` 趟保留覆盖（仍然跑、仍上传 trace），但不让环境抖动卡住 PR。修好根因后应摘掉 `@flaky` 让它回归门禁。
- `@regression` 是**单用例级** tag（打在 `test('... @regression')` 标题末尾，而非 `describe`）：一个 spec 文件里核心主路径冒烟留主趟，只为守护某个已修复 bug 的用例打 `@regression`。目的是让本地 `pnpm e2e` 只跑核心冒烟保持轻快，CI 仍全量覆盖回归。何时打：**该用例只为守护已修复 bug、不是命令主路径/协议/导航入口的冒烟**（先例见 `smoke.markdownPreview.spec.ts`）。本地手动全跑回归：`pnpm --filter @universe-editor/editor e2e:regression`。

---

## 已知 flaky / 环境性失败登记

### 1. parcel watcher 多 worker native 崩溃 → `@serial`
- **现象**：`smoke.simpleFileDialog` 的「openFolder ... OK switches the workspace」在多 worker 全量 e2e 偶发 main 进程 `0xC0000005`，表现为 `Target page/context/browser has been closed`。
- **根因**：`@parcel/watcher` Windows backend 在多 Electron 实例并发重订阅时的跨进程 native 竞态。单实例（`--workers=1`）永不触发 → 非产品 bug，真实用户不受影响。
- **workaround**：该用例打 `@serial`，CI/`pnpm e2e` 拆「并行趟 + 串行趟 `--workers=1`」。
- **判定标准**：单实例稳过、多实例才崩的 native 崩溃 → 走 `@serial`，别在产品代码里找 bug。
- memory：`e2e-parcel-watcher-multiworker-crash`、`filewatcher-debounce-test-flaky`（同源）。

### 2. headless 拖放偶发失败 → `@flaky`
- **现象**：`smoke.explorerDnD` 等 DnD 类用例在本机/CI headless 下偶发失败（拖放手势在无 GPU/2 核 runner 上时序敏感）。
- **根因**：HTML5 DnD 在 Playwright + Electron headless 下手势投递时序不稳，非业务回归。
- **workaround**：打 `@flaky`，CI 单独趟不阻塞门禁。
- **判定标准**：失败仅集中在 DnD 类且重跑能过 → 环境 flake。
- memory：`e2e-local-windows-launch-fails`（记录 explorerDnD 本地偶发不阻塞）。

### 3. 本机 Windows 裸 `_electron.launch` 重启类用例失败（**不打 tag**）
- **现象**：`smoke.editorRestore` / `smoke.outputRestore` / `smoke.layoutPersistence` / `smoke.agentOnboarding` / `smoke.agentsEmptySessionRestore` 等在**本机 Windows** 跑完整 `pnpm e2e` 时报 `Process failed to launch!`。
- **根因**：本机环境对 Electron 二次启动 + `--inspect=0 --remote-debugging-port=0` 的 CDP 连接限制。**CI 上正常通过**，故不打 `@flaky`（否则削弱 CI 覆盖）。
- **判定标准**：失败集合 ⊆ 上述裸启动 `@p1` 且报 "Process failed to launch" → 本机环境 flake，**只在 CI 验证**。
- **注意**：自定义 `electron.launch` 必须先解构去掉 `ELECTRON_RUN_AS_NODE`（Claude Code shell 注入），否则确定性失败。

### 4. 本机 markdown 插件命令 / TS LSP 未就绪（**不打 tag**）
- **现象**：`smoke.markdownEditing` / `smoke.markdownLsp` 在本机报 `extension host may only execute _workbench.* commands` 或 LSP 拿不到符号。
- **根因**：本机 `out` 产物下 extension host 未正常放行 `markdown.editing.*` / TS LSP 未就绪。CI 安装 vendored typescript-language-server 后正常。
- **判定标准**：仅 markdown 类 @p1 失败 → 本机环境噪声，不当回归。
- memory：`e2e-markdown-exthost-fail-locally`、`e2e-disable-exthost-flake`。

### 5. Ubuntu 多用例随机在 E2E probe 前纯黑（已修复）
- **现象**：多个无关 spec 同轮随机卡在 fixture `waitForFunction(__E2E__)`；Electron/window 很快创建但页面纯黑，test body 未执行，retry 常恢复。
- **根因**：`ElectronProtocol` 在主 frame 导航开始时关闭发送 gate；renderer 在 `dom-ready` 前发出的首个 bootstrap RPC 可到 main，但同步响应被 gate 丢弃，导致 probe/React 之前的 Promise 永久 pending。
- **修复**：renderer 入站 IPC 先重开 frame gate，再分发给 `ChannelServer`；入站本身证明新 frame 已可执行 IPC。不要通过放宽 fixture timeout 掩盖永久死锁。
- **判定标准**：trace 中 launch/firstWindow 很快，probe 恒无且截图纯黑；失败在业务无关 spec 间漂移。锚：`src/main/ipc/electronProtocol.ts`；skill 案例 33。

---

## 诊断前必做

1. **先 `pnpm build`**：子包级 `pnpm exec playwright test` **不会** rebuild，`out/` 可能是过期构建。只有根 `pnpm e2e` 会先 build。
2. **异步会话**：依赖 timeline 高度/虚拟化/滚动的 ACP 用例，断言前必须 `expect.poll` 等消息数到位 + 高度收敛，不能依赖 `sendAcpPrompt` 的 await（它不等 echo 回复渲染）。memory：`e2e-async-session-prompt-not-settled`。
3. **stash 基线对比**：怀疑回归时用 `git stash` 在纯净基线复跑；注意对比前两边都要 `pnpm build`。

---

## 根治 TODO

- `@parcel/watcher` Windows 多 worker 竞态的长期根治（升级 / 换 watcher / 进一步隔离），替代长期 `--workers=1`。
- DnD 用例稳定化（显式等待 drop 完成态），稳定后摘 `@flaky`。
</content>
</invoke>
