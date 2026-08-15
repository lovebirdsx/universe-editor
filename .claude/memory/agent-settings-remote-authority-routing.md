---
name: agent-settings-remote-authority-routing
description: "remote 工作区 AI Settings 读写本地配置的根因与修复——workspace hydration 异步,authority 必须订阅 onDidChangeWorkspace;协议扩展 codexMatchActiveApiKey 只回 index 不回秘密"
metadata: 
  node_type: memory
  type: project
  originSessionId: fa6d551b-7857-43db-ae0b-fa0cc7f8c9e2
  modified: 2026-08-15T13:48:55.874Z
---

Remote 工作区下 AI Settings(Claude/Codex 面板)曾一直读写本地 `~/.claude`/`~/.codex`(2026-08-15 修复)。

**Why:** renderer 侧 `useMemo(() => workspace.current..., [workspace])` 的依赖是恒定 DI 单例且不订阅事件——workspace hydration 是异步 IPC,启动恢复的编辑器 tab 挂载早于 hydration,authority 被永久冻结为 undefined。main 侧 authority 路由早已存在,断点全在 renderer 读取时机。

**How to apply:**
- renderer 判 remote authority 一律用 `apps/editor/src/renderer/workbench/useRemoteAuthority.ts`(订阅 `onDidChangeWorkspace`,hydration 完成时 RendererWorkspaceService 会补 fire);绝不 `useMemo` 读 `workspace.current`。已知同款隐患未修:`useTerminalHome.ts` render 期裸读 current。
- 远端凭据匹配走窄协议 `codexMatchActiveApiKey(candidates) → index`:候选 key 与 applyCredential 同向(client→server),远端 auth.json 秘密绝不回传;gateway probe `checkGatewayConnectivity(baseUrl, authority?)` 从生效端网络探测。
- 改 `IRemoteAgentConfigService` 面须 bump `REMOTE_PROTOCOL_VERSION`(本次 2→3),并同步各测试夹具引用常量而非硬编码。
- `remoteFsPathToUri` 已提升到 platform(renderer 可用,如 ConfigFileLink 打开远端配置文件);remote 下 claude 登录不解析本地 binary,开远端终端跑 PATH 上的 `claude auth login`。
- 详见 [[remote-dev-v2-full-stack]] 与 agentSettings claude/codex 两个 CLAUDE.md 的「Remote 工作区路由」节。
