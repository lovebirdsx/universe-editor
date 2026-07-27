# Claude 知识体系（CLAUDE.md / skills / memory）整体评估与优化方案

> 撰写日期：2026-07-26
> 调研方式：全量盘点 30 个 CLAUDE.md、11 个 skill、47 条 memory；运行 `pnpm docs:check` / `skills:check` / `knowledge:check` 三重校验；对 memory 内路径引用做独立失效扫描；核实校验脚本源码（`check-knowledge-links.mjs` / `lint-skills.mjs`）与治理规范（`.claude/skills/README.md` / `.claude/memory/README.md`）

## 背景

本仓库为 AI 协作维护了一套三层知识体系：

| 层 | 载体 | 加载时机 | 定位（根 CLAUDE.md 明文约定） |
|---|---|---|---|
| CLAUDE.md | 根 + 29 个目录级文件 | 根文件常驻；目录文件在触碰该目录时自动加载 | 绑定具体代码目录的知识 |
| skills | `.claude/skills/`，11 个 | frontmatter description 常驻注入，正文按需加载 | 跨目录的流程 / 手册 |
| memory | `.claude/memory/`，47 条 + `MEMORY.md` 索引 | 索引常驻，条目按需读取 | 跨会话教训的一句话索引 |

配套基建：`knowledge:check`（skill/CLAUDE.md 路径引用校验）、`skills:check`（frontmatter lint + codex 策略同步校验）、`docs:check`（用户文档死链），三者全部接入 `pnpm check` 与 CI；memory 真身入 git、经 junction 跨 clone/跨机共享；skill 通过 `agents/openai.yaml` 与 codex 双 harness 同步；`.claude/skills-archive/` 提供归档机制。

## 一、评估总览

**这套体系的成熟度显著高于一般仓库**——三层定位有明文分工、发现机制（常驻索引 + 按需正文）设计正确、校验基建接入 CI、跨 harness / 跨机同步均已解决。当前三重校验全绿，memory 索引与文件 100% 同步，skill frontmatter 100% 合规。**架构不需要动。**

真实的债务集中在三条主轴，全部是「规模增长后的执行漂移」，而非设计缺陷：

1. **校验盲区**：`knowledge:check` 不扫 memory，memory 中已出现 3 处失效路径引用；vendor 下 2 个 CLAUDE.md 也在扫描范围外。
2. **体积失控苗头**：3 个目录级 CLAUDE.md 超过 50KB（最大 81KB ≈ 2 万 token，触碰该目录即整体进入上下文）；1 条 memory 达 17KB，明显违反自家「一句话索引」约定。
3. **导航覆盖率低**：根导航表只指向 4/30 个 CLAUDE.md，`apps/editor/CLAUDE.md` 对其下 16 个嵌套 CLAUDE.md 零索引——规划阶段（尚未触碰目标目录文件时）模型无从得知这些知识文件存在。

## 二、分项评估

### 2.1 CLAUDE.md（30 个）

**做得好的**：
- 分层结构正确：根做导航 + 跨包约定（83 行，克制），子目录承载领域细节，符合「触碰即加载」的机制特性。
- 内容形态统一且高质量：「套路 X」编号体系、「常见任务 → 改哪里」映射表、「易踩坑速记」——都是可直接执行的操作性知识，不是描述性文档。
- 路径引用受 `knowledge:check` 保护（28 个非 vendor 文件在扫描范围内），当前零死链。

**问题**：

**① 头部文件体积失控**。规模分布呈长尾：

| 文件 | 行数 | 体积 | 说明 |
|---|---|---|---|
| `services/acp/CLAUDE.md` | 870 | 81KB | 实为 4 个子系统合订本：ACP 核心 + 会话子系统 + Claude agent 设置 + Codex agent 设置 |
| `services/ai/CLAUDE.md` | 683 | 52KB | 内联补全 + NES 编辑建议 + AI 设置页三块合订 |
| `extensions/perforce/CLAUDE.md` | 524 | 55KB | — |
| 其余 27 个 | 均 <360 | 均 <25KB | 健康 |

81KB ≈ 2 万 token。在 acp 目录改一行代码，这 2 万 token 全部进入上下文——其中 3/4 与当次任务无关（改会话持久化不需要 Codex 登录方案的知识）。CLAUDE.md 的加载是目录级全量、无按需节选，**唯一的粒度控制手段就是目录拆分**。acp 的章节结构（「会话子系统」「Agent 设置：Claude」「Agent 设置：Codex」均有独立的文件地图/套路/易踩坑）已经自然给出了拆分线。

