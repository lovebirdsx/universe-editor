# AI 基础服务层 实施计划

> 配套设计文档：[`docs/report/ai-service-foundation-design.md`](../report/ai-service-foundation-design.md)
>
> 本计划把设计落成**可逐步执行、可独立验证**的任务序列。范围严格限定在 **AI 基础服务层**（模型抽象、provider 注册、请求调度、流式、取消、配置、密钥），**不含任何业务功能**（补全 UI、commit 生成等是后续消费方）。
>
> 通用纪律：
> - 每个阶段结束跑 `pnpm check`（仅截取错误输出）；涉及交互链路的阶段末跑 `pnpm e2e`。
> - platform 下新增任何模块，**立即**在 `packages/platform/src/index.ts` re-export，否则 apps 编译失败。
> - 改完 platform 后，`pnpm dev` 下 watcher 自动重建 dist；非 dev 模式手动 `pnpm --filter @universe-editor/platform build`。
> - 提交粒度建议按阶段，commit 信息遵循项目 conventional commits 风格。

---

## 阶段 0 · 前置确认（不产代码）

**目标**：确认两处设计依赖的底层能力是否已存在，决定是否需要补齐。

- [ ] 0.1 确认 `packages/platform/src/base/async.ts` 是否已有 `AsyncIterableSource` / `DeferredPromise`。
  - 当前已知 `async.ts` 仅有 idle 相关导出 → **大概率需要在阶段 1 补齐**。
- [ ] 0.2 确认 `packages/platform/src/base/errors.ts` 是否有 `transformErrorForSerialization` / 反序列化（跨进程错误回传需要）。无则在阶段 1 补一对轻量序列化工具。
- [ ] 0.3 确认 `generateUuid` 在 platform 是否可用（renderer 侧生成 requestId 用）。无则用现有等价工具或补。

**验证**：列出缺失项清单，并入阶段 1 的范围。

---

## 阶段 1 · platform 契约层（纯 TS，可单测，与 Electron 无关）

**目标**：把接口、数据结构、注册表逻辑、流重组工具沉到 platform，供 main/renderer 共享。

### 1.1 数据结构 `packages/platform/src/ai/aiModelTypes.ts`
- [ ] 定义 `AiModelMetadata` / `AiModelCapabilities` / `AiMessage` / `AiMessageRole` / `AiMessagePart` / `AiRequestOptions` / `AiResponseChunk` / `AiModelSelector` / `AiErrorCode`。
- [ ] `AiMessagePart` 的 `image` 分支用 `Uint8Array`，并在注释标注"过 IPC 需转可序列化形式"。

### 1.2 门面接口 `packages/platform/src/ai/aiModelService.ts`
- [ ] 定义 `IAiModelService` + `createDecorator('aiModelService')`。
- [ ] 定义 `AiResponse { stream: AsyncIterable<AiResponseChunk>; result: Promise<AiRequestResult> }` 与 `AiRequestResult`。
- [ ] 提供工具函数 `getTextResponse(response): Promise<string>`（对应 VSCode `getTextResponseFromStream`，含"流出错但已有部分文本"的容错）。

### 1.3 Provider 契约 `packages/platform/src/ai/aiModelProvider.ts`
- [ ] 定义 `IAiModelProvider`（`provideModels` / `sendRequest` / `provideTokenCount` / 可选 `onDidChange`）。

### 1.4 注册表 `packages/platform/src/ai/aiModelRegistry.ts`
- [ ] 实现纯逻辑注册表：`registerProvider(vendor, provider)`（vendor 唯一/互斥校验）、`getProvider(vendor)`、`providerForModel(modelId)`、模型缓存 + 失效、同 vendor 并发解析去重（promise 缓存，对应 VSCode `SequencerByKey`）。
- [ ] 不含任何 IPC / Electron 依赖。

### 1.5 流重组工具 `packages/platform/src/ai/aiStream.ts`
- [ ] 若阶段 0.1 确认缺失：实现/补齐 `AsyncIterableSource`（`emitOne` / `resolve` / `reject` / `asyncIterable`）与 `DeferredPromise`。
- [ ] 提供"chunk 事件 → AsyncIterable"重组的辅助（接收端用）。

### 1.6 密钥接口 `packages/platform/src/secret/secretStorageService.ts`
- [ ] 定义 `ISecretStorageService`（`get` / `set` / `delete`）+ `createDecorator('secretStorageService')`。仅接口，实现在 main。

### 1.7 re-export + 单测
- [ ] 在 `packages/platform/src/index.ts` 追加 `export * from './ai/*.js'` 与 `./secret/secretStorageService.js`（逐文件）。
- [ ] `src/__tests__/ai/` 写注册表（唯一性/失效/并发去重）与流重组（正常/中途 reject/取消）单测。

