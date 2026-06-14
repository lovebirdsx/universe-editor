# AI 辅助插件方案（首发：生成提交信息）

## 1. 目标与范围

基于已落地的 AI 基建（`IAiModelService`，见 `docs/plan/ai-service-foundation-plan.md`），新增一个**真·进程隔离的内置插件** `extensions/ai`（运行在 trusted host），聚焦"AI 辅助编辑器功能"。

首发功能：**根据本地修改生成提交信息**。

用户已确认的四项决策：

| 维度 | 决策 |
|---|---|
| 插件形态 | 真·内置插件（进程隔离，同 git/typescript） |
| diff 范围 | 已暂存优先，否则全部工作区改动（VSCode commit 语义） |
| 结果呈现 | 填入 SCM 提交输入框，用户可编辑（流式逐字填入更佳） |
| 入口按钮 | 提交输入框旁的内联按钮 |

**不在范围**：模型供应商扩展、其它 AI 功能（补全/解释等留待后续，但桥接层一次到位）。

## 2. 关键架构发现（约束计划成立的前提）

1. **AI 基建只活在 renderer DI**：`IAiModelService` 未暴露给扩展宿主。要做进程隔离插件，必须先补一段"通往 trusted host"的 RPC 桥（新增 `ai` 命名空间），这是本方案的主要基建工作量。

2. **`IAiModelService` 真实签名**（`packages/platform/src/ai/aiModelService.ts`）：
   - `sendRequest(messages, options, token): AiResponse` —— **同步返回**，`AiResponse = { stream: AsyncIterable<AiResponseChunk>, result: Promise<AiRequestResult> }`
   - chunk 形如 `{ type: 'text', value: string }`（判别联合）
   - 现成工具 `getTextResponse(response): Promise<string>` 把流聚合成字符串（容忍出文后报错）
   - 还有 `getModels` / `selectModels` / `computeTokenLength` / `onDidChangeModels`
   - **注意**：platform 接口上没有 `setConfig`/`onDidEmitChunk`（那是 renderer 客户端实现细节，不进桥）

3. **`ProxyChannel` 不能直传 `AiResponse`**（含 AsyncIterable）。需要一个 `MainThreadAi` 网关，把流"拆"成按 `requestId` 标记的 chunk 事件——这正是 Phase 1 在 renderer↔main 之间用过的 reassembler 模式，host↔renderer 复用同一套。

4. **SCM inputBox 属于创建它的 git 扩展**：`ai` 插件不创建 source control，**拿不到** git 的 `inputBox` 对象。因此 **读 diff 与写回提交框都经 git 扩展命令中转**，`ai` 插件只需 `ai` + `commands` 两种能力，无需 `scm` 命名空间。这显著收窄桥接面，也让职责更清晰。

5. **内置插件零注册**：`extensions/*` 已在 pnpm workspace；extension-host 启动时**目录扫描**发现，`pnpm ext:build` / `runtime:stage` 用 `--filter="./extensions/*"` 自动包含。新建插件无需改任何注册代码。

6. **输入框旁无现成承载位**：`ScmView` 的 `commitBar`（提交按钮所在的弹性容器）目前是硬编码，`scm/inputBox` 菜单贡献点**不存在**，需新增 `MenuId.ScmInputBox` 并在 `commitBar` 渲染其 inline action。

## 3. 数据流（点一下按钮发生什么）

```
[用户点输入框旁按钮]
  → ScmView 执行 executeCommand('ai.generateCommitMessage', { rootUri })
  → trusted host 激活 extensions/ai，运行命令处理器：
      1. diff = await commands.executeCommand('git.getCommitDiff', rootUri)   // staged 优先否则 working
      2. 空 diff → window 提示「没有可用于生成的改动」，结束
      3. messages = buildPrompt(diff)（systemPrompt + 截断后的 diff）
      4. for await (chunk of ai.sendRequest(messages, opts, token)):
           acc += chunk.value
           （节流）await commands.executeCommand('git.setCommitMessage', rootUri, acc)
  → git 扩展 repository.inputBox.value = acc
  → $setInputBoxValue → renderer ScmService observable → ScmView textarea 实时更新
```

写回链路（`inputBox.value` setter → `$setInputBoxValue` → `ScmService` observable → React 重渲）已验证现成可用。

## 4. 分段改动清单

### A 段：把 AI 能力桥到 trusted host（基建）

