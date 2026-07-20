# 整体架构评审与优化方向（2026-07）

> 撰写日期：2026-07-19
> 范围：universe-editor 全仓库（packages 分层 / main 主进程与 IPC / renderer 工作台 / ACP-AI 子系统 / 扩展系统 / 工程化）
> 方法：6 路并行源码调研（其中 1 路专职审计 [2026-06-28 可维护性路线图](../maintainability-roadmap/README.md) 的落地状态）→ 整合为按优先级的方向性建议。所有问题条目均附文件:行号证据，事实与推测分开标注。
> 与上一轮的关系：上一轮定位是"结构性治理"（拆上帝文件、去手工注册链、补测试安全网）；本轮确认该轮已基本收官，重心转移到**契约固化、外部依赖策略、防回涨机制**。

---

## 0. 总体结论

**上一轮路线图在 3 周 / 408 个提交内被系统性消化：P0 完成 4/5，P1 完成 15/19（其余 4 项部分完成、无一未动），多数 P2 也已顺手做掉**（逐条核查见 [01-roadmap-audit.md](./01-roadmap-audit.md)）。ChildProcessManager、连接状态机、View 单点注册、barrel 守卫、markdown 增量解析、Workspace Trust、API 兼容承诺（COMPATIBILITY.md + 契约测试）等全部落地。

因此本轮评审的基调仍是"锦上添花"，但问题的**形态变了**。新一轮真正值得投入的三条主轴：

### 主轴一：契约漂移是当前最大的系统性风险

同一个病灶在三个不同层面独立出现——**跨边界的数据契约靠字符串 + "keep both in sync" 注释维系，没有单一事实源，也没有自动化守卫**：

1. **editor ↔ vendor fork**（最严重）：5 个自定义 ext-method + 多个 `_meta` 印章在 editor 与两个 fork 间各写一份；editor 的 e2e 全部用假 agent，**editor 与真 fork 之间没有任何自动化集成验证**，契约漂移只能靠手测发现。
2. **renderer ↔ 扩展**：`extensions-common` 的 wire DTO 被 git/perforce 扩展"结构化复制"（注释自述避免 bundling，但 `import type` 在 esbuild 下零成本，理由不成立），两头均无测试守卫。
3. **main ↔ renderer**：URI 跨 IPC 无统一 marshalling，50+ 处手写 `URI.revive`、同一 `toURI` helper 抄了 5 份，且已发生过真实 @p1 回归（realpath URI 未 revive）。

### 主轴二：vendor fork 维护策略不对称，claude fork 是最大的外部依赖风险

codex fork 有维护文档（红线 + 本地改动清单 + rebase 核对表）、改动分散在新文件；claude fork **没有任何等价文档**、19 个本地提交中 +1343 行集中改在单个 6579 行的 `acp-agent.ts`（约 20% 被动过），上游发版频繁且大概率会自己实现 rewind/compact/标题持久化等重叠功能——rebase 成本可能一次性爆发。两个 fork 的 clone 均未配 `upstream` remote。

### 主轴三：拆过的东西在回涨，需要机制而非再拆一次

- `acpSessionService`：路线图指出 14 个注入时建议拆薄，现在是 **16 个**、1250 行——唯一逆行的指标；
- `windowMainService`：725 行，比路线图时还大（测试网已就位，拆分未动）；
- `main.tsx`：845 行，`registerSingleton` 迁移半途（"incremental migration" 注释仍在）。

单纯再拆一轮解决不了趋势问题；需要的是**防回涨门槛**（依赖数上限、注册迁移收尾、把已验证干净的边界固化成 lint 规则）。

---

## 1. 优先级矩阵

### P1 —— 近期投入（有真实回归背书或风险敞口明确）

