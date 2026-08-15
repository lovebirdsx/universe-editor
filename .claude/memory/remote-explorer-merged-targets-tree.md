---
name: remote-explorer-merged-targets-tree
description: Remote Explorer 4 view 合并为单 Targets 树；Connections 重复条目根因是 WSL authority 大小写未归一化
metadata: 
  node_type: memory
  type: project
  originSessionId: 5412f4c8-e658-4186-bf9e-2adf48ba17ac
  modified: 2026-08-15T13:57:34.085Z
---

2026-08-15：Remote Explorer 侧栏原 4 个平铺 view（SSH Targets / WSL Targets / Connections / Recent）合并为单一 `workbench.view.remote.targets`（"Targets"）树：SSH/WSL 分组 → target 行（连接状态点 + connect/open/retry/close/stop/forget inline actions）→ recent 工作区子行（name + 父路径 description）。树构建是纯函数 `buildRemoteTree`（`workbench/remote/remoteTree.ts`），不在枚举里但有活跃连接或 recent 的 authority 会合成 target 行（原 Connections 信息不丢，含 e2e 直连）。

**Why:** Connections 与 Targets 语义重复（绿点即连接态）；Recent 只显示 basename 易重名。截图里 `wsl+Ubuntu-24.04`/`wsl+ubuntu-24.04` 双条的根因是全链路拿 authority 原始字符串做身份键，而 WSL 发行版名大小写不敏感。

**How to apply:** WSL authority 规范形 = distro 小写，收敛入口 `normalizeRemoteAuthority`（platform `remoteProtocol.ts`，非 wsl 原样返回——ssh Host alias 大小写敏感勿动）；归一化只在两类边界做：`RemoteConnectionMainService` 各公开入口、远程工作区 URI 进入 main 的打开/恢复/recent 读写处，下游一律消费规范形，勿散写 toLowerCase。见 [[path-comparison-convergence]]、[[remote-dev-v2-full-stack]]。
