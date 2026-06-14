# AI 基础服务层设计方案

> 目标：为后续的 Inline Suggestions（代码补全）、Git 提交消息生成等 AI 功能，搭建一个**可维护、可扩展**的 AI API 调用基建。本方案**只聚焦 AI 基础服务层**（模型抽象、provider 注册、请求调度、流式传输、取消、配置与密钥），不涉及任何上层业务功能。
>
> 调研对象：`D:\git_project\vscode`（真实源码，commit `12443ea83d4`），核心参考 `src/vs/workbench/contrib/chat/common/languageModels.ts`。

---

## 1. 设计目标与非目标

### 目标
- **provider 即插即用**：新增一个 AI 供应商（OpenAI / Anthropic / Ollama / 自建网关）只需实现一个接口 + 注册一行，不改动调用方。
- **消费方解耦**：Inline Suggestions、Commit 消息生成等未来功能，统一面向**一个稳定门面**编程，不感知 vendor 差异。
- **流式优先**：所有响应以流（chunk）方式返回，调用方可边到达边消费、随时取消。
- **取消贯穿**：从 UI 触发到底层网络请求，`CancellationToken` 全链路传递。
- **密钥安全**：API key 不落在 renderer，不明文持久化。
- **与现有内核同构**：完全复用本项目 platform 的 DI / Event / Configuration / IPC / Lifecycle 套路，零新范式。

### 非目标（本期不做）
- 任何业务功能（补全 UI、commit 生成 prompt、聊天）——它们是本基建的**消费方**，单独迭代。
- 扩展（extension）机制——本项目是桌面 app，无 VSCode 式扩展宿主，provider 由应用内置注册即可。
- 工具调用（tool calling / agent mode）的完整实现——预留数据结构，实现延后。

---

## 2. VSCode 做法提炼（调研结论）

VSCode 把"AI API 调用"抽象在 `ILanguageModelsService`（`languageModels.ts:358`），其设计精髓有六点，全部值得借鉴：

| # | 设计点 | VSCode 实现 | 对我们的价值 |
|---|---|---|---|
| 1 | **门面 + provider 分离** | `ILanguageModelsService`（门面）持有 `Map<vendor, ILanguageModelChatProvider>`；门面只做注册表/缓存/调度，真正的网络调用在 provider | 调用方永远只依赖门面；加 vendor 不动门面 |
| 2 | **vendor 为注册键** | `registerLanguageModelProvider(vendor, provider)`，vendor 唯一、互斥（`languageModels.ts:1021`） | 天然的命名空间，多供应商共存 |
| 3 | **模型元数据自描述能力** | `ILanguageModelChatMetadata`（`:190`）带 `maxInputTokens`、`capabilities.{vision,toolCalling,agentMode}`、`family` 等 | 上层按能力分流（如补全只挑低延迟模型） |
| 4 | **流式 = AsyncIterable + result Promise** | `ILanguageModelChatResponse { stream: AsyncIterable<...>; result: Promise<any> }`（`:253`） | 消费方拿到的是干净的异步流；错误经 `result` 暴露 |
| 5 | **selector 选模型** | `selectLanguageModels({vendor?,family?,id?...})` → `modelId[]`（`:996`） | 调用方按条件挑模型，而非硬编码 id |
| 6 | **配置三层合并** | schema default → 用户配置 → 单次请求 options（`:1057`） | 既有合理默认，又允许逐请求覆盖 temperature 等 |

此外两个**跨进程相关**的关键事实（VSCode 在 extHost↔main 之间，我们在 renderer↔main 之间，问题同构）：

- **流式跨进程靠 chunk 推送 + 接收端重组**：VSCode 在 `extHostLanguageModels.ts` 用 `AsyncIterableSource` 在接收端把一个个 RPC chunk 重新拼成 `AsyncIterable`，并做 30ms / 30 条的批处理（`extHostLanguageModels.ts:276`）降低跨进程频率。**跨进程边界传的是离散 chunk 事件，不是 AsyncIterable 本身。**
- **错误分两路**：流中途失败时，`stream.reject()` 与 `result.error()` 分别通知"流消费者"和"等待最终结果者"（`mainThreadLanguageModels.ts:119`）。