**验证**：`pnpm --filter @universe-editor/platform check` 通过；单测覆盖注册表与流重组。

---

## 阶段 2 · 密钥服务（main 进程）

**目标**：基于 Electron `safeStorage` 提供加密密钥存取，API key 永不进 renderer / settings.json。

### 2.1 `apps/editor/src/main/services/ai/secretStorageMainService.ts`
- [ ] `class SecretStorageMainService implements ISecretStorageService`。
- [ ] `safeStorage.encryptString/decryptString` 加密；密文经 `IStorageService` 落盘 userData。
- [ ] key 命名约定 `ai.secret.<vendor>.apiKey`；`safeStorage.isEncryptionAvailable()` 不可用时的降级策略（明确报错或日志告警，不静默明文）。
- [ ] logger 走可选 `@ILoggerService` 注入（参考套路 C）。

### 2.2 注册为 root 单例
- [ ] `main-services.ts` `registerSingleton(ISecretStorageService, ...)`；接入 `ApplicationServices` 与 `getOrCreateServices()` 组装表。

**验证**：main 单测（node 环境）覆盖加解密往返、key 不存在返回 undefined、delete 生效（safeStorage 可在测试中 stub）。`pnpm check` 通过。

---

## 阶段 3 · main 门面 + 首个 provider

**目标**：打通"注册 provider → 解析模型 → 发起请求 → 流式产出"在 main 进程内的闭环。

### 3.1 `apps/editor/src/main/services/ai/aiModelMainService.ts`
- [ ] `class AiModelMainService implements IAiModelService`，内部持有阶段 1.4 的注册表实例。
- [ ] 流式出口：`_onDidEmitChunk: Emitter<{requestId, chunk}>` + `_onDidEndRequest: Emitter<{requestId, error?}>`（公开 `.event`，供 ProxyChannel 桥接）。
- [ ] `_inflight: Map<requestId, CancellationTokenSource>`。
- [ ] `startRequest(requestId, messages, options)`：选 provider → 合并配置（schema 默认 → 用户 settings → 单次 options 三层）→ 把 provider 流"泵"成事件 → 完成/出错经 `_onDidEndRequest` 回传 → finally 清理 inflight。
- [ ] `cancelRequest(requestId)`：`cts.cancel()`。
- [ ] `getModels` / `selectModels` / `computeTokenLength`：委托注册表/provider，含懒解析 + 缓存。
- [ ] 可选：泵流时做 30ms / 30 条批处理（对齐 VSCode `extHostLanguageModels.ts:276`），降低 IPC 频率。

### 3.2 首个 provider `apps/editor/src/main/services/ai/providers/`
- [ ] **建议先做 `ollamaProvider.ts`**（本地无需真 key，便于端到端验证），再加 `openAiProvider.ts`。
- [ ] provider 内：读密钥（经 `ISecretStorageService`）/ baseUrl（经配置）→ 构造 HTTP body → 解析 SSE/流式响应为 `AiResponseChunk` 逐片 yield → 监听 `token.onCancellationRequested` 中止请求 → HTTP 状态映射到 `AiErrorCode`。
- [ ] 重试逻辑（如需要）放 provider 内部；可提供共享 `retryWithBackoff` 工具。

### 3.3 注册 provider
- [ ] 在 `AiModelMainService` 构造时或一个 `BlockStartup` Contribution 注册内置 provider。

**验证**：main 单测覆盖 `startRequest` 流泵送、取消路径、错误回传（provider 用假流 stub，不打真网络）。`pnpm check` 通过。

---

## 阶段 4 · IPC 接线

**目标**：把 main 门面经 ProxyChannel 暴露给 renderer。

- [ ] 4.1 `apps/editor/src/shared/ipc/channelNames.ts`：`ServiceChannels` 加 `AiModel: 'aiModel'`。
- [ ] 4.2 `apps/editor/src/shared/ipc/aiModelService.ts`：定义 IPC 友好 DTO（消息/chunk/options 的可序列化形式；`Uint8Array` ↔ `VSBuffer` 转换约定，参考"URI 经 IPC 需 revive"）。
- [ ] 4.3 `apps/editor/src/main/ipc/registerMainServices.ts`：`server.registerChannel(ServiceChannels.AiModel, ProxyChannel.fromService(app.aiModel))`。
- [ ] 4.4 把 `aiModel` 加进 `ApplicationServices`（`window/scopedServicesFactory.ts`）与 `getOrCreateServices()`（`index.ts`）组装表。

**验证**：`pnpm check` 通过；确认 `on*` 事件被 ProxyChannel 正确识别为 `listen`。

---

## 阶段 5 · renderer 门面（代理 + 流重组）

