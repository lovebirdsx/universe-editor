---
name: ai-request-blocked-by-dead-provider-endpoint
description: AI 调用每次固定慢 ~10s 的根因=热路径全量枚举 provider 被单个不可达网关拖垮；修法=按 modelId 定向解析 + per-endpoint 超时 + 超时冷却
metadata:
  type: project
---

**症状**：生成 commit message 等 AI 调用，AI Debug 面板显示 11012ms，但网关侧记录只有几百毫秒；且**每次都慢**，不是只有首次。

**根因（2026-08-29 实测确诊）**：热路径 `AiModelMainService.startRequest` 里 `getModelConfiguration` → `_schemaFor` → `registry.getModels()` 是 `Promise.all` **遍历全部 provider**。用户配了 10 个 provider（1 基础 + 9 个 `extends`，全继承 `"openai-chat": []` 即 discover 模式），其中一个私网网关不可达，于是每次请求都要等它跑满 `METADATA_REQUEST_TIMEOUT_MS = 10_000`。10s 超时 + ~1s 真实请求 = 11012ms。

**为什么每次都重付**：`_resolveEntryUncached` 在 discovery 失败时置 `incomplete = true`，而 `_resolveEntry` 只在 `!incomplete` 时写 `entry.models` 缓存（刻意设计：不把临时离线的网关钉死成「无模型」）。所以死端点永远缓存不上。

**修法（三层，缺一不可）**：
1. **定向解析**：modelId 三段式 `providerId/protocol/channelModel`，第一段唯一确定 entry。`AiModelRegistry.resolveModel` 用 `parseModelRef` 做 O(1) `_entries.get(providerId)`，只解析那一个 entry，并顺带返回 `AiModelMetadata`（含 `configurationSchema`，`toMetadata` 本就现成）。`startRequest` 直接 `mergeModelConfig(resolved.metadata.configurationSchema, ...)`，不再调 `getModelConfiguration`。
2. **per-endpoint 超时**：registry 内 `_discover` 给单次 `listModels` 2.5s deadline。必须用 `Promise.race`（不能只 await）——取消只是「请求」provider 停止，不遵守 token 的 provider 仍会挂住所有人。
3. **超时冷却 30s**：`_discoveryFailedAt: Map<providerId, timestamp>`。**只对超时记冷却，不对 reject 记**——连接被拒答得快，推迟重试只会让恢复的网关白黑 30s。这条是被既有测试 `re-resolves after a failed resolution (no poisoned cache)` 逼出来的，那个测试守护的正是这个语义。

**顺带**：renderer 侧 `_resolveModelId`（`InlineCompletionService` / `acpSessionTitleService`）原先也 `getModels()` 全量枚举来校验「选中模型是否还在」——内联补全每次按键都走，比 commit 更敏感。加了 `IAiModelService.hasModel(modelId)` 定向判存在（四层：platform 契约 → shared ipc → main → renderer 门面）。

**通用教训**：热路径只需要某一个 model 的信息时，绝不要用「拉全量再 find」的写法——它把所有 provider 的可用性串成了 AND，任何一个坏端点都变成全局延迟。`verifyProvider`（Test 按钮）直接调 `impl.listModels` 不经 registry，因此不受冷却影响。

相关：[[ai-panel-getmodels-blocking-latency]]（同源问题的另一处：getModels 在线枚举被绑进 reload 的 Promise.all）、[[ai-service-foundation-progress]]、[[ai-providers-visual-editing]]