> 补充：Inline Completions 在 VSCode 里**不直接依赖** `languageModels` 服务，而是走编辑器自己的 `InlineCompletionsProvider` 注册表（`editor/common/languages.ts:948`），并用 `yieldsToGroupIds` 有向图解决多 provider 优先级。这给我们的启示是：**AI 服务层只管"调模型拿文本"，"补全 provider 怎么排队/触发"是消费方（编辑器集成层）的事，二者分层**。本方案只做前者。

---

## 3. 本项目约束与对齐点（落地前提）

通过核查 `packages/platform` 与 `apps/editor` 现有代码，确认以下硬约束——它们直接决定了设计形态：

| 约束 | 现状 | 对设计的影响 |
|---|---|---|
| **IPC 能力** | `IChannel` 只有 `call`（请求/响应）+ `listen`（Event 推送）（`platform/src/ipc/ipc.ts:32`）；`ProxyChannel` 自动把 `on[A-Z]*` 事件桥接为远端可订阅（`proxyChannel.ts:6`） | **跨进程不能直接传 AsyncIterable**。流式必须用「`requestId` + `listen` 事件」重组——这正是项目已有范式 |
| **已有流式先例** | `IAcpHostService` 用 `handle` + `onStdout/onStderr/onExit` 三个 `Emitter` 把子进程 stdio 流推给 renderer（`acpHostMainService.ts:159`） | **直接对齐此范式**，不发明新机制 |
| **密钥存储** | 无 secret/safeStorage 能力；ACP 当前把 env（含 key）明文存配置，并在 schema 注释里警告"keep API keys in real environment variables"（`AgentsContributions.ts:44`） | 需**新增 main 进程 SecretStorage（Electron `safeStorage`）**，作为本方案的伴生基础设施 |
| **取消** | platform 已有 `CancellationToken` / `CancellationTokenSource`，已在 `index.ts` re-export（`base/cancellation.ts`） | 直接复用，但**取消信号需跨进程传递**（见 §6.3） |
| **DI / Config / Lifecycle / Storage** | 齐备：`createDecorator`、`ConfigurationRegistry`、`LifecyclePhase`、`IStorageService` | provider 注册、配置 schema、懒加载时机全部有现成挂钩 |
| **进程分工** | ACP / 网络类逻辑均在 main；renderer 经 `ProxyChannel.toService` 拿代理 | **AI 网络调用放 main 进程**（密钥不入 renderer、规避 CORS、与 ACP 同构） |

### 关键架构决策

> **决策 1：AI 网络调用与密钥都在 main 进程，renderer 仅持代理。**
> 理由：① 密钥永不进入 renderer 内存与 DevTools；② renderer 的 fetch 受 CSP/CORS 限制，main 无此限制；③ 与项目既有 ACP / update / textSearch 等 main 服务一致。

> **决策 2：跨进程流式走「requestId + 事件」重组，对齐 `acpHost`。**
> main 端 provider 产生的 chunk 通过一个携带 `requestId` 的 `Emitter` 推送；renderer 端 service 订阅该事件、按 `requestId` 路由，在接收端用 `AsyncIterableSource` 重组成 `AsyncIterable` 交给消费方。**消费方拿到的是干净的 `AsyncIterable`，传输细节被 service 封装。**

---

## 4. 总体架构

