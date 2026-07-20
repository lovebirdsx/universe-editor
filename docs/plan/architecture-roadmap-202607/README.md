# 架构优化路线图（2026-07）

> 撰写日期：2026-07-20
> 依据：[architecture-review-202607](../architecture-review-202607/README.md) 六路调研报告（所有问题条目均附文件:行号证据）。
> 定位：上一轮 [maintainability-roadmap](../maintainability-roadmap/README.md)（结构性治理）已收官（P0 4/5、P1 15/19 完成），本轮重心转移到**契约固化、外部依赖策略、防回涨机制**。
> 状态标记：⬜ 未开始 / 🔨 进行中 / ✅ 已完成 / ⏸️ 挂起（各计划文档内逐任务回写）。

---

## 0. 三条主轴（为什么是这些）

1. **契约漂移是当前最大的系统性风险**——同一病灶在三个层面独立出现：editor↔vendor fork（5 个 ext-method 靠 "keep both in sync" 注释、零自动化集成验证）、renderer↔扩展（wire DTO 结构化复制、两头无测试）、main↔renderer（URI 跨 IPC 无统一 marshalling，已发生真实 @p1 回归）。→ 计划 01 / 02 / 04。
2. **vendor fork 维护策略不对称**——claude fork 无维护文档、+1343 行集中改在单个 6579 行文件、上游功能重叠概率高，rebase 成本可能一次性爆发；两个 fork clone 均未配 `upstream` remote。→ 计划 01。
3. **拆过的东西在回涨**——acpSessionService 14→16 个 @inject（唯一逆行指标）、windowMainService 725 行、main.tsx 迁移半途。需要的是**机制性门槛**而非再拆一次。→ 计划 06。

---

## 1. 计划文档索引

| # | 计划文档 | 主题 | 核心动作 | 预估规模 |
|---|---|---|---|---|
| 1 | [01-acp-contract-and-fork.md](./01-acp-contract-and-fork.md) | ACP 契约固化与 fork 维护 | 跨仓契约测试（真 fork dist）、claude fork 维护文档 + upstream remote、agents e2e 提级 @p0、ext-method 能力通告、per-agent quirks 表 | 中 |
| 2 | [02-ipc-hardening.md](./02-ipc-hardening.md) | IPC 层系统性补强 | URI 自动 marshalling（$mid 式）、ChannelClient dispose-reject + 反向 RPC 超时、wire 结构化错误 | 中 |
| 3 | [03-ci-and-engineering.md](./03-ci-and-engineering.md) | CI 与工程化 | concurrency + timeout + package-windows 降频、extensions-external typecheck 入 CI、激活失败回传、engines.universe 发布侧必填、观测/文档卫生 | 小 |
| 4 | [04-packages-contracts.md](./04-packages-contracts.md) | packages 契约层 | wire DTO 单一事实源（import type）、extensions-common 拆层 + 补测、包边界固化为 lint、卫生项 | 小-中 |
| 5 | [05-renderer-consolidation.md](./05-renderer-consolidation.md) | renderer 注册与订阅收口 | registerEditorWithComponent、keybinding 去顺序化、useEventValue 统一订阅、P3 机会项（useChatScroll / diff hook / 测试补位） | 中 |
| 6 | [06-antiregression-guardrails.md](./06-antiregression-guardrails.md) | 防回涨机制 | acpSessionService 依赖上限 ≤12 + 机制化断言、windowMainService 启动拆分、main.tsx registerSingleton 迁移收尾 | 中 |

---

## 2. 批次划分（按 ROI 与风险敞口排序）

### 第一批（P1 —— 有真实回归背书或风险敞口明确，建议近期集中投入）✅ 已完成（2026-07-20）

1. ✅ **ACP 跨仓契约测试**（01·任务 1）——editor↔真 fork 之间目前零自动化验证，成本约一天，是主轴一最严重缺口的直接解。
2. ✅ **claude fork 维护文档 + upstream remote**（01·任务 2）——纯文档 + 配置，成本半天，对冲主轴二的爆发风险。
3. ✅ **IPC 三项补强**（02 全部）——都在 `packages/platform/src/ipc/` 一处改、消一类 bug，其中 URI marshalling 有 @p1 真实回归背书。
4. ✅ **CI 三板斧**（03·任务 1）——几行 yaml，当前 CI 成本的最大杠杆。
5. ✅ **agents e2e 提级 @p0**（01·任务 3）——一行 tag 改动，旗舰功能获得第一道 CI 硬闸。