**目标**：renderer 侧把离散 chunk 事件重组成干净 `AsyncIterable`,消费方无感知传输细节。

### 5.1 `apps/editor/src/renderer/services/ai/aiModelClientService.ts`
- [ ] `class AiModelClientService implements IAiModelService`，包住 `ProxyChannel.toService` 得到的 main 代理。
- [ ] `sendRequest`：生成 `requestId` → 建 `AsyncIterableSource` + `DeferredPromise` → 订阅 `onDidEmitChunk`/`onDidEndRequest` 并按 `requestId` 路由 → `token.onCancellationRequested` 反向 `call` `cancelRequest` → fire `startRequest` → 返回 `{stream, result}`。
- [ ] 订阅在请求结束（complete/error）时 dispose，避免泄漏。
- [ ] DTO ↔ 领域类型转换在此边界完成。

### 5.2 `main.tsx` 绑定
- [ ] `services.set(IAiModelService, new AiModelClientService(ProxyChannel.toService(ipc.getChannel(ServiceChannels.AiModel))))`（参考 bootstrap 链路第 2/4 步）。

**验证**：`pnpm check` 通过。

---

## 阶段 6 · 配置 schema

**目标**：vendor 的非密钥配置走 `ConfigurationRegistry`。

- [ ] 6.1 新建一个 `BlockStartup` 阶段 Contribution（`contributions/`，参考套路 D），注册 `ai.*` 配置项：`ai.<vendor>.baseUrl`、`ai.<vendor>.defaultModel`、`ai.request.temperature` 等（**不含 key**）。
- [ ] 6.2 在 `contributions/index.ts` 以 `WorkbenchPhase.BlockStartup` 注册。
- [ ] 6.3 配置文案走 `localize`。
- [ ] 6.4 确认 `AiModelMainService._mergeConfig` 能读到这些配置（main 侧通过配置服务读取）。

**验证**：`pnpm check` 通过；设置项出现在 settings UI。

---

## 阶段 7 · 端到端冒烟验证（临时，验证后移除）

**目标**：确认 renderer → main → provider → 流式回传 → 取消 全链路通畅，**不引入任何业务**。

- [ ] 7.1 临时加一个 Developer 命令（Action2，`actions/`）：调 `IAiModelService.sendRequest`，把流 chunk 打到 Output/console。
- [ ] 7.2 手动验证：正常流式输出、`getTextResponse` 聚合、中途取消（确认 main 端 HTTP 真的中止）、错误提示（如未配 key/网络失败）。
- [ ] 7.3 （可选）加一个 `@p1` E2E 冒烟：经 `window.__E2E__` 探针调用 `sendRequest`(对接一个 mock/local provider)，断言收到 chunk —— 若加，扩 `shared/e2e/contract.ts` + `renderer/e2e/probe.ts`，保持白名单原则。
- [ ] 7.4 验证通过后**移除临时命令**（保留可选的 E2E 探针）。

**验证**：`pnpm e2e`（仅截取错误输出）；端到端手测通过。

---

## 阶段 8 · 收尾

- [ ] 8.1 `pnpm check` + `pnpm e2e` 全绿。
- [ ] 8.2 仅在**确有必要**时更新 CLAUDE.md（如新增"加 AI provider 的套路"值得沉淀为导航条目）——遵循项目"非必要不更新"原则。
- [ ] 8.3 确认无遗留临时代码、无明文密钥路径、无未 dispose 的事件订阅。

---

## 任务依赖图

```
阶段0 ──► 阶段1 ──┬──► 阶段2 ──┐
                  │            ├──► 阶段3 ──► 阶段4 ──► 阶段5 ──► 阶段6 ──► 阶段7 ──► 阶段8
                  └────────────┘
```

- 阶段 1 是一切的基础（契约 + 工具）。
- 阶段 2（密钥）与阶段 3（门面/provider）都依赖阶段 1；阶段 3 依赖阶段 2（provider 要读 key）。
- 阶段 4/5/6 依次串接；阶段 7 验证全链路；阶段 8 收尾。

## 验收标准（Definition of Done）

1. 新增一个 AI 供应商 = 实现一个 `IAiModelProvider` + 一行 `registerProvider`，**门面/IPC/renderer/消费方零改动**。
2. 消费方只依赖 `IAiModelService` 门面，可拿到干净的 `AsyncIterable` 流并能随时取消（取消真正中止 main 端 HTTP）。
3. API key 经 `safeStorage` 加密落盘，renderer 与 settings.json 中均无明文。
4. 配置三层合并（schema 默认 → 用户 settings → 单次请求）生效。
5. `pnpm check` 与 `pnpm e2e` 全绿；platform 契约层有单测覆盖注册表与流重组。
6. 仓库内无业务逻辑混入 AI 服务层。
```