```
┌───────────────────────────────── renderer 进程 ─────────────────────────────────┐
│                                                                                  │
│  消费方（未来业务，各自独立迭代）                                                  │
│   ├─ Inline Suggestions 集成层  ─┐                                               │
│   ├─ Commit 消息生成            ─┼──► 只依赖 IAiModelService（门面，稳定接口）     │
│   └─ 其它 AI 功能…              ─┘            │                                   │
│                                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ AiModelService (renderer 侧门面 / 代理重组层)                                │ │
│  │  • selectModels() / sendRequest() / computeTokenLength()                    │ │
│  │  • 把 main 推来的 chunk 事件按 requestId 重组为 AsyncIterable                 │ │
│  │  • 取消：调用方 token → 经 IPC 通知 main 取消该 requestId                     │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────│──────────────────────────────────────┘
                                         │  ProxyChannel (call + listen)
                                         │  ServiceChannels.AiModel
┌───────────────────────────────────────▼──────────────────────────────────────┐
│                                  main 进程                                       │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ AiModelMainService  (implements IAiModelService) —— 注册表 + 调度 + 缓存     │ │
│  │  • _providers: Map<vendor, IAiModelProvider>                                │ │
│  │  • _modelCache: Map<modelId, AiModelMetadata>                               │ │
│  │  • _onDidEmitChunk: Emitter<{ requestId, chunk }>   ← 流式出口（被桥接）      │ │
│  │  • sendRequest(): 选 provider → 透传 chunk → 完成/出错经事件回传              │ │
│  └───────────────┬──────────────────────────────┬────────────────────────────┘ │
│                  │ registerProvider             │ 读密钥                          │
│     ┌────────────▼───────────┐      ┌───────────▼─────────────┐                  │
│     │ IAiModelProvider 实现   │      │ ISecretStorageService    │                  │
│     │  ├─ OpenAiProvider      │      │ (Electron safeStorage)   │                  │
│     │  ├─ AnthropicProvider   │      └──────────────────────────┘                  │
│     │  └─ OllamaProvider …    │                                                   │
│     └─────────────┬───────────┘                                                   │
│                   │ HTTPS（流式 SSE / fetch ReadableStream）                       │
└───────────────────┼───────────────────────────────────────────────────────────┘
                    ▼
              各 AI 供应商 API
```

**分层职责一句话**：
- **消费方** —— 只调门面，写 prompt、消费文本流。
- **门面 `IAiModelService`** —— 注册表、模型发现/缓存、请求调度、配置合并、流式重组、取消路由。**它不知道任何 vendor 细节。**
- **`IAiModelProvider`** —— 一个 vendor 一个实现，负责"把标准化请求翻译成该家 HTTP API，并把响应翻译回标准 chunk"。**它不知道注册表、缓存、IPC。**
- **`ISecretStorageService`** —— 加密存取 API key。

---

## 5. 目录与模块布局

AI 服务层下沉到 platform 作为**与具体业务无关的内核能力**？还是放 apps？取舍如下：

- **接口契约 + 数据结构 + 注册表逻辑**（纯 TS、可单测、与 Electron 无关）→ **沉到 `packages/platform/src/ai/`**，便于 main/renderer 共享类型，并遵循 platform "纯 node 测试"原则。
- **provider 的 HTTP 实现 + main 服务接线 + renderer 代理** → 放 `apps/editor`（依赖 Electron `net`/`safeStorage`、`ProxyChannel`）。

```
packages/platform/src/ai/                      # 内核：契约 + 注册表 + 重组工具
  aiModelService.ts        IAiModelService 接口 + createDecorator
  aiModelProvider.ts       IAiModelProvider 接口（vendor 实现契约）
  aiModelTypes.ts          AiMessage / AiResponseChunk / AiModelMetadata / capabilities / selector
  aiModelRegistry.ts       provider 注册表（纯逻辑，可单测）
  aiStream.ts              chunk 事件 ↔ AsyncIterable 重组工具（接收端 AsyncIterableSource）
  __tests__/               纯 node 单测
  # ★ 别忘了在 packages/platform/src/index.ts re-export 上述全部

packages/platform/src/secret/                  # 伴生基础设施：密钥
  secretStorageService.ts  ISecretStorageService 接口 + createDecorator

apps/editor/src/main/services/ai/
  aiModelMainService.ts    AiModelMainService implements IAiModelService（注册表实例 + 调度）
  providers/
    openAiProvider.ts
    anthropicProvider.ts
    ollamaProvider.ts
  secretStorageMainService.ts   基于 Electron safeStorage + IStorageService 落盘密文

apps/editor/src/shared/ipc/
  aiModelService.ts        跨进程 DTO（消息/chunk/请求选项的 IPC 友好结构）
  channelNames.ts          ServiceChannels.AiModel = 'aiModel'（追加一行）

apps/editor/src/renderer/services/ai/
  aiModelClientService.ts  renderer 侧门面：代理 + chunk 重组为 AsyncIterable
```