| 文件 | 改动 |
|---|---|
| `packages/extensions-common/src/rpc.ts` | 加通道名 `mainThreadAi`、`extHostAi`；定义 `IMainThreadAi`（方法 `$startRequest(requestId, messages, options)` / `$cancelRequest(requestId)` / `getModels()` / `selectModels(selector)` / `computeTokenLength(modelId, text)`；事件 `onDidStreamChunk: Event<{requestId, chunk}>` / `onDidStreamEnd: Event<{requestId, error?}>`）。`extHostAi` 暂可不需要（用事件回传，取消走 `$cancelRequest`） |
| `apps/editor/src/renderer/services/extensions/MainThreadAi.ts` **(新建)** | 持 `IAiModelService`；`$startRequest` 内 `for await (chunk of aiModel.sendRequest(...).stream)` 按 `requestId` fire `onDidStreamChunk`，结束 fire `onDidStreamEnd`；维护 `requestId → CancellationTokenSource`，`$cancelRequest` 取消；查询方法直接转发 |
| `apps/editor/src/renderer/services/extensions/HostConnection.ts` | `HostConnectionDeps` 加 `aiModel?: IAiModelService`；trusted 分支注册 `mainThreadAi` 通道（仿 `editorService` 块） |
| `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` | 注入 `IAiModelService`；trusted deps 加 `aiModel` |
| `packages/extension-host/src/hostAi.ts` **(新建)** | host 侧：订阅 `onDidStreamChunk/End`，按 `requestId` 重组为 `AiResponse`（reassembler，镜像 Phase 1 renderer 端）；暴露给 apiFactory |
| `packages/extension-host/src/apiFactory.ts` + `extensionService.ts` | bridge 接口加 `ai` 方法；trusted 才注入 `IMainThreadAi`，restricted 缺失时调用抛错 |
| `packages/extension-api/src/index.ts` | 新增 `ai` 命名空间：`sendRequest(messages, options, token): AiResponse`、`getModels`、`selectModels`、`computeTokenLength`；导出 `AiMessage/AiRequestOptions/AiResponse/AiResponseChunk/AiModelMetadata/AiModelSelector/AiMessageRole` 类型 |

**信任边界**：`ai` 仅在 `kind === 'trusted'` 注入；restricted host 调用 `ai.*` 抛错（同 scm/languages）。

**流式 vs 聚合**：推荐**节流流式**——复用 Phase 1 已验证的 requestId+chunk 模式，体验上消息逐字出现。为控制跨进程往返（每 chunk 经 host→renderer 中转 + 写回再一跳），写回 `git.setCommitMessage` 按时间/字数节流 flush（如每 ~80ms 或每累积 N 字一次，并在结束时 flush 终值）。若希望进一步简化首版，可退化为 `getTextResponse` 一次性聚合后单次写入（改动更小，但无逐字效果）——计划默认走节流流式。

### B 段：git 扩展暴露 diff 与写回命令

| 文件 | 改动 |
|---|---|
| `extensions/git/src/repository.ts` | 加方法 `getCommitDiff()`：先 `git diff --cached`，输出为空再 `git diff`（已暂存优先，否则工作区 tracked 改动），返回 unified diff 文本；`setCommitMessage(message)` 复用现有 `inputBox` setter |
| `extensions/git/src/extension.ts` | 注册命令 `git.getCommitDiff(rootUri)` 与 `git.setCommitMessage(rootUri, message)`（按 rootUri 路由到对应 repository，多 submodule 场景沿用现有最长前缀匹配）；二者标记为非面板命令（不进命令面板/菜单，仅供程序调用） |
| `extensions/git/package.json` | `contributes.commands` 登记上述两命令（`enablement`/`when` 控制不在 UI 暴露） |

diff 截断：若 diff 超过模型上下文预算，用 `ai.computeTokenLength` 或字符上限截断，并在尾部标注"（diff 已截断）"。截断逻辑放 `ai` 插件侧（B 段只返回完整 diff）。

### C 段：extensions/ai 插件脚手架

照抄 `extensions/git` 结构（workspace 自动发现，无需登记）：

```
extensions/ai/
├─ package.json          // name=@universe-editor/ai；engines.universe；
│                        // activationEvents: ["onCommand:ai.generateCommitMessage"]；
│                        // contributes.commands(ai.generateCommitMessage) + menus(scm/inputBox) + configuration
├─ esbuild.config.mjs    // 照抄 git：src/extension.ts → dist/extension.js，platform:node/esm/node20
├─ tsconfig.json         // extends @universe-editor/config-ts/node
├─ src/
│  ├─ extension.ts       // activate：registerCommand('ai.generateCommitMessage', handler)
│  ├─ commitMessage.ts   // 编排：取 diff → buildPrompt → ai.sendRequest 节流写回；含截断与错误处理
│  └─ __tests__/commitMessage.test.ts  // mock ai + commands，验证编排/截断/空 diff/取消
└─ devDependencies: @universe-editor/extension-api(workspace:*), config-ts, esbuild, typescript, vitest (catalog:)
```

