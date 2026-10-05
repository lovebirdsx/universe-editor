# AI 模型层：定向解析、发现超时与枚举缓存

AI 模型服务三层（platform 契约 / main 实现 / renderer 门面）见 `apps/editor/CLAUDE.md` 套路 I，条目数据模型与费率来源见 `apps/editor/cases-ai-provider-data-model.md`。本文只收**模型层内部机制**：热路径怎么定位一个模型、discovery 的超时与失败记忆、枚举结果的缓存指纹与失效规则。

共同背景是一次实测事故（2026-08-29 确诊）：用户配了 10 个 provider，其中一个网关不可达，**每次** AI 调用固定等满 10s。

## 热路径定向解析：只取一个模型时，绝不「拉全量再 find」

**根因**：`AiModelMainService.startRequest` 曾走 `getModelConfiguration` → `_schemaFor` → `registry.getModels()`，而后者是 `Promise.all` 遍历**全部** provider 的全量枚举。用户那 10 个 provider 是 1 基础 + 9 个 `extends`（全继承 `"openai-chat": []`，即 discover 模式），一个私网网关不可达，于是每次请求都要等它跑满 `METADATA_REQUEST_TIMEOUT_MS = 10_000`（`apps/editor/src/main/services/ai/aiModelMainService.ts:87`）。10s 超时 + ~1s 真实请求 = AI Debug 面板上的 11012ms，而网关侧只记几百毫秒。

**为什么每次都重付**：`_resolveEntryUncached` 在 discovery 失败时置 `incomplete`，`_resolveEntry` 只在完整时写 `entry.models` 缓存——这是**刻意设计**（不把临时离线的网关钉死成「无模型」），代价是死端点永远缓存不上。

**红线**：热路径只需要某一个 model 的信息时，绝不要「拉全量再 find」——它把所有 provider 的可用性串成 AND，任何一个坏端点都变成全局延迟。

**修法**：模型 id 三段式 `providerId/protocol/channelModel` 的**第一段唯一确定 entry**。`AiModelRegistry.resolveModel`（`packages/platform/src/ai/aiModelRegistry.ts`）用 `parseModelRef` 做 O(1) `_entries.get(providerId)`，只解析那一个 entry，并顺带返回含 `configurationSchema` 的元数据；`startRequest` 直接 `mergeModelConfig(resolved.metadata.configurationSchema, …)`，不再调 `getModelConfiguration`。只有解析不出的 id（陈旧的两层格式引用）才回退全表扫描。

renderer 侧的「选中模型是否还在」同理：别用 `getModels()` 全量枚举，走 `IAiModelService.hasModel(modelId)`（platform 契约 `packages/platform/src/ai/aiModelService.ts` → shared ipc `apps/editor/src/shared/ipc/aiModelService.ts` → main → renderer 门面 `apps/editor/src/renderer/services/ai/aiModelClientService.ts`，四层直达）。`InlineCompletionService`（`apps/editor/src/renderer/services/ai/InlineCompletionService.ts`）与 `acpSessionTitleService`（`apps/editor/src/renderer/services/acp/session/acpSessionTitleService.ts`）已改用——内联补全每次按键都走，比 commit message 更敏感。

## 发现超时与冷却

`AiModelRegistry._discover`（`packages/platform/src/ai/aiModelRegistry.ts`）的两条纪律：

- **单次 `listModels` 的 deadline 是 2.5s（`DISCOVERY_TIMEOUT_MS = 2_500`），且必须 `Promise.race` 而不是只 await**：取消只是「请求」provider 停止，一个不守 token 的 provider 仍会挂住所有人。deadline 到点做的是 `cts.cancel()` **而非 reject**，所以 race 之后还要判 `models === undefined || token.isCancellationRequested`——否则「被取消后 resolve 空数组」的超时会被当成「这个网关没有模型」，并被缓存成完整答案。
- **冷却 30s（`DISCOVERY_FAILURE_COOLDOWN_MS = 30_000`）只对 timeout 记，不对 reject 记**（`_discoveryFailedAt` 按 providerId 记时间戳）：连接被拒答得快，推迟重试只会让已恢复的网关白黑 30s。守护它的是既有测试 `re-resolves after a failed resolution (no poisoned cache)`（`packages/platform/src/__tests__/ai/aiModelRegistry.test.ts`）——先有测试、后有这条纪律。
- **端点相关性变化会清冷却**：`setProviders` 时条目指纹变了（端点/凭据/protocolMap 的改动很可能已修好 discovery 失败）就删掉该 provider 的冷却；指纹没变则继续吃冷却。
- **`verifyProvider`（Test 链路）不受冷却影响**：它直接调 `impl.listModels`、不经 registry，永远是一次真实探测。

## 枚举缓存指纹与失效

`AiModelRegistry.setProviders` 在**每次写盘后**都会跑（`AiModelMainService._reload`，由 `updateProviders` / `setApiKey` / `setModelConfiguration` 等写路径全体触达），它**按内容指纹复用 entry**，不再无条件 `_entries.clear()`——否则改一个与模型清单无关的字段也会清缓存、让下次 `getModels` 重打网络。指纹纯函数在 `packages/platform/src/ai/aiModelFingerprint.ts`：

- `computeProviderModelFingerprint` 覆盖 `id` / `baseUrl` / `apiKey` / `defaultProtocol` / `protocols`——恰好是「`listModels` 的输入」与「被服务模型渲染出的元数据」两类；**刻意排除 `pricingSource` / `usageSource`**，它们是纯展示字段，改了不该触发重新枚举。
- `computeKnowledgeFingerprint` 与 **knowledge 变化必须全量失效**：`setProviders(providers, knowledge)` 传了知识库且内容变了时，所有 entry 一律不复用。原因是 discover 型 provider 的指纹天然不含 knowledge（`protocols` 是空数组），而枚举时会把 `this._knowledge[channelModel]` 合并进元数据——保留缓存就会返回过时的 name / family / capabilities。**正确性优先于省一次网络请求。** 声明式（非 discover）条目把知识内联在自身条目里，知识变化本来就会改变它自己的指纹。
- **复用 in-flight `pending` 是安全的**，前提是 commit 闭包按 entry 身份判定（`this._entries.get(key) === entry` 且校验 `entry.pending`）：指纹相同就原地换 `provider` 引用、让在途结果继续；指纹变化时旧 entry 被踢出 map，它的在途结果自然不 commit。
- `aiModelFingerprint.ts` 是 ai 目录的**内部件**、不进 barrel：新增此类文件须登记 `packages/platform/src/__tests__/index.test.ts` 的 `INTERNAL` 白名单，否则 barrel coverage 用例会报警。

相关：`apps/editor/src/renderer/workbench/ai/cases-provider-panel.md`（同源问题在面板侧的另一处：网络枚举不得绑进刷新关键路径）、`apps/editor/cases-ai-provider-data-model.md`（条目/密钥/费率数据模型）。