> 遵循项目铁律：platform 下新增模块**必须**在 `packages/platform/src/index.ts` re-export，否则 apps 编译失败（见 `packages/platform/CLAUDE.md`）。

---

## 6. 核心接口设计

### 6.1 数据结构（`aiModelTypes.ts`）

精简自 VSCode `ILanguageModelChatMetadata` / `IChatMessage`，去掉 extension / chat 业务字段，保留可扩展骨架：

```ts
// ── 模型元数据：自描述能力，供上层按能力选模型 ──
export interface AiModelMetadata {
  readonly id: string            // 全局唯一，如 'openai/gpt-4o'
  readonly vendor: string        // 注册键，如 'openai'
  readonly name: string          // 展示名
  readonly family: string        // 'gpt-4o' | 'claude-3-5-sonnet' …（同族不同版本归并）
  readonly version?: string
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly capabilities: AiModelCapabilities
}

export interface AiModelCapabilities {
  readonly streaming: boolean
  readonly vision?: boolean
  readonly toolCalling?: boolean   // 预留，本期可不实现
}

// ── 请求消息：role + 多段 content（为未来 vision/tool 预留 part 联合） ──
export const enum AiMessageRole { System, User, Assistant }

export interface AiMessage {
  readonly role: AiMessageRole
  readonly content: AiMessagePart[]
}
export type AiMessagePart =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: Uint8Array } // 预留

// ── 单次请求选项：逐请求覆盖默认配置 ──
export interface AiRequestOptions {
  readonly modelId: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  // 透传给 provider 的额外参数（vendor 特有），由门面做三层合并
  readonly extra?: Readonly<Record<string, unknown>>
}

// ── 流式响应分片：跨进程传输的最小单元 ──
export type AiResponseChunk =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
// 未来可加 'tool_use' | 'thinking' …

// ── 选择器：按条件挑模型，避免硬编码 id ──
export interface AiModelSelector {
  readonly vendor?: string
  readonly family?: string
  readonly id?: string
  readonly capabilities?: Partial<AiModelCapabilities>  // 如 { streaming: true }
}
```

### 6.2 门面接口（`aiModelService.ts`）—— 消费方唯一依赖

```ts
export interface IAiModelService {
  readonly _serviceBrand: undefined

  /** vendor 或模型列表变化（如用户配置了新 API key 后某 vendor 可用） */
  readonly onDidChangeModels: Event<void>

  /** 列出当前可用模型（已解析、含元数据） */
  getModels(): Promise<readonly AiModelMetadata[]>

  /** 按条件挑模型，返回 modelId 列表（调用方再决定取第一个/让用户选） */
  selectModels(selector: AiModelSelector): Promise<readonly string[]>

  /**
   * 发起请求。返回干净的流 + 最终结果 Promise。
   * - stream：边到达边产出文本/usage 分片
   * - result：整体完成或失败（错误经此抛出）
   * - token：取消信号，会跨进程通知 main 中止网络请求
   */
  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    token: CancellationToken,
  ): AiResponse

  /** token 计数（用于裁剪上下文，避免超出 maxInputTokens） */
  computeTokenLength(modelId: string, text: string, token: CancellationToken): Promise<number>
}
export const IAiModelService = createDecorator<IAiModelService>('aiModelService')

/** 与 VSCode ILanguageModelChatResponse 同构：流 + 最终结果分离 */
export interface AiResponse {
  readonly stream: AsyncIterable<AiResponseChunk>
  readonly result: Promise<AiRequestResult>
}
export interface AiRequestResult {
  readonly usage?: { inputTokens: number; outputTokens: number }
}
```