`configuration` 贡献（可选）：`ai.commitMessage.systemPrompt`（自定义提示词）、`ai.commitMessage.model`（指定模型，留空用默认）。**不含任何密钥**（密钥红线：renderer/host 都不碰明文，请求在 main 用 key）。

并发与取消：同一 rootUri 重复触发时，先取消上一个进行中的请求（保存 `token`），避免两路写回打架。

### D 段：SCM 输入框旁内联按钮

| 文件 | 改动 |
|---|---|
| `packages/platform/src/command/menuRegistry.ts` | `MenuId` 加 `ScmInputBox = 'scm/inputBox'`（platform 改动需在 `index.ts` re-export 检查，menuRegistry 已导出则无需） |
| `apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts` | `MENU_ID_BY_KEY` 加 `'scm/inputBox': MenuId.ScmInputBox` |
| `apps/editor/src/renderer/workbench/scm/ScmView.tsx` | 在 `commitBar` 内（提交按钮之后）用 `menuActions(MenuId.ScmInputBox, { scmProvider: model.id }, 'inline')` 取贡献动作，渲染为 inline 图标按钮；点击 `executeCommand(a.command, { rootUri: model.rootUri })`、`stopPropagation` |
| `ScmView.module.css` | `commitBar` 增补 inline action 区样式（`margin-left:auto` 右对齐 + gap） |

按钮图标用 `sparkles`（codicon），命令 `ai.generateCommitMessage` 由 `extensions/ai` 贡献到 `scm/inputBox`。

## 5. 边界与约束

- **密钥红线不变**：host 只发 `messages`，API key 读取与使用始终在 main；renderer/host/插件均不接触明文。
- **信任隔离**：`ai` 命名空间仅 trusted 注入；外部插件无法调用。
- **diff 为空**：友好提示，不调用模型。
- **无可用模型**：`getModels()` 为空时提示用户去设置配 baseUrl/model。
- **大 diff 截断**：按模型预算截断，尾部标注。
- **取消**：重复触发取消旧请求；插件失活时 dispose token。

## 6. 验证

- 每段后 `pnpm check`（仅看错误）；A 段平台/host 改动注意 `packages/platform/src/index.ts` re-export。
- 新增单测：
  - `MainThreadAi`：流 pump → chunk/end 事件、取消、查询转发（renderer node 环境）
  - `hostAi` reassembler：事件 → AsyncIterable 还原、错误传播
  - `extensions/ai` `commitMessage`：mock `ai`+`commands`，覆盖空 diff / 截断 / 流式写回节流 / 取消
- D 段属交互链，跑 `pnpm e2e`（仅看错误）；可加 `@p1` 探针：点按钮后断言 SCM 输入框值非空。

## 7. 建议提交粒度

1. **S1**：A 段 AI 桥 + 单测（`feat: 扩展宿主接入 AI 基建（ai 命名空间）`）
2. **S2**：B 段 git diff/写回命令（`feat(git): 暴露 commit diff 与写回命令`）
3. **S3**：C 段 extensions/ai 脚手架 + 生成逻辑 + 单测（`feat(ai): 新增 AI 辅助插件与提交信息生成`）
4. **S4**：D 段 SCM 内联按钮 + e2e（`feat(scm): 提交框旁内联按钮承载 scm/inputBox 贡献`）

## 8. 落地状态（全部完成）

S1–S4 已全部实现并验证：`pnpm check` 36/36 通过，`smoke.aiCommitMessage.spec.ts`（@p1）通过。

- **S1**：`packages/extensions-common/aiWire.ts`（`IMainThreadAi` 线契约）；renderer `MainThreadAi.ts`（包 `IAiModelService`，按 `requestId` 把流拆成 chunk 事件）经 `HostConnection` 仅在 trusted 注册；`extension-host/hostAi.ts`（复用 `AiResponseReassembler` 还原流）+ `extensionService` 的 `ai` getter（restricted 抛错）；`extension-api` 自带 AI 类型 + `ai` 命名空间。
- **S2**：`extensions/git` 新增 `repository.getCommitDiff()`（`git diff --cached` 优先否则 `git diff`）与命令 `git.getCommitDiff(arg)` / `git.setCommitMessage(arg, message)`（按 rootUri 路由，写回复用 `commitMessage` setter）。
- **S3**：`extensions/ai` 插件（零注册，目录扫描发现）。`commitMessage.ts`：取 diff → 截断 → `ai.sendRequest` 节流（60ms）逐字写回提交框；空 diff/无模型/空结果/异常均有处理。配置 `ai.commitMessage.modelId` / `maxDiffChars`（**不含任何密钥**）。
- **S4**：`MenuId.ScmInputBox = 'scm/inputBox'` + 翻译表项；`ScmView` 在提交框右下角渲染 `scm/inputBox` 的 inline action（`sparkle` 图标），点击带 `{rootUri, sourceControlId}` 执行命令。

