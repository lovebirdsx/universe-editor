---
name: sessionchanges-unbounded-growth-main-oom-abort
description: acp.sessionChanges 无界增长(实测152MB)→全量IPC+全量日志stringify+整文件重写→主进程V8 OOM abort exit 134;修复=tracker容量预算+有界日志+storage写入兜底
metadata: 
  node_type: memory
  type: project
  originSessionId: c8ea6232-2d44-484d-b96d-a8f72cb9157b
---

工作区状态文件 200MB(`acp.sessionChanges` 152MB,minified/生成文件的 diff 行达 MB 级)导致启动约 8 秒后 exit 134。根因链(2026-07 修复):

1. `PersistedStateBase._loadFromScope` 曾把**整个 state** `JSON.stringify` 进 info 日志 → 百 MB 字符串再经 logChannel 转发主进程,是最大放大器。已改 `_describeState()` 有界摘要(Map/Array 报条数,对象截断 2KB)。
2. IPC 是 JSON 信封(`platform/ipc.ts` encode=JSON.stringify+TextEncoder),一次 storage.get 大 key = 双进程各数百 MB 瞬时分配。
3. `record()` 去抖写 → 主进程 `storage.set` 对整个 cache `JSON.stringify(all, null, 2)` 整文件重写。

**Why:** 单点大 value 经"全量读/全量日志/全量写"三管道叠加,峰值触及主进程堆上限 → abort() 杀整个应用(exit 134),渲染层看不出来。

**How to apply:** `sessionChangeTracker.ts` 预算=每会话 8MB(全有或全无,部分 batch 历史会重建出错误 baseline)+全局 32MB+20 会话 LRU;`_deserialize` 加载时剪枝并回写自愈,单条畸形会话隔离不拖垮整体;预算字段(maxSessionBytes 等)public 可测试覆写。主进程 `createStorage` `set()` 默认 64MB 兜底拒写(抛错给生产方记录而非进程死)。教训:持久化服务日志绝不 stringify 全量 state;新 PersistedStateBase 子类若 state 可增长,必须自带预算。相关 [[session-diff-feature]]