> **为什么 `sendRequest` 返回 `{stream, result}` 而非直接 `AsyncIterable`？**
> 借鉴 VSCode：`stream` 给"边读边显示"的消费者（如 inline 补全增量渲染）；`result` 给"只要最终文本/用量"或"要捕获错误"的消费者。两类需求都常见，分离最干净。便捷封装可另提供一个 `getTextResponse(response): Promise<string>` 工具函数（对应 VSCode `getTextResponseFromStream`，`languageModels.ts:259`）。

### 6.3 Provider 接口（`aiModelProvider.ts`）—— vendor 实现契约

```ts
export interface IAiModelProvider {
  /** 模型列表变化时通知门面重新缓存（对应 VSCode provider.onDidChange） */
  readonly onDidChange?: Event<void>

  /** 该 vendor 当前提供哪些模型（可能依赖已配置的 API key；无 key 时返回空） */
  provideModels(token: CancellationToken): Promise<readonly AiModelMetadata[]>

  /**
   * 执行一次请求。provider 负责：
   *  - 读取自己的密钥/baseUrl
   *  - 把标准 AiMessage 翻译成该家 HTTP body
   *  - 把 SSE/流式响应翻译回 AiResponseChunk，逐片 yield
   *  - 监听 token.onCancellationRequested 中止网络请求
   */
  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    token: CancellationToken,
  ): AiResponse

  provideTokenCount(modelId: string, text: string, token: CancellationToken): Promise<number>
}
```

**注册**（注册表逻辑在 `aiModelRegistry.ts`，被 `AiModelMainService` 持有）：

```ts
// AiModelMainService 内
registerProvider(vendor: string, provider: IAiModelProvider): IDisposable {
  if (this._providers.has(vendor)) throw new Error(`vendor ${vendor} already registered`)
  this._providers.set(vendor, provider)
  const sub = provider.onDidChange?.(() => this._invalidateCache(vendor))
  this._onDidChangeModels.fire()
  return toDisposable(() => { this._providers.delete(vendor); sub?.dispose(); this._onDidChangeModels.fire() })
}
```

> **可扩展性的核心就在这里**：加一个新供应商 = 写一个 `implements IAiModelProvider` 的类 + `registerProvider('xxx', new XxxProvider(...))` 一行。门面、消费方、IPC 全不改。

---

## 7. 跨进程流式传输设计（本方案最关键的工程点）

由于 IPC 只有 `call` + `listen`，`AsyncIterable` 无法直接过 IPC。设计如下，**对齐 `acpHost` 既有范式**：

### main 端（`AiModelMainService`）

```ts
// 流式出口：一个 Emitter，所有进行中的请求共用，用 requestId 区分
private readonly _onDidEmitChunk = this._register(new Emitter<{ requestId: string; chunk: AiResponseChunk }>())
readonly onDidEmitChunk = this._onDidEmitChunk.event              // ← ProxyChannel 自动桥接

private readonly _onDidEndRequest = this._register(new Emitter<{ requestId: string; error?: SerializedError }>())
readonly onDidEndRequest = this._onDidEndRequest.event

private readonly _inflight = new Map<string, CancellationTokenSource>()

// renderer 通过 call 调用：发起请求，返回 requestId（不在此返回流）
async startRequest(requestId: string, messages: AiMessage[], options: AiRequestOptions): Promise<void> {
  const cts = new CancellationTokenSource()
  this._inflight.set(requestId, cts)
  const provider = this._providerForModel(options.modelId)
  const resp = provider.sendRequest(messages, this._mergeConfig(options), cts.token)
  // 把 provider 的流"泵"成事件（可在此做 30ms/30 条批处理，对齐 VSCode）
  ;(async () => {
    try {
      for await (const chunk of resp.stream) this._onDidEmitChunk.fire({ requestId, chunk })
      await resp.result
      this._onDidEndRequest.fire({ requestId })
    } catch (e) {
      this._onDidEndRequest.fire({ requestId, error: transformErrorForSerialization(e) })
    } finally {
      this._inflight.get(requestId)?.dispose()
      this._inflight.delete(requestId)
    }
  })()
}

// 取消：renderer 通过 call 通知
async cancelRequest(requestId: string): Promise<void> {
  this._inflight.get(requestId)?.cancel()
}
```