**② 导航链路断层**。根导航表覆盖 4 个 CLAUDE.md；`apps/editor/CLAUDE.md` 作为「套路最多的主战场」，对其下 16 个嵌套 CLAUDE.md（acp / ai / explorer / opener / scm / outline / webview…）没有任何索引。触碰文件时自动加载能兜底「改到了才知道」，但规划/定位阶段（「会话持久化在哪做」）模型看不到这张地图，会退化为直接搜代码。`packages/extension-host`、`packages/workbench-ui`、`extensions/*`、`docs/user` 同样不在任何导航表中。

**③ vendor 盲区**。`check-knowledge-links.mjs` 的 `SKIP_DIRS` 含 `vendor`，故 `vendor/claude-agent-acp/CLAUDE.md`、`vendor/codex-acp/CLAUDE.md` 不受校验（实测 39 = 28 CLAUDE.md + 11 SKILL.md）。fork 内部路径不校验是合理的，但这两个文件中指向主仓库的引用也一并逃逸了。

### 2.2 skills（11 个）

**做得好的**：
- 治理基建最完整的一层：`lint-skills.mjs` 强制 description ≤400B、name 与目录名一致；`skills:policy` 自动同步 codex 侧 `agents/openai.yaml`；两者都在 CI。
- 命名族谱清晰（`fix-*` 排障 / `extend-*` 扩展套路 / 动词开头流程），description 全部按「触发条件」而非「内容简介」撰写，正文普遍有「第一原则」提纲挈领——发现与调用的信噪比都很高。
- 体量克制（63–201 行），有归档机制（`skills-archive/`）且已有实际收敛先例（nsis、e2e-flake 案例库从 memory 收敛为 skill）。

**问题**：

**① 规范与实践相反**。`.claude/skills/README.md` 写「默认加 `disable-model-invocation: true`（手动 `/xxx` 调用）；高频流程类可去掉」，实际 11 个 skill 中 8 个未加（即开放模型自动调用），只有 3 个运维类（nsis、两个 fork 更新）手动。实践是对的——排障/扩展套路类 skill 本就应该让模型在命中触发条件时自动加载——错的是 README 的「默认」措辞。规范文档与现实相反会误导后来者（人和 AI）新增 skill 时默认封死自动调用。

**② `fix-ci-e2e-flake` 承担了案例库职责但无淘汰节律**。它带 2 个附属文件（案例库），按设计会持续追加经验。目前健康，但「案例只进不出」与 memory 层面临的是同一类增长问题，可与 memory 治理共用同一套季度审视节律（见 3.4）。

### 2.3 memory（47 条 + 索引）

**做得好的**：
- 形式治理满分：47 条全部有合规 frontmatter（name/description/metadata.type），`MEMORY.md` 索引与磁盘文件双向 100% 同步，零孤儿零死链。
- 索引条目是高密度 hook（「坑=await 前取完 service」这类一行压缩），并按「功能进展 / 性能疑难 / 打包 / 护栏 / e2e」分区——符合「索引常驻、真身按需」的设计。
- 已展示过健康的收敛动作：nsis 与 e2e-flake 两簇 memory 收敛为 skill 后从索引移除，只留一行指路注记。
- junction 共享方案（真身入 git）解决了原生 memory 按 cwd 隔离的痛点，worktree 自动重定向也已验证可用。

**问题**：

**① 校验盲区已造成实际腐化**。`knowledge:check` 只扫 skills + CLAUDE.md，memory 完全不在范围内。独立扫描发现 3 处真实失效引用：

| memory 文件 | 失效引用 | 实况 |
|---|---|---|
| `dirty-diff-inline-peek-feature.md` | `packages/extensions-common/src/dirtyDiff.ts` | 已迁移至 `apps/editor/src/renderer/`（contributions/dirtyDiff.ts 等） |
| `monaco-055-editcontext-nls.md` | `scripts/build-monaco-nls.mjs` | 脚本已不存在 |
| `monaco-055-editcontext-nls.md` | `vendor/monaco-nls/zh-cn.messages.json` | 目录已不存在（NLS 方案已改索引制英文桥接，memory 正文未跟上） |

memory 的定位是「跨会话教训」，被召回时若指向不存在的文件，比没有更糟——模型会先按旧路径找一轮。这层恰恰是唯一没有校验保护的。

