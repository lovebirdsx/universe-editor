# 05 · ACP/AI 子系统

> 事实/推测已分开标注。上一轮 `02-acp-ai-subsystem.md` 的 P0/P1 落地情况见 [01-roadmap-audit.md](./01-roadmap-audit.md)。

## ① 现状速写

### 链路（文字版）

```
renderer (协议层 + UI 全在 renderer)
  PromptInput/ChatBody (workbench/agents, ~10.4k 行)
    → AcpSessionService (facade, 1250 行, 16 个 @inject)
        ├─ AcpSessionRegistry            会话成员/active 指针的原子 CRUD（153 行）
        ├─ AcpSessionRestoreCoordinator  启动/换工作区恢复 + session/list hydrate（432 行）
        └─ AcpSession (view-model, 1640 行)
             ├─ AcpSessionConnection     连接生命周期状态机 connecting→connected/failed/closed
             ├─ applyUpdate 大 switch（10 case）→ 16ms _batchedTx 合批 → observables
             └─ acpSessionUpdateMeta     vendor 私有 _meta 解析集中点（230 行）
    → AcpClientService (847 行)  spawn 编排 + SDK ClientSideConnection 装配
        + fs/terminal/permission 网关 + claude/codex 二进制注入
    → sdkHostStream  string ⇄ Uint8Array 适配 → @agentclientprotocol/sdk ndJsonStream

main (只搬字节 + 资源供给)
  acpHostMainService (285) / acpTerminalMainService (281)
  claudeBinary (603) / codexBinary (553) / claudeConfig (184) / codexConfig (440)

vendor 子进程（Electron-as-node 启动，不依赖系统 node）
  claude-agent-acp fork（src 8656 行，acp-agent.ts 单文件 6579）
  codex-acp fork（CodexAcpServer 1889 + CodexAcpClient 1127 …）→ 再 spawn 原生 codex
```

### 核心文件规模

| 文件 | 行数 | 对比上一轮 |
|---|---|---|
| `acpSession.ts` | 1640 | 旧 1816，已抽出 model(498)/updateMeta(230)/content(137)/connection(145)/cost(47) |
| `acpSessionService.ts` | 1250 | 旧 1096 行/14 依赖 → 现 **16 个 @inject**（:276），不降反升 |
| `acpClientService.ts` | 847 | — |
| `markdownRenderer.ts` | 795 | 新增 `markdownIncremental.ts`(198) 增量解析 |
| `acpSessionHistory.ts` | 761 | — |
| `ChatBody.tsx` / `PromptInput.tsx` | 1623 / 1366 | UI 侧双巨石 |
| `agentActions.ts` | 13（转发壳） | 旧 1213 行 → 按域拆成 8 个文件 |
| renderer acp services 合计 | ~14.1k（62 文件） | main 侧 agent 相关合计仅 ~2.6k，明显薄 |

## ② 做得好的点

1. **能力探测优先，agentId 硬编码极少且集中**。图片/embeddedContext/loadSession/fork/list/mcp 全走 `initialize` capabilities 门控（`acpSession.ts:371-374`、`acpSessionService.ts:688`、`acpSessionRestoreCoordinator.ts:344-345`）。全仓 `=== 'claude-code'|'codex'` 产品代码分支仅 **~8 处**，大半在边缘（二进制启动注入、nodeEntry 解析），UI 层零散布。
2. **连接生命周期状态机**（`acpSessionConnection.ts`）：相位单向吸收、queued prompt "恰好派发一次或明确 reject"、whenSettled 永不悬挂——头注把旧 flag-soup 未保证的不变量逐条列出。
3. **流式性能三件套齐活**：16ms `_batchedTx` 合批 + `_setImmediate` dev 断言防撕裂 + `markdownIncremental.ts` 按安全块边界封存前缀（摊还 O(n)，输出与全量解析逐字节一致、parse 可注入以便测试计数）。
4. **vendor 私有协议解析集中**：`acpSessionUpdateMeta.ts` 把所有 `_meta` 形状探测收进一个可审计的地方；ext-method 常量在 `acpSessionModel.ts:190-221` 有完整契约注释。
5. **codex fork 的维护文档是范本**：`vendor/codex-acp/CLAUDE.md` 明文"diff 最小是生命线"、逐条列出本地改动供 rebase 核对。
6. **测试厚实且分层清晰**：acp+agents 单测 75 文件 / 2.35 万行；协议级测试走 `inMemoryAcpPair`（真 ClientSideConnection + 桩 agent）；e2e 用 4 个 `.cjs` 假 agent，不依赖真二进制，确定性好。
7. **main 侧极薄**（acpHost 285 行），协议全在 renderer——调试、单测都不跨进程。

## ③ 问题清单