| # | 条目 | 域 | 核心动作 | 详情 |
|---|---|---|---|---|
| 1 | ACP 跨仓契约测试 | ACP/AI | 用 `pnpm agent:build` 产物启动真 fork dist，跑 initialize→newSession→ext-method 握手，断言 5 个 ext-method 与 `_meta` 印章的 wire 形状（成本约一天） | [05](./05-acp-ai.md) #1 |
| 2 | claude fork 维护文档 + upstream remote | ACP/AI | 补一份与 codex 同规格的 CLAUDE.md（红线/改动清单/rebase 核对表）；两个 clone 配 `upstream`；明文上游同步节奏；新功能落新文件降低 diff 集中度 | [05](./05-acp-ai.md) #2 |
| 3 | IPC 层系统性补强（一处改、消一类 bug） | main/IPC | ① URI 自动 marshalling（照抄 VSCode `$mid` 标记，消灭 revive bug 类）；② ChannelClient dispose 时 reject 全部 pending + 反向 lifecycle RPC 加超时（消灭退出悬挂类）；③ wire 错误带 `{name, message, code}` 结构，替换 acpHost 式 message 正则 | [03](./03-main-process-ipc.md) |
| 4 | CI 三板斧 | 工程化 | `concurrency` 取消组 + `timeout-minutes` + package-windows 降频（main push/tag/相关路径变更才跑）——当前 CI 成本的最大杠杆，几行 yaml | [06](./06-extensions-engineering.md) #1 |
| 5 | agents e2e 提级 @p0 | ACP/AI | `smoke.agents.spec.ts`（echo agent 全链路，不依赖网络与真二进制）升为 @p0——旗舰功能目前没有任何 CI 阻塞门 | [05](./05-acp-ai.md) #6 |

### P2 —— 中期方向

| # | 条目 | 域 | 核心动作 | 详情 |
|---|---|---|---|---|
| 6 | wire DTO 单一事实源 | packages | git/perforce 扩展改 `import type` 自 extensions-common（devDep 即可），删平行副本；extensions-common 拆"协议基建 vs 领域契约"两层，基建层补 semver/manifest-schema 单测（该包 2349 行零测试） | [02](./02-packages-layering.md) |
| 7 | 防回涨门槛 | ACP + main | acpSessionService 依赖数立规矩（目标 ≤12，新增依赖需说明为何不能挂 coordinator/registry）；windowMainService 按路线图启动拆分（先抽 session 持久化）；main.tsx 完成 registerSingleton 迁移收尾 | [05](./05-acp-ai.md) / [03](./03-main-process-ipc.md) / [04](./04-renderer-workbench.md) |
| 8 | 双 agent 抽象最后一公里 | ACP/AI | ext-method 纳入 initialize 能力通告（含 `filesRolledBackByAgent` 语义标志），删 rewind 的 agentId 白名单；per-agent quirks 表收拢成本估算器等 vendor 差异 | [05](./05-acp-ai.md) #4/#5 |
| 9 | 边界固化为 lint | packages | 趁现状干净（实测零违例）加 no-restricted-imports：renderer 禁 electron、main/renderer 互禁、packages 禁 import apps、platform 禁 import 其它 workspace 包 | [02](./02-packages-layering.md) |
| 10 | editor 注册收口复制 View 经验 | renderer | `registerEditorWithComponent`（componentKey 从 typeId 派生），消掉 24+21 处裸字符串对齐；viewToolbarMap/icon-map 并入 descriptor 可选字段 | [04](./04-renderer-workbench.md) #7/#8 |
| 11 | keybinding 去顺序化 | renderer | actions/index.ts 靠注册顺序控制 tie-break 是最脆的隐式契约，给 KeybindingsRegistry 显式 weight/priority 替代"后注册者赢" | [04](./04-renderer-workbench.md) #5 |
| 12 | 扩展生态门禁补齐 | 扩展系统 | ① 激活失败回传 renderer（通知 + Extensions 视图徽标）；② `engines.universe` 发布侧强制必填（闭掉 fail-open）；③ extensions-external 的 typecheck 纳入 CI | [06](./06-extensions-engineering.md) |
| 13 | 统一组件订阅范式 | renderer | 补 `useEventValue` hook 覆盖旧式 Event 服务、内部统一 markAsSingleton，消灭四种重渲染手段并存与订阅遵守参差 | [04](./04-renderer-workbench.md) #4 |

### P3 —— 机会型 / 卫生项

