---
name: codex-three-auth-modes
description: Codex 三种登录方案的正确建模（gateway 必须自包含，不可碰 openai_base_url / requires_openai_auth）
metadata: 
  node_type: memory
  type: project
  originSessionId: a972bb16-a7ec-4e5f-a4d2-c65d82476ed5
---

codex-acp 是 app-server 协议，editor 对 codex 的全部控制 = 改两个文件（`auth.json` 凭据 + `config.toml` provider）。editor **从不调 ACP `authenticate`、从不注入 `MODEL_PROVIDER`/`CODEX_CONFIG`**（`MODEL_PROVIDER` 仅 codex-acp 的 index.ts 读）。

Codex 三种登录方案，必须互不耦合：
- **ChatGPT 登录**：`auth.json` 的 `tokens` 块 + `auth_mode:"chatgpt"`，内置 `openai` provider，OAuth token。
- **官方 API Key**：`auth.json` 的 `OPENAI_API_KEY` + `auth_mode:"apikey"`，内置 `openai` provider。
- **自定义 gateway**（example）：独立命名 provider，key 走 `experimental_bearer_token`，与 OpenAI 认证无关。

**两个致命设计错误（已修复）**：
1. 用顶层 `openai_base_url` 重定向内置 openai → 会把 ChatGPT token 发到 gateway，报 `access token could not be refreshed ... signed in to another account`。
2. gateway provider 用 `requires_openai_auth=true` + 复用 `auth.json` 的 key → 强制耦合 ChatGPT/官方认证，切换时互相破坏。

**正确做法**：gateway 建模为**自包含 provider**（对齐用户手写的 `[model_providers.acme]`）：`experimental_bearer_token` 携带 key、`supports_websockets=false`（防 wss 探测）、`model_provider` 指向它，**绝不**碰 `auth.json`、`openai_base_url`、`requires_openai_auth`。

**实现**：`applyCredential(intent)` 是单一原子入口（`{kind:'gateway'|'apiKey'|'chatgpt'}`），一次写齐 auth.json + config.toml，实现在 `packages/node-services/src/agentConfig/codexConfigStore.ts`（含纯函数 `reconcileGatewayProvider`）；`CodexConfigMainService` 只按 authority 路由。替代了旧的 `setApiKey` + `ensureCodexGatewayProvider`；acpClientService 不再做预启动 reconcile。renderer 侧统一入口是 `useCodexConfig().applyAuthentication(authentication)`——`@subscription` 发 `{kind:'chatgpt'}`，provider id 经 `deriveCodexGateway` 派生后发 `{kind:'gateway',…}`（当前面板**没有官方 API key 入口**，`{kind:'apiKey'}` 只是契约保留）。

**"In use" 判定收口到 main**：`resolveActiveAuth(authority?)` → `CodexActiveAuth { kind:'subscription'|'provider'|'none', providerId?, drift }`（纯函数 `computeCodexActiveAuth`）。gateway 生效看 `model_provider==='codex-gateway'` 并用 `deriveCodexGateway` 比对 baseUrl+token 反查 `providerId`；ChatGPT 生效要求 `authStatus.active==='chatgpt'` **且** `model_provider` 为空（旧的 `builtinActive` 降级成这个纯函数里的一个条件，既不是 renderer 的职责，也不在 `CodexAuthStatus` 类型里）。`drift` = 盘上实际生效与 `agentSettings.codex.authentication` 声明不一致。红线：**远端 auth.json 的秘密绝不回传**，只回这三个字段。

相关：[[ai-service-foundation-progress]]
