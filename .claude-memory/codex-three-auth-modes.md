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
- **自定义 gateway**（kurogames）：独立命名 provider，key 走 `experimental_bearer_token`，与 OpenAI 认证无关。

**两个致命设计错误（已修复）**：
1. 用顶层 `openai_base_url` 重定向内置 openai → 会把 ChatGPT token 发到 gateway，报 `access token could not be refreshed ... signed in to another account`。
2. gateway provider 用 `requires_openai_auth=true` + 复用 `auth.json` 的 key → 强制耦合 ChatGPT/官方认证，切换时互相破坏。

**正确做法**：gateway 建模为**自包含 provider**（对齐用户手写的 `[model_providers.kuro]`）：`experimental_bearer_token` 携带 key、`supports_websockets=false`（防 wss 探测）、`model_provider` 指向它，**绝不**碰 `auth.json`、`openai_base_url`、`requires_openai_auth`。

**实现**：`CodexConfigMainService.applyCredential(intent)` 单一原子入口（`{kind:'gateway'|'apiKey'|'chatgpt'}`），同时改 auth.json + config.toml。替代了旧的 `setApiKey` + `ensureCodexGatewayProvider`。renderer 经 `useCodexConfig` 的 `applyProfile`/`switchToChatgptLogin` 调用。acpClientService 不再做预启动 reconcile。"In use" 判定：gateway 看 `model_provider==='codex-gateway'`+base_url，apiKey 看 `authStatus.active==='apiKey' && !gatewayActive`。

相关：[[ai-service-foundation-progress]]
