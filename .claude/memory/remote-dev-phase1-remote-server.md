---
name: remote-dev-phase1-remote-server
description: 远程开发 Phase 1——remote-server 包 + main 侧连接/路由落地的架构决策与坑
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-13T13:05:48.505Z
---

远程开发 Phase 1 已落地（2026-08-13，接 [[remote-dev-phase0-fs-provider]]）：`packages/remote-server`（纯 Node，esbuild bundle，ripgrep/parcel-watcher external）+ `packages/node-services`（文件/搜索/watcher/子进程核心从 apps/editor main 下沉的共享包）+ main 侧 `services/remote/`（连接状态机 + URI 互译 + 三族路由）。

**Why**：Phase 0 的 scheme 分派 FileService 使路由天然落在 main 侧——renderer 文件族服务本就是 main 代理，故放弃原计划的 renderer RemoteChannelRouter；URI 互译收口 `remoteUri.ts`（remote-ssh↔file），server 零 scheme 感知，Phase 0 守卫逻辑原样复用。

**How to apply**：
- 加远端能力=server 端 `createRemoteServer` 加 channel（契约进 `platform/src/remote/remoteProtocol.ts`，版本 bump）+ main 侧 wrapper 加 remote 分支。
- e2e/手动联调用 `UNIVERSE_REMOTE_SERVER_CMD='["node","packages/remote-server/dist/bootstrap.js"]'`（JSON 数组形态防 Windows 空格路径），对 `remote-ssh://<authority>/<path>` 操作即懒建连接。
- 跑 @regression e2e 必须 `UNIVERSE_E2E_ONLY_TAG=@regression`（默认 pass grepInvert 剥离它，裸 `--grep` 静默 No tests found）。
- 坑：wrapper 转发基类事件需 emitter protected（ES2022 类字段下 `super.field` 不可访问）；`registerSingletonFactory` 处理"静态参数在装饰参数前"的注入；parcel watcher subscribe→ready 窗口漏首事件，远程无本地重读兜底。
- 留待后续：真实 ssh 分发/known_hosts、握手 pathCaseSensitive→registerSchemeCaseSensitivity 接线。远端 trash 已于 2026-08-26 收口：不实现远端回收站，而是加 `supportsTrash` 能力位让调用方前置降级为永久删除（详见 [[explorer-trash-and-undo-feature]]）。