- ChatBody（1623 行）先抽 `useChatScroll`（滚动物理是复杂度重心，已有 6 个滚动回归 e2e 兜底）；PromptInput、acpSession 外围状态簇随功能改动渐进拆。（[04](./04-renderer-workbench.md) / [05](./05-acp-ai.md)）
- diff wrapper 家族抽 `useMonacoDiffEditor` hook，三个 wrapper 变薄壳（约省 150-200 行）。（[04](./04-renderer-workbench.md) #9）
- 测试补位按风险排序：agentSettings（3351 行仅 1 测试，恰是配置双写风险区）> PromptInput > SwarmReviewEditor。（[04](./04-renderer-workbench.md) #13）
- claudeBinary/codexBinary 两个 ~600 行文件高度平行——**第三个 agent vendor 出现时**先抽 `BinaryDownloadManager` 骨架再复制。（[03](./03-main-process-ipc.md)）
- turbo 缓存加 `--summarize` 观测 + e2e outputs 移除 test-results；startup-metrics/bench/bundle-size 三类观测产物补跨 run 对比消费闭环；启动耗时软报告择机升 hard 门禁。（[06](./06-extensions-engineering.md)）
- docs:check 扩到 docs/plan、docs/development + 锚点校验；清理 marketplace plan README 末尾的生成残片（`</content>`/`</invoke>`）。（[06](./06-extensions-engineering.md)）
- 卫生：删 packages/markdown-language-server 幽灵目录；workbench-ui 去掉 dependencies 里的 react（保留 peer + devDep）；barrel coverage guard 泛化给 workbench-ui/extensions-common 共用。（[02](./02-packages-layering.md)）
- platform/workbench 目录（2104 行）设增长边界：CLAUDE.md 写明只收"契约 + 纯模型"；逼近 base/ 体量时拆 `workbench-core` 包。（[02](./02-packages-layering.md)）
- git 扩展 repository.ts 拆分 + ActivationEvents 常量（上轮 P2 遗留，若 git 扩展仍在迭代）。

---

## 2. 明确不做 / 维持现状（避免反复论证）

| 条目 | 决策 | 理由 |
|---|---|---|
| ACP stdio 背压 | 先测量再决定（从 P0 降 P2） | 用户可感知的诱因（renderer O(L²) 重解析）已消除；ProxyChannel 事件是 fire-and-forget，全链路背压需应用层 ack，成本高。先给 acpHost stdout 加字节水位日志 |
| AI 供应商层 vs ACP 层统一 | 维持两套 | 边界清晰（ACP=agent 协议，IAiModelService=裸模型调用），唯一桥点 acpSessionTitleService 干净合理 |
| node-pty / 探测类 spawn 收编 ManagedChildProcess | 不收编 | 探测类短命进程与 detached fire-and-forget 属合理豁免；node-pty 有自身生命周期语义，收益低。登记为"有意的非统一" |
| turbo typecheck dependsOn ^build | 保留 | turbo.json 已有书面论证（dist/*.d.ts 缓存恢复语义），上轮已关闭 |
| 扩展硬隔离 / Node 权限模型 | 后置（marketplace plan Phase E） | 已验证软隔离 + 发布者信任是当前诚实边界；走出内网前的前置是 TLS + 代码签名 |
| React + Monaco 双心智模型接缝 | 持续用护栏对冲，不"修完" | 选型代价；已有 leak tracker / leak test / markAsSingleton 体系，方向是统一订阅 hook（P2-13）而非换架构 |

---

## 3. 分报告索引

| # | 文档 | 主题 |
|---|---|---|
| 1 | [01-roadmap-audit.md](./01-roadmap-audit.md) | 上一轮路线图逐条落地审计（收官宣告） |
| 2 | [02-packages-layering.md](./02-packages-layering.md) | packages 内核与分层（含包依赖图、契约层债务） |
| 3 | [03-main-process-ipc.md](./03-main-process-ipc.md) | main 主进程与 IPC（含 URI marshalling、反向 RPC 悬挂） |
| 4 | [04-renderer-workbench.md](./04-renderer-workbench.md) | renderer 工作台（含 top20 大文件、注册链现状） |
| 5 | [05-acp-ai.md](./05-acp-ai.md) | ACP/AI 子系统（含 fork 维护、双 agent 抽象） |
| 6 | [06-extensions-engineering.md](./06-extensions-engineering.md) | 扩展系统与工程化（含 CI、marketplace、文档体系） |