**② 归属漂移：部分 memory 长成了文档**。约定是「memory 只留跨会话教训的一句话索引」，但「功能实现进展」区的多条实为完整设计文档/变更日志。最典型的 `extension-system-progress.md` 达 62 行 / 17KB，逐 Phase 记录实现细节（文件清单、DTO 字段、测试数量）——这些内容 90% 可从 git 历史和现已存在的 `packages/extension-host/CLAUDE.md`、`extensionManagement/CLAUDE.md` 读到，且随代码演进必然腐化（它还引用了一个本机绝对路径的计划文件 `C:\Users\kuro\.claude\plans\...`，跨机不可用）。类似的还有 `agent-binary-silent-download-e2e-fix.md`（46 行）、`largefile-reveal-dirtydiff-vscode-parity.md`（34 行 6KB）等。对比之下 `dirty-diff-inline-peek-feature.md`、`opener-service-deeplink-feature.md` 的「hook + 套路见 XX/CLAUDE.md」形态才是约定本意。

**③ 增速无配套淘汰节律**。首批 memory 落地于 2026-06-27，一个月累积 47 条（≈1.5 条/天），`MEMORY.md` 已 70 行。索引每行都常驻每次会话的上下文，照此增速一年后将是 500+ 条量级。已有归档先例但属临机动作，没有成文的节律（何时合并、何时收敛为 skill/CLAUDE.md、何时删除）。

### 2.4 校验基建与文档层

- 三重校验全绿、全部接入 CI，这是体系没有大面积腐化的根本原因。缺口只有两个：memory（2.3①）与 vendor CLAUDE.md（2.1③）。
- `docs/development/` 与 skill 的边界基本清晰（面向人的手册 vs 面向 AI 的流程）。小瑕疵：`docs/development/claude.md` 讲的是 Claude harness 配置技巧（auto-compact 窗口），属于「开发者如何用 AI」而非项目知识，与知识体系三层均不重叠，保持现状即可。

## 三、优化方案（按优先级）

### P0：补校验盲区（半天内可完成，收益立现）

1. **`knowledge:check` 纳入 memory**：`check-knowledge-links.mjs` 的扫描集合加 `.claude/memory/*.md`（复用现有的路径抽取与 `.js→.ts` 映射逻辑；`MEMORY.md`/`README.md` 可跳过或一并扫）。含 `...` 省略号的引用已被现有模板过滤规则的同类思路覆盖，需把 `...` 加进忽略模式避免误报。
2. **修复 3 处已失效引用**：
   - `dirty-diff-inline-peek-feature.md`：`packages/extensions-common/src/dirtyDiff.ts` → 更新为 renderer 侧现址（或直接删该行，套路已指向 `workbench/scm/CLAUDE.md`）。
   - `monaco-055-editcontext-nls.md`：删去 `build-monaco-nls.mjs` / `zh-cn.messages.json` 段落，正文与「索引制英文桥接」现状对齐。
3. **（可选）vendor CLAUDE.md 单独扫描**：对 `vendor/*/CLAUDE.md` 只校验指向主仓库前缀（`apps/`、`packages/`…）的引用，fork 内部路径继续豁免。

### P1：超大 CLAUDE.md 拆分（一次性重构，上下文成本直接减半以上）

4. **`services/acp/CLAUDE.md`（870 行）按现有章节线拆四份**：
   - `services/acp/CLAUDE.md` 保留 ACP 核心（文件归位/数据流/套路 ACP-A~F/SDK 约定，约 190 行）+ 三行导航指向下面三份；
   - 会话子系统 → 就近放到其代码目录（如 `services/acp/session/CLAUDE.md`，按「会话子系统（acp-session）」章节整体迁移）;
   - 「Agent 设置：Claude」「Agent 设置：Codex」→ 各自代码目录的 CLAUDE.md。
   拆分原则：**让「触碰哪个子目录」决定「加载哪块知识」**，与 harness 的目录级加载机制对齐。若三块代码与 acp 核心同目录混放无法拆目录，则退而求其次：把「Agent 设置」两章压缩成「文件地图 + 常见任务 → 改哪里」两表（历史性叙述删除），目标腰斩到 40KB 以下。
5. **`services/ai/CLAUDE.md`（683 行）同法**：内联补全 / NES / AI 设置页三块中，与代码目录能对应的下沉，不能对应的压缩「数据流一图」以外的重复叙述（NES 章节与内联补全章节存在大量平行结构，「共享 vs 分叉」表已经是正确形态，其余可向它看齐）。
6. **`extensions/perforce/CLAUDE.md`（524 行）** 审视同类机会（本次未深入其内容，拆分前先确认章节结构）。

