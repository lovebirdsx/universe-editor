# 计划 02 · ACP/AI 业务核心治理

> 配套总览：[README.md](./README.md)
> 范围：`renderer/services/acp/`、`renderer/workbench/agents/`、`renderer/actions/agentActions.ts`、`main/services/{acpHost,acpTerminal,ai}/`
> 主轴：**上帝文件拆分** + **连接生命周期状态机显式化** + **流式性能（批处理竞态 / markdown 重解析）**。

> ⚠️ 这是业务热区，文件巨大且改动风险高。本计划的拆分项**强烈建议随相关功能改动渐进推进**，测试先行、小步提交，不要一次性大重构。

---

## 现状肯定（精妙的设计，勿轻动）

- **16ms 批处理框架**（`acpSession.ts` 的 `_batchedTx`）：把高频 chunk 压缩成一次 React 提交，避免逐 token 重渲，思路正确（但有竞态，见 P1）。
- **Timeline 虚拟化 + 锚点恢复**（`ChatBody.tsx`）：streaming 期间坐标漂移的处理很精细。
- **双桶 workspace-aware 持久化**（acpSessionHistory / agentDefaults）：避免跨工作区污染。
- **异步会话创建**（memory 记录的双 id + queued prompts）：交互上"立即可输入"的体验是对的，问题只在实现的可读性与边界（见 P0）。

---

## P0 · 连接生命周期靠分散布尔位维护，缺显式状态机

### 问题
`AcpSession` 的连接/会话生命周期由一组分散的布尔与 Promise 字段拼凑推导，没有单一状态机。状态转换的正确性依赖"每个 flag 都被同步到"，脆弱且难测。

### 证据
`renderer/services/acp/acpSession.ts` 私有字段（约 420-503 行区间）：
```ts
private _sawError: boolean
private _inFlight: Set<AbortController>      // 用 size 推导 status
private _connectionSettled: boolean
private _resolveConnected: () => void
private _whenConnected: Promise<void>
private _titleGenerated: boolean
private _queuedPrompts: Array<{ ... }>       // 连接前缓冲的 prompt
```
- `attachConnection()` 用 `_connectionSettled` 做一次性 guard；
- 连接失败路径**不 flush `_queuedPrompts`**，调用者的 promise 可能永不 settle；
- `_recomputeStatus()` 依赖 `_inFlight.size` + `_sawError` + observable 三者一致。

### 影响
- 加一个新状态（如"暂停"）要改 ≥10 处。
- 并发 resume 同一 session（两个 tab）时，只有第一个 promise 真正 attach，第二个的 settle 语义不清。
- 连接超时/失败时排队的 prompt 处理不明确，是 resume 卡住类问题的温床（与 memory「异步握手」「queued prompts」相关）。

### 落地步骤
1. 抽 `AcpSessionConnection` 状态机：`'connecting' | 'connected' | 'failed' | 'closed'`，集中管理 `queuedPrompts` 与 `whenConnected`。
2. 显式定义转换的副作用：
   - `connecting → connected`：一次性 flush 排队 prompt（不可重入）；
   - `connecting → failed`：**reject 所有排队 prompt（明确错误）** + 广播错误 + 清空队列。
3. `_inFlight` / `_sawError` 等派生状态从状态机读，不再各处独立维护。
4. 单测覆盖：连接前排队→连接后 flush、连接失败→排队 prompt reject、并发 resume 去重、取消中 attach。

### 验证
`pnpm check` + `smoke.agents*` e2e。**先写复现连接失败/并发 resume 的测试**再改。

---

## P1 · acpSession.ts 是上帝文件（1816 行）

### 问题
单文件混了：类型定义、连接状态机、`applyUpdate` 大 switch（~180 行）、流式缓冲（appendChunk/appendMessage）、Codex 成本估算、16ms 批处理、视图模型。

### 证据
`renderer/services/acp/acpSession.ts` 1816 行；职责分布见上。`applyUpdate` switch 约 975-1150 行，成本计算约 1210-1259 行，批处理约 1486-1507 行。

### 影响
排查一个权限/成本 bug 要通读全文件；加新 update 类型找不到落点；单测必须 mock 整个类。

### 落地步骤（渐进、保持 `AcpSession` 对外接口与 testid 不变）
```
acp/session/
  acpSessionModel.ts          # 类型 + 最小 interface
  acpSessionUpdateHandler.ts  # applyUpdate 的大 switch（纯函数化，可单测）
  acpSessionStreaming.ts      # appendChunk / appendMessage / closePriorStreaming
  acpSessionCost.ts           # Codex 成本估算（vendor 特有逻辑隔离）
  AcpSession.ts               # 主类，编排上述模块 + 状态机（P0）
```
- 先抽**纯函数部分**（updateHandler、cost、streaming 的无状态片段），风险最低、立刻可单测。
- 状态机（P0）落地后，主类自然变薄。

### 验证
每抽一块跑 `pnpm check` + 相关单测；最后 `smoke.agents*`。

---

## P1 · acpSessionService 依赖过载（14 个 @inject，1096 行）

### 问题
`AcpSessionService` 构造函数注入 14 个服务，同时充当 facade / 通知汇聚 / 协调器容器；依赖初始化顺序隐含在构造函数语句顺序里（改顺序就崩）。

### 证据
`renderer/services/acp/acpSessionService.ts:256-301`：14 个 `@I...` 参数；构造体内 `this._client.setNotificationSink(...)` 等有隐式先后依赖。

