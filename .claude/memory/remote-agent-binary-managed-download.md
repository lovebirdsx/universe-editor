---
name: remote-agent-binary-managed-download
description: 远程工作区 agent 原生二进制受管下载到远端主机（AgentBinaryStore 双端共享 + RemoteChannels.AgentBinary + renderer 按 authority 注入 env）
metadata: 
  node_type: memory
  type: project
  originSessionId: ccf30490-4e23-41fb-9454-b5c051ee5f33
  modified: 2026-08-15T14:03:01.155Z
---

远程工作区下 claude/codex 原生二进制改为下载到**远端主机** `<dataDir>/agent-bin/<agent>/`（2026-08-15 落地）。此前 renderer 对 `spec.authority` 直接短路 → 远端 claude-code 必挂（fork 的 claudeCliPath() 无 `CLAUDE_CODE_EXECUTABLE` 直接 throw），codex 靠部署时 npm ci 隐式拉 300MB 平台包。

**架构**：下载核心抽为 `packages/node-services/src/agentBinary/`（`AgentBinaryStore` + claude/codex flavor，Electron-free），main 两个 binary 服务薄壳化（保留 source 分派/dev vendored 复用/electron 路径）；远端走 `RemoteChannels.AgentBinary`（协议 v2→v3），server 端 `RemoteAgentBinaryService` 惰性建 store + 进度节流（≥100ms）跨隧道；main 按 `opts.authority` 分流（照 acpHost 模式，onDidClose 失效 proxy 缓存）；renderer 远程分支固定 `source:'download'` 并注入远端 native path 到 `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH`，settings env 改读远端 `~/.claude`（`claudeConfig.read(authority)`）。

**Why**: 二进制放非版本化目录（server 升级不重下几百 MB）；远端部署 `npm ci --omit=dev --omit=optional` 省 ~500MB（原生二进制均为 optionalDependencies，改由受管下载补）。

**How to apply / 坑**:
- 红线不变：本地 source/customPath 配置与 `acp.codex.apiKey` 绝不过隧道；进度事件按 `authority` 过滤（本地事件 authority=undefined），本地/远端下载互不驱动对方通知。
- **store 层必须并发去重**（飞行中共享 promise、settle 后释放）：server 同进程内两个 session 并发首启会写同一 `.extract.<pid>` 临时目录互踩损坏；main 层 _inflight 只保护本地。settle 后释放是为了 forceDownload 版本翻转能被下一次 resolve 看见。
- 遗留：BinaryPanel 版本面板/prefetch 仍只作用本地主机；远端仅 resolve（按需下载）。

关联：[[remote-dev-v2-full-stack]]、[[agent-binary-silent-download-e2e-fix]]