### P1：memory 瘦身与归属回位（与 P0 同批做，防止继续漂移）

7. **巨型 memory 沉淀 + 缩身**，以 `extension-system-progress.md` 为样板：
   - 其中仍然有效的「关键非显然决策」逐条核对，属于目录知识的并入 `packages/extension-host/CLAUDE.md` / `extensionManagement/CLAUDE.md`（多数可能已覆盖，重复则直接删）；
   - memory 本体缩为 ≤15 行：现状一句话 + 决策 hook 列表 + 指向两个 CLAUDE.md；
   - 删除本机绝对路径引用（`C:\Users\...\plans\...`），该计划已完结，git 历史可查。
   - 同法处理 `agent-binary-silent-download-e2e-fix.md`、`largefile-reveal-dirtydiff-vscode-parity.md` 等 30 行以上的条目。
8. **把体积约定写进 `.claude/memory/README.md`**：单条 memory 目标 ≤20 行；超过即视为「该沉淀到 CLAUDE.md / skill 了」的信号。（不必上 lint，README 一句话 + 季度审视兜底即可；memory 由 AI 高频写入，硬卡会产生绕行行为。）

### P2：导航与规范对齐（低成本，改善规划阶段体验）

9. **`apps/editor/CLAUDE.md` 增加嵌套知识地图**：一张「子系统 → CLAUDE.md」两列表列全 16 个嵌套文件（acp / ai / explorer / opener / dialogs / dnd / views / configurationResolver / files / markdown / outline / scm / webview / e2e / extensionManagement / docs-user），每行一句定位。根 CLAUDE.md 导航表补 `packages/extension-host`、`packages/workbench-ui`、`extensions/`、`extensions-external/`、`vendor/` 五行。约 25 行成本，换规划阶段的知识可发现性。
   - 可选加固：`knowledge:check` 顺带校验「每个目录级 CLAUDE.md 至少被上一层某个 CLAUDE.md 引用一次」，防新增文件成为孤岛。
10. **`.claude/skills/README.md` 措辞对齐实践**：「默认加 `disable-model-invocation: true`」改为「排障/套路类默认开放模型自动调用；仅长流程运维类（fork 更新、发布）加 `disable-model-invocation: true` 走手动」。

### P3：建立增长节律（防一年后的规模问题）

11. **季度知识审视**（建议做成 skill，如 `audit-knowledge-base`，`disable-model-invocation: true` 手动触发）：
    - memory：>20 行的条目沉淀回位；已被 CLAUDE.md/skill 覆盖的删除；同簇 ≥3 条的评估收敛为 skill（复制 nsis / e2e-flake 先例）；
    - skills：一个季度未被触发的评估移入 `skills-archive/`；
    - CLAUDE.md：>400 行的评估拆分；
    - 跑 `pnpm check` + 本次扩展后的 memory 扫描确认零死链。
    本报告的盘点命令（体积统计、索引同步检查、失效引用扫描）可直接固化进该 skill 作为操作步骤。

### 实施顺序建议

P0（第 1–3 项）和 P1-memory（第 7–8 项）一批做——都是 memory 层的修复，半天到一天。P1-CLAUDE.md 拆分（第 4–6 项）单独一批，acp 优先（体积最大、章节线最清晰）。P2（第 9–10 项）随任一批顺手带上。P3 在前两批完成后落地为 skill。

## 附录：关键数据

- CLAUDE.md：30 个，中位数 ≈140 行；Top3 体积 81/55/52KB；根导航覆盖 4 个，`apps/editor` 对嵌套文件覆盖 0 个。
- skills：11 个 + 归档区（空）；正文 63–201 行；8 个开放模型自动调用；lint 强制 description ≤400B。
- memory：47 条（2026-06-27 起一个月累积），frontmatter 合规率 100%，索引同步率 100%；`MEMORY.md` 70 行；>30 行的条目 5 条，最大 17KB；真实失效路径引用 3 处（集中在 2 个文件）。
- 校验：`docs:check`（49 文件）/ `skills:check`（11 skill）/ `knowledge:check`（39 文档 = 28 CLAUDE.md + 11 SKILL.md）当前全绿；memory 与 vendor CLAUDE.md 不在任何校验范围内。