### 影响
单测要 mock 14 个服务；方法各自用哪些依赖不清晰；协调逻辑（resume/restore/hydrate）与通知/配置混在一起。

### 落地步骤
- 按关注点拆出：
  - `AcpSessionRegistry`：纯 `Map<sessionId, AcpSession>` CRUD；
  - `AcpSessionCoordinator`：resume/restore/hydrate 仪式（部分已存在，把权限/配置通知收进来）；
  - `AcpSessionService`：薄 facade，依赖上述两者 + 少量横切服务。
- 把构造体内的隐式初始化顺序改为显式的 `initialize()` 方法，注释依赖前置条件。

### 验证
`pnpm check` + acp 单测。

---

## P1 · 流式消息每 chunk 重建对象 → markdown 全文重解析

### 问题
每个流式 chunk 到达都 spread 出**新的 message 对象**（含重算 `text`），下游 `parseMarkdown`（纯函数、无缓存）随之对整条消息全文重解析。长消息流式时复杂度退化为 O(消息长度²)。

### 证据
- `renderer/services/acp/acpSession.ts:1268-1271` 一带：
  ```ts
  next = { id: last.id, role, blocks, text: blocksToText(blocks), streaming: true }
  this._messages = [...this._messages.slice(0, -1), next]   // 每 chunk 新对象
  ```
- `renderer/services/acp/markdownRenderer.ts:87+` `parseMarkdown` 是纯函数，无 memo；消息对象每次新建 → 消费方 memo 失效 → 每 chunk 重新 parse 全文。

### 影响
千字级消息流式输出时，CPU 随长度平方增长，表现为后半段流式明显变卡。

### 落地步骤（择一或组合）
1. **增量解析**：流式期间只对**新增尾部**解析，已稳定的前缀块缓存复用（markdown 块级可增量）。
2. **解析缓存**：给 `parseMarkdown` 加一个 `Map<string, MdNode[]>`（带容量上限/LRU），相同输入直接命中——简单但治标。
3. **text 派生下沉**：消息对象去掉 `text` 字段，消费方 `useMemo(() => blocksToText(blocks), [blocks])`，减少无谓重算。

优先 1 + 3（治本）；2 作为低成本过渡。

### 验证
单测：长消息流式时 parse 调用次数不随 chunk 数线性放大；`smoke.agents*` 不回归。

---

## P1 · 16ms 批处理与 `undefined` tx 旁路的竞态

### 问题
`_batchedTx()` 把 16ms 内的 observable 更新合批，但部分 `observable.set(value, undefined)` 调用**绕过批处理立即通知**，与批处理路径混用，可能让 ChatBody 虚拟化看到"突然多一条"的非原子变化，导致估高漂移。

### 证据
`acpSession.ts`：`_appendChunk` 走 `this.timeline.set(this._timeline, this._batchedTx())`，而部分 append 路径用 `this.timeline.set(this._timeline, undefined)`（立即触发）。两条路径并存。

### 影响
高频消息时偶发虚拟化抖动/滚动位置跳动（非必现，难复现）。

### 落地步骤
- 统一约定：所有 `timeline.set` 要么走 `_batchedTx()`，要么显式标注"必须立即"的少数点，**禁止隐式混用**。
- 加开发期断言：`set` 时若存在 pending tx 又传了 `undefined`，抛错提示。
- 评估是否可整体迁到 React 18 batching（`useSyncExternalStore` 缓冲），消除手写 setTimeout——但这是较大改动，**先用断言收口竞态**，迁移列为后续。

### 验证
单测：混合 batched / immediate set 时 timeline.length 单调一致；高频 producer 下虚拟化 estimate 不漂移。

---

## P2 · agentActions.ts 单文件 12+ Action（1213 行）

### 问题
所有 agent 命令（NewSession / CancelTurn / OpenInEditor / SelectAgent / SetModel / OpenSettings…）挤在一个文件，共同逻辑（如 `resolveNavWidget`）难复用。

### 证据
`renderer/actions/agentActions.ts` 1213 行，多个 Action2 类 + 重复的 widget 解析。

### 影响
导航困难；与项目"actions 按业务域聚合"约定有张力（agent 域已大到该再分）。

### 落地步骤
按子域拆分（仍在 `actions/`，保持命令 id 不变）：`agentSessionActions.ts` / `agentModelActions.ts` / `agentSettingsActions.ts` / `_agentShared.ts`（共享 helper + category 常量）。在 `actions/index.ts` 对应分组注册。

### 验证
`pnpm check`；命令面板/快捷键 e2e 不回归。

---

## P2 · 错误类分散

`AcpForeignWorktreeError`（acpSessionService）与 `AcpAbortError`（acpSession）定义在不同文件。统一到 `acp/acpErrors.ts`，便于消费方集中 catch 判型。

---

## 任务依赖与建议顺序

```
P1 流式 markdown 重解析（独立、用户可感、ROI 高）── 先做
P1 16ms 批处理竞态（加断言收口，独立）        ── 先做
P0 连接状态机 ──► P1 acpSession 拆分（状态机落地后主类变薄）
                └─► P1 acpSessionService 拆分
P2 agentActions 拆分 / 错误类合并（机会型）
```

建议优先做两个 P1 性能项（独立、用户可感知、不依赖大重构），再在后续迭代中随 ACP 功能改动逐步推进状态机与拆分。