### renderer 端（`AiModelClientService`，实现 `IAiModelService`）

```ts
sendRequest(messages, options, token): AiResponse {
  const requestId = generateUuid()
  const source = new AsyncIterableSource<AiResponseChunk>()   // 接收端重组（对应 VSCode 做法）
  const result = new DeferredPromise<AiRequestResult>()

  // 路由：只处理本 requestId 的 chunk
  const subChunk = this._main.onDidEmitChunk(e => { if (e.requestId === requestId) source.emitOne(e.chunk) })
  const subEnd = this._main.onDidEndRequest(e => {
    if (e.requestId !== requestId) return
    if (e.error) { source.reject(deserialize(e.error)); result.error(deserialize(e.error)) }
    else { source.resolve(); result.complete(collectUsage()) }
    subChunk.dispose(); subEnd.dispose()
  })

  // 取消信号跨进程传递
  token.onCancellationRequested(() => { void this._main.cancelRequest(requestId) })

  void this._main.startRequest(requestId, [...messages], options)  // fire；流经事件回来
  return { stream: source.asyncIterable, result: result.p }
}
```

**要点**：
1. 跨进程传的是**离散 chunk 事件**，`AsyncIterable` 在 renderer 侧由 `AsyncIterableSource` 重新组装——消费方无感知。
2. `requestId` 做多请求复用同一对事件通道的路由键（同 `acpHost` 的 `handle`）。
3. 取消是**反向 `call`**：renderer token 触发 → `cancelRequest(requestId)` → main 端 `CancellationTokenSource.cancel()` → provider 中止 HTTP。
4. 错误分两路（`stream.reject` + `result.error`），与 VSCode 一致。
5. **需要补一个工具**：platform `aiStream.ts` 提供 `AsyncIterableSource`（若 `base/async.ts` 尚无，需补；这是本方案对 platform 的一处增量）。

> DTO 注意：`AiMessage` 里的 `image.data: Uint8Array` 过 IPC 需用 `VSBuffer`/可序列化形式；`shared/ipc/aiModelService.ts` 定义 IPC 友好 DTO，service 边界做一次转换（参考项目"URI 经 IPC 后需 `URI.revive`"的既有约定）。

---

## 8. 配置与密钥

### 8.1 配置 schema（走 `ConfigurationRegistry`）

每个 vendor 注册自己的配置项（baseUrl、默认模型、temperature 默认值等**非密钥**配置）。**API key 不进 settings.json**，单独走 SecretStorage。

```ts
// 在某个 BlockStartup 阶段的 Contribution 里注册（参考项目套路 D）
ConfigurationRegistry.registerConfiguration({
  id: 'ai',
  title: localize('settings.ai', 'AI'),
  properties: {
    'ai.openai.baseUrl': { type: 'string', default: 'https://api.openai.com/v1' },
    'ai.openai.defaultModel': { type: 'string', default: 'gpt-4o' },
    'ai.request.temperature': { type: 'number', default: 0.2 },
    // …
  },
})
```

**三层配置合并**（对齐 VSCode `languageModels.ts:1057`）：schema default → 用户 settings → 单次 `AiRequestOptions`，在门面 `_mergeConfig()` 收口。

### 8.2 密钥：新增 `ISecretStorageService`

当前项目无 secret 能力（ACP 明文存 env 并警告用户）。本方案引入 main 进程密钥服务：

```ts
export interface ISecretStorageService {
  readonly _serviceBrand: undefined
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
```

实现：Electron `safeStorage.encryptString/decryptString` 加密 → 密文经 `IStorageService` 落盘到 userData。key 命名如 `ai.secret.openai.apiKey`。provider 在 `sendRequest` 时按需读取。

