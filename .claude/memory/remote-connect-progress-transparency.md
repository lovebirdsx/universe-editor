---
name: remote-connect-progress-transparency
description: 远程连接安装过程透明化——细粒度 progress 事件复用 onDidChangeState、needsInstall 门控 Output 自动打开、状态栏 in-flight 回退
metadata: 
  node_type: memory
  type: project
  originSessionId: 1df8fe2c-d148-422c-aed8-015886728991
  modified: 2026-08-15T13:44:20.915Z
---

远程连接安装过程透明化（2026-08-15，task3 分支）：细粒度步骤事件不新增通道，直接在 `IRemoteConnectionStateChange`/`RemoteConnectionStatusDto` 上加可选 `progress`（stepId/stepIndex/stepTotal/startedAt/needsInstall），由 `_ensureDaemon` 在 classify 后按分支 fire（stepTotal 此时才可知）；deployer 用方法参数 `onPhase` 回调上报（deployer 是共享单例，不能构造器注入 per-connection 回调）。

**Why:** 快速路径（server 已就绪）与 reconnect 零 progress 事件，天然不打扰；`needsInstall` 只在真正走 `deployRemoteServer` 的分支为 true，renderer 据此门控 Output 自动 reveal。

**How to apply:**
- 状态栏 remote entry 原本只在「当前 workspace 是 remote-ssh」时显示，但首次连接是 connect → openFolder，安装期 workspace 还是本地——必须加 `_displayAuthority()` 回退到 in-flight（deploying/forwarding/handshaking）的 authority，否则步骤 UI 在最主要场景下不可见。
- Output 自动 reveal 照抄 [[ErrorLogAutoRevealContribution 范式]]（createChannel('Remote Connection','log') → setActiveChannel → revealOutputPanel），须带 `hasPendingRestoredChannel` 防护 + per-authority 去重（failed/idle/disposed 时重置）。
- 频道名常量 `REMOTE_CONNECTION_LOG_CHANNEL_NAME` 收口在 shared/ipc/remoteStatusService.ts，main logger 与 renderer 共用防漂移。
