# cases-mcp-enablement

> 本文从 `services/acp/CLAUDE.md` 拆出，范围是：MCP 服务器**默认启用集语义**——定义池的分层合并（八层优先级、agent 自有配置文件只读导入、扩展贡献层）、per-agent 隔离（agentAffinity / sharedWith）、默认启用/禁用注解（McpEnablementToggles）、以及会话级 pin 与 resume/fork 选择瀑布。套路入口（配置→wire 两步纯函数）见主文档「套路 ACP-F」。

## 八层优先级（低→高）

extension → agent-user（`~/.claude.json`+`~/.claude/settings.json` / `~/.codex/config.toml`）→ VSCodeUser → User → VSCodeWorkspace → Project → Memory → agent-project（`.mcp.json` / `<cwd>/.codex/config.toml`）。`refreshMcpServerDefinitions` 把合并结果镜像到 `mcpServerDefinitions` observable（`.mcp.json` 来源的 entry 带 `fromMcpJson: true`；agent 来源的 entry 带 `agentAffinity`）。

## agent 自有配置文件（只读导入）

编辑器**只读不写**这些 agent 自己的配置文件；同名时 settings 层覆盖 agent-user 层、agent-project 层覆盖一切。路由服务 **`IAgentMcpConfigService`**（`agentMcpConfigService.ts`，renderer 侧薄门面）按 agentId 分发到底层两个 main 侧 store（经 `IClaudeConfigService` / `ICodexConfigService` IPC，`configPath(authority?)` 暴露配置文件绝对路径）：

- **claude-code** → user 层：`~/.claude.json` 的 `mcpServers` + `~/.claude/settings.json` 的 `mcpServers`（前者优先，合并为一条 raw layer）；project 层为空（`.mcp.json` 由 `AcpSessionService.readProjectMcpJson` 直接管，不经此服务）。
- **codex** → user 层：`~/.codex/config.toml` 的 `[mcp_servers]`；project 层：`<cwd>/.codex/config.toml` 的 `[mcp_servers]`（需 cwd；TOML 解析走 smol-toml）。codex 原生 http 条目（`url`/`http_headers`/`env_http_headers`/`bearer_token_env_var`，无 `type` 字段）由 node-services 的 `CodexMcpConfigStore` 读出时翻译为编辑器形状（`type:'http'` + 合并后的 `headers`；`env_http_headers`/`bearer_token_env_var` 在读出端 host 的 `process.env` 解析，后者为 `Authorization`，静态 Authorization 任意大小写存在时 env 派生让位）；stdio 与自带 `type` 的条目原样透传；codex 特有字段不生效——`enabled`（启停走编辑器的 `McpEnablementToggles`）、`oauth_*`（wire 无通道）、`http_headers_helper`（local-only shell 命令，读出端不执行）。
- 未知 agentId → 空层。`onDidChange` 聚合两个 config service 的 `onDidChangeMcpConfig`，事件带 `{agentAffinity}`，facade 订阅后刷新池镜像。

## per-agent 隔离（行为变更）

agent 来源条目带 `McpAgentAffinity = 'claude-code' | 'codex'`（`agentIdToMcpAffinity` 映射，未知 agent → undefined）。`readMcpServerDefinitionsLayered` 第 4 参 `agentAffinity`：**省略 = union 视图**（所有层参与，picker/AI 设置面板镜像用它）；**传值 = 丢弃 affinity 不匹配的 agent 层**（两条 wire 路径用它，`agentIdToMcpAffinity(agentId)` 求值）。**`.mcp.json` 同时收窄为只对 claude-code 会话生效**（此前对所有 agent 生效——不留 fallback 的行为破坏性变更）；codex 的项目级对应物是 `<cwd>/.codex/config.toml`。

## union 视图的同名跨 agent 条目（`sharedWith`）

union 仍是**每 name 一行**，行 affinity 取最后合并的 agent 层。同名若也被**另一 agent**或**共享层**定义，`readMcpServerDefinitionsLayered` 把「行 affinity 之外也定义该名的 agent」记进 `McpServerDefinition.sharedWith`——`filterPoolForSession` 凭它放行，否则同名「claude 层 + codex 层」或「agent 层 + settings 共享层」的条目会在其中一方的 picker 里彻底消失（尽管该方 wire 路径确实包含它，来自自己的层或共享 winner）。picker 行尾对该情况显示「shared」徽标（tooltip 说明内容来自更高优先级共享层）；wire 路径的 per-agent 过滤视图**不计算** sharedWith。

