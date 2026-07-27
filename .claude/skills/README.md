# skills 维护约定

skill 是**跨目录的流程/手册**（排障流程、扩展套路、发布 runbook）；绑定具体代码目录的知识请写进该目录的 `CLAUDE.md`（harness 读到该目录文件时自动加载），不要做成 skill。

**发现机制**：harness 每次会话自动注入全部 skill 的 frontmatter `description`（模型天然可见，仓库不维护路由表）；skill 主体在本目录 `<name>/SKILL.md`。

**新增 / 修改 skill**：

- frontmatter 必带 `description`（≤400B，只写触发条件，核心心智放正文）——它是 harness 注入的唯一常驻内容。
- 命名族谱：扩展套路 `extend-*`；排障 `fix-*`；流程用动词开头。
- 排障（`fix-*`）/ 扩展套路（`extend-*`）类默认开放模型自动调用；仅长流程运维类（fork 更新、发布）加 `disable-model-invocation: true` 走手动 `/xxx` 调用。codex 侧策略独立维护在该 skill 的 `agents/openai.yaml`（codex 原生读取，默认全手动 `false`；新增 skill 跑 `pnpm skills:policy` 补齐，想开放单个 skill 的 codex 自动调用就手改为 `true`）。
- 改完跑 `pnpm skills:policy`（同步 codex 侧 `agents/openai.yaml`）；`pnpm check` 会兜底校验（`skills:check` = frontmatter lint + codex 策略校验）。
- 功能案例**不独立成 skill**，并入对应子系统目录 CLAUDE.md；长期不触达且子系统已稳定的 skill 归档到 `.claude/skills-archive/`（git 留史）。
- skill/CLAUDE.md 中引用的仓库路径由 `pnpm knowledge:check` 校验，改动文件结构后跑一遍。
