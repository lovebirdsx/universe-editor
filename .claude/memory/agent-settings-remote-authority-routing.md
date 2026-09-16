---
name: agent-settings-remote-authority-routing
description: "remote 工作区读写本地配置/home 的根因与修复——workspace hydration 异步,authority 必须订阅 onDidChangeWorkspace;home 是 host 相对语义,`~` 勿用客户端 window.ipc.home;协议扩展 codexMatchActiveApiKey 只回 index 不回秘密"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-16T13:09:49.000Z
---

Remote 工作区下 AI Settings(Claude/Codex 面板)曾一直读写本地 `~/.claude`/`~/.codex`(2026-08-15 修复)。

**Why:** renderer 侧 `useMemo(() => workspace.current..., [workspace])` 的依赖是恒定 DI 单例且不订阅事件——workspace hydration 是异步 IPC,启动恢复的编辑器 tab 挂载早于 hydration,authority 被永久冻结为 undefined。main 侧 authority 路由早已存在,断点全在 renderer 读取时机。

**How to apply:**
- renderer 判 remote authority 一律用 `apps/editor/src/renderer/workbench/useRemoteAuthority.ts`(订阅 `onDidChangeWorkspace`,hydration 完成时 RendererWorkspaceService 会补 fire);绝不 `useMemo` 读 `workspace.current`。
- **`~`/home 是 host 相对语义**:remote 工作区里 `~/…` 由远端进程写出(agent 在远端 spawn),展开必须用远端 host 的 home。统一入口 `renderer/workbench/useWorkspaceHome.ts`(authority 优先取上下文的 URI、其次 workspace folder;`getEnvironment(authority).homeDir` 并订阅重连;点击时用 `resolveHome()` 而非只读 `home`,握手可能未完成)。**勿用 `window.ipc.home`**——那是客户端 `os.homedir()`,remote 下把路径指向错误机器,症状=点链接报 "File does not exist" 而文件在远端明明存在(2026-09-16 修复:会话卡片/markdown 链接;`useTerminalHome.ts` 已删除并入该 hook)。已知同类未收口:`OpenerService.parseTarget`(字符串 target 无 host 上下文,本地语义)。
- 远端凭据匹配走窄协议 `codexMatchActiveApiKey(candidates) → index`:候选 key 与 applyCredential 同向(client→server),远端 auth.json 秘密绝不回传;gateway probe `checkGatewayConnectivity(baseUrl, authority?)` 从生效端网络探测。
- 改 `IRemoteAgentConfigService` 面须 bump `REMOTE_PROTOCOL_VERSION`(本次 2→3),并同步各测试夹具引用常量而非硬编码。
- `remoteFsPathToUri` 已提升到 platform(renderer 可用,如 ConfigFileLink 打开远端配置文件);remote 下 claude 登录不解析本地 binary,开远端终端跑 PATH 上的 `claude auth login`。
- 详见 [[remote-dev-v2-full-stack]] 与 agentSettings claude/codex 两个 CLAUDE.md 的「Remote 工作区路由」节。