## UI 消费 per-agent 视图的统一入口

`filterPoolForSession(pool, agentId)`（`workbench/agents/McpServerPicker.tsx` 导出）：picker / ConfigOptionsBar / ConfigBarOverflowMenu 三处把 union 镜像过滤成当前会话视图；picker 触发器可见性用 **unionPool** 判定（他 agent 条目存在时触发器仍显示，计数显示 0/0）。agent 专属条目在 UI 上带 affinity 徽标（`claude` / `codex` + tooltip「仅 Claude Code / Codex 会话生效」）；AI 设置面板的 agent 徽标点击经 `configPath()` 打开对应配置文件（只读文件，不走编辑对话框）。

## 扩展贡献层

`contributes.mcpServers` 声明式贡献点，对齐 VSCode 的扩展 MCP collection 模型。`IExtensionMcpServersService`（`services/extensions/extensionMcpServersService.ts`）从 host 扫描的 manifest DTO 解析出与 `acp.mcpServers` 同构的 raw record（`${execPath}`/`${extensionPath}` 变量替换、Workspace Trust 门控、`whenConfiguration` 配置门控，纯函数在 `extensionMcpServers.ts`），**绝不写 settings.json**——扩展卸载/禁用即消失。`AcpSessionService` 把该 record prepend 到 `_mcpSettingsLayers()` 首位（最低优先级，用户同名条目覆盖），两条 wire 路径开头 `await whenReady` 消除冷启动竞态，`onDidChange` 触发池刷新。存量清理：`LegacyMcpBridgeCleanupContribution` 一次性删除旧版 bridge 插件写进 User settings 的形状匹配条目。v1 仅 stdio（条目带 `type` 跳过 + warn）。

## 默认启用集与禁用注解

新会话的默认启用集 = 池中全部非 `disabled` 条目（`resolveMcpServerSelection(pool, null)`）。池的 `disabled` 注解来自 **`IMcpServerEnablementService`**（`mcpServerEnablementService.ts`）：单 key `acp.mcpServerEnablement` 的 GLOBAL/WORKSPACE 双 scope storage（`Record<name, boolean>`），**默认启用**（对齐 `.mcp.json` 现状）——定义条目里的 `disabled` 字段（settings/`.mcp.json`/manifest/agent 配置文件）一律失效、不再被读取（不做迁移；`.mcp.json` 格式本就不支持该字段）。enablement 与定义来源解耦、**不按 agent 隔离**（按 server name 共享），对 settings 层、`.mcp.json`、扩展贡献、agent 配置文件条目**统一生效**。注解由 `readMcpServerDefinitionsLayered` 注入（`source !== 'project'` 即用户级），`.mcp.json` winner 由 facade `refreshMcpServerDefinitions` 在 merge 时传播。`AcpSessionService` 订阅 `enablement.onDidChange` 刷新池镜像。

UI 全部走共用组件 **`McpEnablementToggles`**（`workbench/agents/`，picker compact 与 AI 设置面板共用）：

- **用户级开关**（人形图标，两态，写 GLOBAL，恒显示立场 `?? true`）只在 `def.hasUserLevelDefinition`（同名存在于任一非 project 层）时显示。
- **工作区级开关**（文件夹图标，**三态** indeterminate=继承，点击循环 inherit→true→false→inherit，末步 `removeOverride`）恒显。
- 设置面板为**合并单列表**（同名一行，来源徽标并列、winner 正常/被覆盖弱化，徽标点击路由到编辑对话框或文件）。
- **注意**：`setEnabled(name, true)` 恒存显式 true 记录（不做 true→删键归一化），否则「workspace 禁用时 user 行扳回启用」变 no-op；三态 Checkbox 的 onChange 必须忽略入参按记录状态机驱动（浏览器点 indeterminate 恒上报 checked=true）。

## 会话级 pin 与 resume/fork 选择瀑布

picker 左侧勾选只是会话级 pin（`setSessionMcpServers` → `session.mcpServerSelection`），只影响当前会话（pin 与 attach 快照偏离时无缝 reload），**绝不写回默认**——sticky 机制已删，`acpAgentDefaultsService` 不再存 MCP 白名单（旧数据的 `mcpDefaults` 字段反序列化时忽略、下次写入自动 purge）。

resume/fork 的选择瀑布：history 行 `mcpServerNames`（含 undefined=跟随默认）→ 否则 `null`（= 非 disabled 全集）。
