---
name: parcel-watcher-win32-unsubscribe-uaf-crash
description: openFolder 闪退根因 = @parcel/watcher win32 unsubscribe UAF；已修复 = 升 2.6.0 + watcher 移入 UtilityProcess 崩溃自愈；含 minidump 解析方法
metadata: 
  node_type: memory
  type: project
  originSessionId: 77e33e24-07d3-437e-885c-33e27b18a3cf
---

2026-07-29 崩溃调查结论：在已开窗口执行「打开目录」（aki_3.6 → aki_3.7）导致整个应用闪退。根因 = `@parcel/watcher` 2.5.6 Windows native 后端在 `unsubscribe()` 时后台工作线程 use-after-free → 主进程（browser process）ACCESS_VIOLATION。

**证据链**：
- dump `Crashes/reports/9fac4940-*.dmp`（09:53）与 `1151f1f4-*.dmp`（7月28）崩溃点**同一偏移** `watcher.node +0x2ab6e`，确定性复发 bug
- 崩溃线程栈全程在 watcher.node 内（栈底 BaseThreadInitThunk → watcher 工作线程入口），Crashpad 注解 `ptype=browser`
- main 侧 fileWatcher.log 没打出 `unwatch g:/aki_3.6`（该日志在 `await sub.unsubscribe()` 之后才打）→ 崩溃发生在 unsubscribe 调用窗口内
- 触发链：openFolder → WorkspaceMainService fire → renderer ExplorerTreeService `_syncWatch` → IPC → FileWatcherMainService `_subscribe` → `_teardown` → `sub.unsubscribe()`（旧订阅）→ native UAF

**Why**：watcher 直接跑在主进程（`fileWatcherMainService.ts`），native 崩溃 = 全部窗口闪退。VSCode 对策 = 文件监视放独立进程，崩溃只重启该进程。

**How to apply**：**已修复（2026-07-29，两条都落地）**：① catalog 升级 @parcel/watcher ^2.6.0；② watcher 挪进 Electron UtilityProcess——架构：`watcherHost.ts`（唯一碰 parcel 的代码，跑在 utility process，`watcherHostMain.ts` 为入口、electron.vite 独立 chunk）+ `watcherProcessClient.ts`（app 单例 `IWatcherProcessService`，desired-state 重放 + 崩溃 300ms 自动重启 + 60s/3 次熔断）+ `FileWatcherMainService` 只剩 per-window 编排（debounce/ignore/out-of-workspace fs.watch）。崩溃恢复链：exit → 重启重放 → `onDidRestart`（IFileWatcherService 新增，ProxyChannel 桥到 renderer）→ ExplorerTreeService 重扫已加载目录补事件缺口。测试：client 用 FakeTransport+fake timers 测熔断/重放；集成用 in-memory transport 跑真 parcel（含 simulateCrash 端到端用例）。坑：`_teardown` 必须无条件 `client.unwatch`（watch 失败路径 desired 残留会被重启重放）。分析 minidump 用 node 脚本解析（header→streams→ExceptionStream(+160 是 ThreadContext)→ModuleList→Memory64List(type 9) 栈扫描），Crashpad 注解直接 `buf.indexOf('process_type')` 附近读。

**2026-08-03 复发（无害）+ 根治缓解**：发布版启动恢复 3 窗口后 3 秒，watcher UtilityProcess 再崩 0xC0000005（`watcher.node+0x2c243` @2.6.0，不同于上次的 +0x2ab6e）。诱因 = **subscribe 风暴**：exclude 配置 hydrate 期间 `_onExcludeChange` 反复触发 setExcludes，每窗口 2 秒内对同一路径 same-id replace 3-4 次（main 侧 dedupe 只在 root+ignore 全同才跳过），host 快速 unsubscribe→subscribe 命中 2.6.0 仍存在的 win32 native race。隔离+自愈按设计兜住（300ms 重启重放 3 订阅，用户无感知）。**同日已落地缓解**：`FileWatcherMainService` re-subscribe 合并——首次订阅立即 arm，re-subscribe（exclude 变化/root 切换）走 500ms 滑动静默窗口 + 2s 强制上限（`RESUBSCRIBE_QUIET_MS/RESUBSCRIBE_MAX_WAIT_MS`），`_subscribe` 乐观占位目标状态防并发回退；watch() 等 ack（ExplorerTreeService 依赖），setExcludes fire-and-forget（坑：测试 await setExcludes 会被静默窗口吊住）。验证模块身份法：dump 模块 size 对比发布版 watcher.node 的 PE SizeOfImage（0x88000）。