> renderer 永远拿不到明文 key——它只会触发"请求"，key 的读取与使用全在 main。配置 UI 若需录入 key，经一个专用 `call`（如 `setSecret`）写入，不回读明文。

---

## 9. 生命周期与懒加载

- **provider 注册时机**：`AiModelMainService` 作为 root 容器单例（参考套路 C 的 `registerSingleton` + `main-services.ts`），在构造时注册内置 provider；或用一个 `BlockStartup` Contribution 注册（若需依赖配置）。
- **模型懒解析**：`getModels()/selectModels()` 首次调用时才 `provider.provideModels()`，结果进 `_modelCache`；provider `onDidChange`（如用户新配了 key）时失效重建。对应 VSCode 的 lazy resolve（`languageModels.ts:808`），但**无需 extension 激活事件**——provider 已在进程内，省去这层复杂度。
- **并发去重**：同一 vendor 的解析用一个 promise 缓存防并发重复请求（对应 VSCode `SequencerByKey`）。

---

## 10. 错误处理与重试

| 关注点 | 设计 |
|---|---|
| **流中途失败** | 经 `onDidEndRequest` 带 `SerializedError` 回传 → renderer 侧 `stream.reject()` + `result.error()` 双路（同 VSCode） |
| **取消** | 取消不算错误，provider 收到 `CancellationToken` 后抛 `CancellationError`，门面识别并安静结束 |
| **重试** | **放在 provider 内部**（不同 vendor 的限流/可重试错误码不同）。门面不做统一重试，避免对不可重试请求误重试。可提供一个 `retryWithBackoff` 工具供 provider 复用 |
| **错误分类** | 定义 `AiErrorCode`（`Unauthorized` / `RateLimited` / `QuotaExceeded` / `NetworkError` / `Canceled` / `Unknown`），provider 把 HTTP 状态映射到此，消费方据此给用户提示 |

---

## 11. 可扩展性验证：两个未来场景如何落在本基建上

### 场景 A：Inline Suggestions（代码补全）
1. 编辑器集成层实现一个 `InlineCompletionsProvider`（这是**消费方**，属编辑器侧，不在本基建内）。
2. 在其 `provideInlineCompletions` 里：`selectModels({family:'gpt-4o', capabilities:{streaming:true}})` 选模型 → `sendRequest(promptMessages, {modelId, maxTokens: 256}, token)`。
3. 用 `result`（或读完 `stream`）拿到补全文本，包成补全项返回。`token` 由编辑器在用户继续输入时取消——自动级联到 main 端中止 HTTP。
4. **本基建零改动**。多 provider 优先级（Copilot vs 本地）由编辑器侧的 provider 注册表处理（VSCode `yieldsToGroupIds` 模式），与 AI 服务层正交。

### 场景 B：Git 提交消息生成
1. 一个 Action2（消费方）：收集 diff → 构造 `AiMessage[]`（system 提示 + user diff）→ `sendRequest(...)`。
2. 边流式边写入 commit 输入框（消费 `stream`），或等 `result` 一次性填入。
3. **本基建零改动**。

> 两个场景都只依赖 `IAiModelService` 门面，验证了"消费方解耦"目标达成。

---

## 12. 与 VSCode 的差异与取舍

| 维度 | VSCode | 本方案 | 理由 |
|---|---|---|---|
| provider 来源 | extension 贡献 + activation event 懒激活 | 应用内置 `registerProvider` | 无扩展宿主，省去激活层 |
| 跨进程流 | extHost↔main，AsyncIterableSource 重组 | renderer↔main，同法重组 | 问题同构，照搬 |
| 认证 | 伪 AuthenticationProvider + 跨扩展授权列表 | 单一 `ISecretStorageService` | 无多扩展共享密钥的需求 |
| 模型配置 | 独立 `chatLanguageModels.json` + group（多实例如多 Ollama） | `ConfigurationRegistry` settings | 复用现有配置体系；多实例 group 本期不做，结构预留 |
| tool calling / agent | 完整 `ILanguageModelToolsService` | 元数据预留 `toolCalling`，实现延后 | 非本期目标 |
| 用量统计 | `ILanguageModelStatsService` | `usage` chunk 透传，聚合延后 | 先把数据透出，聚合按需做 |