| # | 级别 | 问题 | 证据 |
|---|---|---|---|
| 1 | **P1** | **跨仓 ext 契约靠字符串 + "keep both in sync" 注释维系，无共享 schema、无自动化契约测试**。5 个自定义 ext-method（ask_user_question / set_session_title / rewind_session / _universe/compaction / _claude/sdkMessage）+ 多个 `_meta` 印章在 editor 与两个 fork 间各写一份；editor e2e 全用假 agent，**editor↔真 fork 的集成没有任何自动化验证** | `acpSessionModel.ts:190,199,210,221`（均注释 "keep both in sync"）、`acpSessionService.ts:234`、e2e specs 均 `installAcpEchoAgent` |
| 2 | **P1** | **claude fork 上游合并风险高且无维护文档**。codex fork 有 CLAUDE.md 维护指南；claude fork 没有任何等价文档，19 个本地提交中 +1343 行集中改在单个 6579 行的 `acp-agent.ts`（≈20% 被动过），上游发版频繁。两个 fork 的 clone 均未配 `upstream` remote | `vendor/claude-agent-acp`：fork 点 3500ef7 (v0.58.1) 后 19 commits，src +3546/-448；`vendor/codex-acp`：v1.1.2 后 12 commits，改动分散 7 个文件；`git remote -v` 两边只有 origin |
| 3 | P2 | **AcpSessionService 依赖继续膨胀**：14→**16 个 @inject**、1250 行；registry/coordinator 已抽出但 facade 仍兼任通知汇聚、auth 冷却、MCP 告警、title 编排 | `acpSessionService.ts:276-293` |
| 4 | P2 | **rewind 支持用 agentId 白名单硬编码而非能力探测**，用户自定义 agent 即使实现了 ext-method 也不亮 rewind 入口；codex "文件回滚在客户端做" 的语义差异用 `filesAreClientSide = this.agentId === 'codex'` 编码在核心里 | `acpSession.ts:270`（注释自认 "Static"）、`acpSession.ts:716` |
| 5 | P2 | **codex 成本估算是 vendor 逻辑但仍嵌在 AcpSession 核心**（acpSessionCost.ts 仅 47 行，主干分支留在 applyUpdate/`_ingestPromptResponse`）；`shared/ai/codexPricing.ts` 价格表手工硬编码，调价后静默失真 | `acpSession.ts:1163,1269`、`codexPricing.ts:8-12` |
| 6 | P2 | **agent e2e 全部 @p1，不阻塞 CI**——旗舰功能（16/82 个 spec）没有任何 @p0 阻塞门，叠加 #1（无真 agent 集成测试），聊天主链路回归只产报告不拦合并 | `smoke.agents*.spec.ts` 等 16 个 spec 标签全为 `@p1` |
| 7 | P3 | `available_commands_update` 用 `set(..., undefined)` 立即通知，绕过 16ms 批且未走 `_setImmediate` 守卫，与文件内自立约定不一致（实际撕裂风险低） | `acpSession.ts:1129` |
| 8 | P3 | 持久化小服务数量持续增生（history / agentDefaults / configOptionsCache / bookmarks / promptHistory / promptDraftCache / questionDraftCache / chatViewStateCache / filterService…，10+ 个）；有 `persistedStateBase` 统一框架但认知面在变宽；history entry 的 `id` 与 `sessionIdOnAgent` 恒等重复字段属自认的 schema 债 | acp 目录清单、`acpSessionHistory.ts:46-56` |
| 9 | P3 | UI 双巨石 ChatBody 1623 / PromptInput 1366——滚动锚点逻辑精细（有 6 个专门滚动回归 e2e 兜着），但新人改动成本高 | 文件行数 |

**【推测】**：#2 中 claude fork 的 rewind/fork/compact/标题持久化等功能上游未来大概率会自己做（上游 0.58 已在做 session title push），届时 fork 的 acp-agent.ts 集中改动与上游实现正面冲突，rebase 成本可能一次性爆发。

## ④ 方向性建议

### 双 agent 抽象（方向正确，补最后一公里）

- **把 ext-method 也纳入能力通告**：让两个 fork 在 `initialize` 响应 `_meta` 里通告 `universe-editor/*` ext 能力集（含 rewind 的 `filesRolledBackByAgent: boolean` 语义标志），删掉 `acpSession.ts:270/716` 的 id 白名单——同时解决"用户自定义 agent 无法点亮 rewind"。
- **引入 per-agent quirks 表**：`acpAgentRegistry` 描述符挂可选 strategy 对象（成本估算器、文件回滚归属），把 codex 分支和 codexPricing 收拢为"codex 描述符注入的估算器"。当前 8 处分支未失控，但"每加一个 agent 差异就多一处 if"的趋势要现在掐断。

### fork 维护策略（当前最大的结构性风险）

- 给 claude fork 补一份与 codex 同规格的 CLAUDE.md（红线 + 本地改动清单 + rebase 核对表）；两个 clone 配 `upstream` remote；"多久同步一次上游"写成明文节奏。
- 降低 claude fork 的 diff 集中度：新功能尽量落新文件（codex fork 的 PathUtils/AcpExtensions 模式），已有的 rewind/compaction 等若可行逐步搬出 acp-agent.ts。
- **补跨仓契约测试**：editor CI 加一个 spec（或 vitest 集成），用 `pnpm agent:build` 产物启动真 fork dist，跑 initialize→newSession→ext-method 握手，断言 5 个 ext-method 与 `_meta` 印章的 wire 形状。这是 #1、#6 的共同解，成本一天级。

### 复杂度收敛

- **冻结 AcpSessionService 依赖数**：title 编排、auth 冷却通知、MCP dropped 告警移入各自 owner，目标回到 ≤12 个 @inject；这是路线图里唯一逆行的指标，值得立规矩（新依赖需在 PR 里说明为何不能挂 coordinator/registry）。
- ChatBody/PromptInput 渐进拆（随功能改动抽 hook/子组件，不做一次性大重构）——滚动回归 e2e 安全网够。
- **e2e 提级**：`smoke.agents.spec.ts`（echo agent 全链路，不依赖网络与真二进制）升为 @p0，让旗舰链路至少有一道 CI 硬闸。
- AI 供应商层与 ACP 层**维持现状**：边界清晰（ACP=agent 协议，IAiModelService=裸模型调用），唯一桥点 `acpSessionTitleService.ts:60` 干净合理，无需统一。
