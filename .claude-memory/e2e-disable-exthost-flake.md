---
name: e2e-disable-exthost-flake
description: e2e 下曾禁用 extension host 防崩溃噪音；2026-06-10 已还原（markdown 迁插件需 host），根因另修
metadata: 
  node_type: memory
  type: project
  originSessionId: 45154ed0-3eab-4870-bacd-8f6958f217ce
---

**已作废（2026-06-10）**：markdown 迁成内置插件后，e2e 必须跑 extension host，故 `ExtensionsContribution._boot()` 的 e2e 短路已移除。host 现在 e2e 下正常启动。

原背景：CI 上 extension host 子进程偶发 spawn/崩溃（`ExtensionHostClientService._handleCrash`）曾是 e2e flake 主噪音源——发未读 Warning toast（污染 notification bell badge `unreadCount`）+ 写 error 日志（抢占 `ErrorLogAutoRevealContribution` 一次性 auto-reveal）。当时（2026-06-09）的修法是 e2e 短路不启动 host。

**还原后真正根因已修**（不再靠禁用 host 掩盖）：
1. host bootstrap 入口路径解析——`extensionHostMainService.ts` 的 `resolveFromRepo()` walk-up，兼容 `electron .` 与 e2e `electron out/main/index.js` 两种布局。
2. 二进制 IPC 0 字节 bug——`packages/platform/src/ipc/ipc.ts` 的 encode/decode 用纯 JSON，`Uint8Array` 退化成普通对象；已加 base64 tag 的 replacer/reviver（`workspace.fs.readFile` 之类靠它）。

**How to apply**：再遇 notification / output / 启动类 spec 的 CI flake，先查 host 是否真崩溃（看 stderr），别再加 e2e 短路——优先修 host 本身。相关 [[e2e-restore-specs-flaky-locally]]。