### 第二批（P2 —— 中期方向，随迭代推进）

6. **wire DTO 单一事实源 + extensions-common 拆层补测**（04·任务 1/2）——报告评为"性价比最高"的一项。
7. **防回涨门槛**（06 全部）——立规矩 + 启动拆分 + 迁移收尾。
8. **双 agent 抽象最后一公里**（01·任务 4/5）——能力通告替代 agentId 白名单、quirks 表收拢 vendor 差异。
9. **包边界固化为 lint**（04·任务 3）——趁实测零违例的窗口期锁死。
10. **editor 注册收口 + keybinding 去顺序化 + 统一订阅**（05·任务 1-3）。
11. **扩展生态门禁补齐**（03·任务 2-4）。

### 第三批（P3 —— 机会型 / 卫生项，随功能改动顺手做）

各计划文档末尾的"机会型任务"章节：ChatBody 抽 `useChatScroll`、diff wrapper 抽 hook、测试补位（agentSettings 优先）、turbo 观测、docs:check 扩面、幽灵目录清理等。**不单独排期，动到相关代码时顺手完成并回写状态。**

---

## 3. 明确不做 / 维持现状（承接调研报告 §2，避免反复论证）

| 条目 | 决策 | 理由 |
|---|---|---|
| ACP stdio 背压 | 先测量再决定 | 用户可感知诱因已消除；先给 acpHost stdout 加字节水位日志（登记在 01·机会型） |
| AI 供应商层 vs ACP 层统一 | 维持两套 | 边界清晰，唯一桥点干净合理 |
| node-pty / 探测类 spawn 收编 | 不收编 | 合理豁免，登记为"有意的非统一" |
| turbo typecheck dependsOn ^build | 保留 | turbo.json 已有书面论证 |
| 扩展硬隔离 / Node 权限模型 | 后置 | marketplace plan Phase E；前置是 TLS + 代码签名 |
| React + Monaco 双心智模型接缝 | 护栏对冲，不"修完" | 选型代价；方向是统一订阅 hook（05·任务 3）而非换架构 |
| claudeBinary/codexBinary 平行重复 | 暂不抽象 | 第三个 agent vendor 出现时再抽 `BinaryDownloadManager` 骨架 |

---

## 4. 执行纪律（所有计划通用）

- 每个任务完成后跑 `pnpm check`（仅截取错误输出）；涉及交互链路的任务末跑 `pnpm e2e`。
- 修 bug / 补护栏优先**先写复现测试或守卫测试再改**（项目既定纪律）。
- 重构以"行为不变 + 测试先行"为前提；保持 `data-testid` / 导出名 / 命令 id 不变，e2e 选择器零改动。
- 改完 platform 后非 dev 模式手动 `pnpm --filter @universe-editor/platform build`，否则 apps 用旧 `dist/`。
- 涉及 vendor fork 的改动：改动后跑 `pnpm agent:build`；fork 侧新功能尽量落新文件（降低 rebase diff 集中度）。
- IPC DTO / 持久化格式 / 跨仓 wire 契约的变更，即使不考虑向后兼容，也需**editor 与 fork 两侧同一批落地**并由契约测试锁住。
- 每完成一个任务，回写对应计划文档中的状态标记；整批完成后更新本 README 的批次状态。
- 用户可见功能变动（命令名/快捷键/文案/交互）同步检查 `docs/user/`。

---

## 5. 风险与边界

- **跨仓契约测试依赖 submodule 产物**——CI 中需 `git submodule update --init` + `pnpm agent:build`，注意用路径过滤控制触发频率，避免每 PR 全量构建 fork。
- **ext-method 能力通告是三仓联动改动**（editor + 两个 fork）——必须先有契约测试兜底（01·任务 1 是任务 4 的前置），否则改协议等于盲改。
- **URI marshalling 改在 IPC 信封层**——所有跨进程调用都过这条路，上线前必须跑全量 e2e；已有手写 `URI.revive` 调用点需确认幂等（revive 已 revive 的 URI 是安全的），删除调用点可分批。
- **windowMainService / acpSessionService 拆分是业务热区**——测试网已就位，仍需小步提交，宁可慢不可一次性翻。
- **keybinding 去顺序化会改变 tie-break 语义**——迁移时逐条核对现有顺序敏感注释（actions/index.ts:479-482,509-511,651-685），用 e2e 键位冒烟兜底。
