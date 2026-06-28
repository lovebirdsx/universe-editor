# 可维护性 / 可扩展性 / 高性能 改进路线图

> 撰写日期：2026-06-28
> 范围：universe-editor 全仓库（platform 内核、main 主进程、renderer 工作台、ACP/AI 业务、扩展系统、工程化）
> 方法：6 路并行源码调研（platform / main / renderer / acp-ai / extensions / perf-eng）→ **逐条亲自核实**（剔除伪命题）→ 整合为按模块的可落地计划。
> 代码规模基线：约 100k 行 TypeScript（renderer ~76k、platform ~16k、main ~11k、extensions ~6k、workbench-ui ~4k）。

---

## 0. 总体结论

这是一个**工程素质相当高**的代码库，不是"问题成堆待抢救"的项目。客观信号：

- 全仓库非测试代码仅 **3 个 TODO/FIXME、0 个 `@ts-ignore`/`@ts-expect-error`**；
- TS 三件套严格性全开（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`），子包未关；
- 生产代码 `as unknown as` 极少（单文件最多 6 处，集中在 `lifecycle.ts` 这类底层类型体操），所谓"几百处类型断言"是把测试代码算进去了；
- 大列表虚拟化**已普遍落地**（Explorer / Search 走自研 `packages/workbench-ui/src/tree/` 的 `<Tree>` + 虚拟化，GitGraph 自带固定行高虚拟化）；
- 安全边界扎实：preload 严格白名单 + 类型守卫，密钥只走 `safeStorage`，扩展 fs 网关 + 双 host 信任级隔离；
- 测试基数大（platform 49 测试 / renderer 261 测试 / 全仓 ~400 测试文件），文档（CLAUDE.md 分层 + docs/report）质量高。

因此本路线图的定位是**"锦上添花的结构性治理"**，而非救火。真正值得投入的改进集中在三条主轴：

1. **结构性技术债**——少数随业务膨胀的"上帝文件/上帝服务"（acpSession 1816 行、acpSessionService 14 依赖、extensionService 959 行、windowMainService 631 行），以及散落 8 处、无统一抽象的**子进程管理**。
2. **脆弱的手工约定**——靠"记得改 N 处"维系的注册链（platform `index.ts` re-export、View 三处必改、main DI 的 `undefined` padding）。这些当下能用，但是回归与新人踩坑的高发区。
3. **针对性的健壮性/性能补强**——子进程 kill 无超时、ACP 流式 16ms 批处理的竞态、流式 markdown 的重解析，以及关键无测试服务的安全网。

---

## 1. 核实纪要：被否决 / 降级的调研结论

调研 agent 给出的"影响"和"ROI 数字"普遍偏夸大，且有把**上游设计权衡 / 标准做法**当 bug 的倾向。以下是经亲读代码后**否决或重定级**的主要条目，记录在此以免误导后续执行：

| 调研声称 | 核实判定 | 真相（证据） |
|---|---|---|
| AI `_pumpResponse` 未捕获 rejection → 进程崩溃（P0） | ❌ 否决 | `aiModelMainService.ts:390-404` 的 IIFE 全程被 `try/catch/finally` 包裹，catch 走 `_endRequestWithError`，finally 走 `_disposeInflight`。是健壮实现。 |
| 生产代码 479 处 `as unknown as`，类型安全差 | ❌ 否决 | 生产代码极少（`git grep -c` 单文件最多 6 处）。那个数字是测试 mock。测试里 `as unknown as IFoo` 是标准做法，不是债。 |
| 虚拟化只在 ChatBody，文件树/搜索会卡 | ❌ 否决 | Explorer/Search 用自研 `<Tree>`（`workbench-ui/src/tree/`）内置虚拟化（`ExplorerView.tsx:131,187` + `workbench.tree.virtualizationThreshold`）。 |
| `editorOptionsSchema.generated.ts` 2832 行是大文件债 | ❌ 否决 | 文件头 `GENERATED FILE — DO NOT EDIT`，由 `scripts/gen-editor-schema.mjs` 从 VSCode 源码生成。 |
| observable 环检测 `checkEnabled=false` 是 P0 隐蔽崩溃 | ⬇️ 降级 P2 | `derivedImpl.ts:135` 连注释都与 VSCode 上游逐字一致，上游同样默认关闭，是已知保守权衡，非本仓库引入。 |
| 扩展 fs 网关 symlink 可绕过（P0 漏洞） | ⬇️ 降级为纵深防御 | `acpPathPolicy.ts:7-9` 注释明确这是**有意的 text-level 设计**，"beyond strings is left to IFileService"。当前装载可信扩展 + restricted host 有 Node 权限兜底。值得补 main 端 realpath 二次校验，但非"漏洞"。 |
| QuickAccess/QuickInput 缺虚拟化和防抖会卡 | ⬇️ 降级 P2（待测量） | 未找到实测卡顿证据，列为"先测量再决定"。 |

> 结论：调研提供的**代码定位（文件:行号）基本可靠**，但**严重度判断需打折**。本路线图只保留经核实属实的问题。

---

## 2. 计划文档索引

按模块拆分为 6 份独立可执行的计划，每份内部按 P0/P1/P2 分级，含证据、影响、落地步骤、验证方式。建议阅读顺序即下表：

| # | 计划文档 | 主题 | 核心改动 | 预估规模 |
|---|---|---|---|---|
| 1 | [01-main-process.md](./01-main-process.md) | main 主进程健壮性 | 统一 `ChildProcessManager`（收编 8 处散落 spawn）、子进程 kill 超时、main DI padding 改具名 factory、关键服务补测试 | 中 |
| 2 | [02-acp-ai-subsystem.md](./02-acp-ai-subsystem.md) | ACP/AI 业务核心 | 拆分 acpSession（1816 行）/ acpSessionService（14 依赖）、显式连接状态机、16ms 批处理竞态、流式 markdown 重解析 | 大 |
| 3 | [03-platform-kernel.md](./03-platform-kernel.md) | platform 内核 | re-export 改 barrel、命令/菜单重复 ID 告警、关键内核补测试、index 拆分 | 中 |
| 4 | [04-renderer-framework.md](./04-renderer-framework.md) | renderer 框架 | View 三处必改收口为单点注册、contributions/index 按相位分文件、大组件 memo、bootstrap 数据化 | 中 |
| 5 | [05-extension-system.md](./05-extension-system.md) | 扩展系统 | API 兼容性策略文档、fs 网关纵深防御（realpath）、extensionService 拆分、extension-api 契约测试 | 中 |
| 6 | [06-perf-and-engineering.md](./06-perf-and-engineering.md) | 性能与工程化 | 启动 perf 细粒度打点 + CI 门禁、turbo/tsc 增量优化、e2e flaky 系统化、bundle size 可观测 | 小-中 |

---

## 3. 跨模块的优先级建议（按 ROI 排序）

如果只做一部分，按此顺序投入收益最高：

### 第一梯队（高 ROI，结构性杠杆，建议优先）

1. **统一子进程管理抽象**（计划 01·P0）——8 处 spawn 各写一份 kill/超时/崩溃恢复，是"加新 agent/工具"的最大重复源。收编为一个 `ChildProcessManager` 后，新增子进程从"抄一遍"变成"传配置"，并顺带统一解决 kill 超时、僵尸进程。
2. **注册链去手工化**（计划 03·P1 + 04·P0）——platform `index.ts` re-export、View 三处必改、main DI padding，都是"漏一处运行时才炸"的脆弱约定。改为 barrel / 单点注册 / 具名 factory，消除整类回归。
3. **关键无测试服务补安全网**（计划 01·P1 + 03·P1）——windowMainService、fileWatcher、userData、workspace、textSearch 等 main 服务 `__tests__` 为空；platform 的 editorGroupModel / configurationService 缺测。这些是高频改动区，无网重构风险大。

### 第二梯队（业务核心治理，随迭代推进）

4. **ACP 大文件拆分 + 状态机显式化**（计划 02·P0/P1）——acpSession.ts 1816 行混了状态机/流式/成本/视图模型；连接生命周期靠分散布尔位维护。这是未来加 agent 类型、排查 resume 竞态的最大认知负担。建议**随相关改动渐进拆分**，不必一次性大重构。
5. **ACP 流式性能补强**（计划 02·P1）——16ms 批处理与 `undefined` tx 旁路的竞态、流式消息每 chunk 重建对象触发 markdown 全文重解析。大会话场景用户可感知。

### 第三梯队（长期治理，机会型推进）

6. **扩展系统 API 稳定性 + 纵深防御**（计划 05）——决定能否长期复用 VSCode 生态、扩展生态信任度。当前内置扩展为主，不紧急，但越早定 API 兼容策略越省事。
7. **工程化可观测性**（计划 06）——启动耗时 / bundle size 的 CI 回归门禁，e2e flaky 系统化。提升每日 DX 与回归发现能力。

---

## 4. 执行纪律（所有计划通用）

- 每个阶段结束跑 `pnpm check`（仅截取错误输出）；涉及交互链路的阶段末跑 `pnpm e2e`。
- platform 下新增/移动模块，**立即**在 `packages/platform/src/index.ts` re-export（或按计划 03 迁到 barrel 后按新约定）。
- 改完 platform 后非 dev 模式手动 `pnpm --filter @universe-editor/platform build`，否则 apps 用旧 `dist/`。
- 提交粒度按阶段，遵循项目 conventional commits 风格。
- **本项目处于开发阶段，不考虑向后兼容**——重构可大胆改签名，但 IPC DTO / 持久化格式变更需评估迁移。
- 修 bug 优先**先写复现测试再改**（项目既定纪律）。
- 重构以"行为不变 + 测试先行"为前提；大文件拆分务必保持 `data-testid` / 导出名 / 命令 id 不变，e2e 选择器零改动。

---

## 5. 风险与边界

- **不建议为消灭"两套系统"重写 monaco 桥接**——`docs/report/bridge-tech-debt-assessment.md` 已论证当前桥接是 standalone monaco 下的正确架构，本路线图不触碰。
- **大文件拆分有回归风险**——acpSession / extensionService / repository.ts 都是业务热区，拆分必须测试先行、小步提交，宁可慢不可一次性翻。
- **observable / DI 内核改动需克制**——这些抄自 VSCode 且经过验证，除"补测试"外不轻易动核心算法。
