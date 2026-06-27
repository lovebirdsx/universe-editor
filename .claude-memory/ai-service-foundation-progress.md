---
name: ai-service-foundation-progress
description: AI 基础服务层（模型抽象/provider 注册/流式/取消/配置/密钥）已全部实施完成，含分层架构与扩展套路
metadata: 
  node_type: memory
  type: project
  originSessionId: dc261e01-bf02-41d3-9759-0c3cefe285f8
---

按 `docs/plan/ai-service-foundation-plan.md` 实施的 **AI 基础服务层**，阶段 0–8 全部完成（2026-06-14）。范围严格限定 AI 基建，不含业务（补全 UI / commit 生成是后续消费方）。

**三层架构**：
- platform 契约：`packages/platform/src/ai/`（`IAiModelService` 门面 + `IAiModelProvider` + `AiModelRegistry` + `AiResponseReassembler` + `aiModelTypes`）、`secret/secretStorageService.ts`；base 补了 `AsyncIterableSource`/`DeferredPromise`（async.ts）、`transformErrorForSerialization`（errors.ts）、`uuid.ts`。
- main 实现：`apps/editor/src/main/services/ai/`（`AiModelMainService` 持注册表+把 provider 流泵成 requestId 维度 chunk 事件、`SecretStorageMainService` safeStorage 加密、`providers/ollamaProvider.ts` + `retry.ts`）。
- renderer 门面：`renderer/services/ai/aiModelClientService.ts`（事件重组回干净 AsyncIterable + 推非密钥配置给 main）。
- 配置 schema：`renderer/contributions/AiConfigurationContribution.ts`（`ai.<vendor>.baseUrl`/`defaultModel`、`ai.request.temperature`/`maxTokens`，**不含 key**）。

**加新 vendor 套路**见 `apps/editor/CLAUDE.md` 套路 I：实现一个 `IAiModelProvider` + 一行 `registerProvider`。密钥红线：只走 `ISecretStorageService`（键名 `ai.secret.<vendor>.apiKey`），绝不进 renderer/settings.json/线协议。

**实施中发现并修复的真 bug**：`AiModelClientService` 原用 `affectsConfiguration('ai')` 监听配置变更，但平台的 `affectsConfiguration` 是精确匹配（非 VSCode section 前缀），导致 `ai.openai.defaultModel` 等单键变更不触发重推；改为枚举具体 key 列表 `CONFIG_KEYS`。

**验证**：`pnpm check` 32/32 绿（editor 2124 单测 + 23 集成）、`pnpm e2e` 97 passed。stage 7 临时 Developer 命令未做（依赖本地 Ollama+人工、且按计划验证后即删），改以 `aiModelClientService.test.ts` + `aiModelMainService.test.ts` 自动化覆盖同链路。