**刻意精简**：不照搬 extension point、跨扩展授权、tool service、MRU/pinned 模型——这些是 VSCode 多扩展生态的产物，对一个内置 provider 的桌面 app 是过度设计。保留的是**门面/provider 分离、能力元数据、流式+result、selector、配置三层合并**这五个真正提升可维护可扩展性的内核。

---

## 13. 落地步骤（建议顺序）

> 每步后 `pnpm check`；涉及交互链路的最后跑 `pnpm e2e`。platform 改动后注意 `index.ts` re-export 与 dist 重建。

1. **platform 契约层**：新建 `packages/platform/src/ai/{aiModelTypes,aiModelService,aiModelProvider,aiModelRegistry,aiStream}.ts` + `secret/secretStorageService.ts`；补 `AsyncIterableSource`（若缺）；全部 re-export 进 `index.ts`；写注册表/重组的纯 node 单测。
2. **密钥服务**：`apps/editor/src/main/services/ai/secretStorageMainService.ts`（safeStorage + IStorageService）；注册为 root 单例。
3. **main 门面 + 一个 provider**：`AiModelMainService` + `OpenAiProvider`（或先做 Ollama，无需真 key 便于本地验证）；注册 provider；走 `registerSingleton`。
4. **IPC 接线**：`channelNames.ts` 加 `AiModel`；`shared/ipc/aiModelService.ts` 定义 DTO；`registerMainServices.ts` 加 `ProxyChannel.fromService`；接入 `ApplicationServices`/`getOrCreateServices`（套路 C）。
5. **renderer 门面**：`AiModelClientService`（chunk 重组）；`main.tsx` 里 `services.set(IAiModelService, new AiModelClientService(ProxyChannel.toService(...)))`。
6. **配置 schema**：一个 `BlockStartup` Contribution 注册 `ai.*` 配置项。
7. **冒烟验证**：加一个临时 Developer 命令（Action2）调 `sendRequest` 打印流，确认端到端（含取消）后删除——不引入业务。

---

## 14. 关键文件引用（VSCode，便于实现时回查）

- 门面接口与实现：`src/vs/workbench/contrib/chat/common/languageModels.ts:358`（接口）、`:610`（实现）、`:1021`（注册）、`:1046`（sendChatRequest）、`:1057`（配置合并）、`:996`（selectLanguageModels）
- 元数据/能力：`languageModels.ts:190`、`:216`（capabilities）、`:236`（suitableForAgentMode）
- 流式响应结构与消费：`languageModels.ts:253`、`:259`（getTextResponseFromStream）
- 跨进程 chunk 重组 + 批处理：`src/vs/workbench/api/common/extHostLanguageModels.ts:44`、`:276`
- 错误双路：`src/vs/workbench/api/browser/mainThreadLanguageModels.ts:119`
- Inline Completions provider 抽象（消费方参考）：`src/vs/editor/common/languages.ts:948`、`src/vs/editor/contrib/inlineCompletions/browser/model/provideInlineCompletions.ts:55`（yieldsTo 优先级图）

## 15. 本项目对齐点引用

- IPC 能力：`packages/platform/src/ipc/ipc.ts:32`、`proxyChannel.ts:6`
- 流式范式先例：`apps/editor/src/main/services/acpHost/acpHostMainService.ts:159`
- 跨进程服务套路：`apps/editor/CLAUDE.md` 套路 C；`apps/editor/src/main/ipc/registerMainServices.ts`
- 配置体系：`packages/platform/src/configuration/`；现有 AI 相关配置先例 `apps/editor/src/renderer/contributions/AgentsContributions.ts:44`（含"勿明文存 key"警告，正是本方案要解决的）
- 取消：`packages/platform/src/base/cancellation.ts`
```
