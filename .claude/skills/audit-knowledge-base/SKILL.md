---
name: audit-knowledge-base
description: 季度审视 Claude 知识体系（CLAUDE.md / cases-*.md / skills / docs/development）的体积、索引同步与失效引用。当用户说审视知识体系 / audit knowledge / 季度知识盘点 / CLAUDE.md 体积检查 / 知识库腐化治理时使用。
disable-model-invocation: true
---

# 审视 Claude 知识体系（季度）

知识体系**只进不出会腐化**：CLAUDE.md 越写越长（触碰目录即全量进上下文）、cases 条目膨胀成实现叙述、索引与新文件脱节、路径引用随重构失效。本 skill 把盘点动作固化成清单，每季度（或大批量重构后）跑一轮。

> 第一原则：**知识分层归位**——绑定代码目录的进该目录 CLAUDE.md（放不下拆同目录 `cases-*.md` 并留一行 hook）；跨目录流程/排障进 skill（案例多时放其 references/）；跨模块机制/长文进 `docs/development/`。审视的本质是把漂移出去的内容搬回该在的层，而不是再加新文档。

## 一、失效引用与规模盘点（命令固化）

```bash
# 1. 路径引用校验（CLAUDE.md / cases / skill / vendor 全扫；含 [[slug]] 残留护栏）
pnpm knowledge:check

# 2. CLAUDE.md 体积：硬预算护栏（>15000 bytes 即失败）+ 行数排序（>400 行是拆分候选）
pnpm claude-md:check
find . -name CLAUDE.md -not -path "*/node_modules/*" | xargs wc -l | sort -rn | head -15

# 3. cases-*.md 清单（无体积硬限，但单个 >400 行是进一步拆分候选）
find . -name 'cases-*.md' -not -path "*/node_modules/*" | xargs wc -l | sort -rn | head -10

# 4. skills 索引同步检查
pnpm skills:check
```

## 二、cases 与导航一致性审视（`cases-*.md`）

`cases-*.md` 是 CLAUDE.md 的溢出承接层：**没有硬预算，但必须有宿主反向可达**。

1. **每个 cases 文件都要有宿主 hook**：同目录 CLAUDE.md 里应有一行（≤120B）指向它。
   `pnpm knowledge:check` 只保证「文档里写的路径存在」，**查不出「有文件无 hook」**——
   用 `find . -name 'cases-*.md'` 对照同目录 CLAUDE.md 的链接列表补齐。
2. **>400 行的条目**：实现叙述能从代码注释 / git 历史读到的，压成「索引 + 锚点」；只留非显然教训。
3. **同簇 ≥3 条**：多个 cases 讲的是同一子系统的连续进展 → 收敛成一篇或升级为独立 skill。
4. **已覆盖删除**：内容已完整沉淀进代码注释 / 其它知识文档的，直接删——cases 不是档案柜。
5. **失效验证**：条目里点名文件/函数/行号的，grep 确认仍存在。路径由 `pnpm knowledge:check` 覆盖，
   但**行号锚点会随文件增长漂移**（一次迁移中实测出多处），抽查高频锚点。

## 三、skills 审视（`.claude/skills/`）

1. **季度未触发**：git log 看 skill 目录最近提交距今 >6 个月且对应子系统已稳定 → 归档到 `.claude/skills-archive/`（git 留史），README 同步删行。
2. **description 有效性**：只写触发条件（≤400B），核心心智在正文——发现 description 写成摘要的顺手修。
3. **codex 策略同步**：新增/归档 skill 后跑 `pnpm skills:policy`（同步 `agents/openai.yaml`）。
4. **案例不独立成 skill**：发现有人把功能案例写成 skill → 并入对应子系统 CLAUDE.md（规范见 `.claude/skills/README.md`）。

## 四、CLAUDE.md 审视

1. **贴顶预算：加内容前先定「从哪腾」**：全仓 CLAUDE.md 有 15000 bytes 硬预算（`pnpm claude-md:check`），而多数文件常年贴顶（`apps/editor/CLAUDE.md` 与 nested 文档多在 14.7–15.0KB）——往这些文件加一段几乎必然撑破预算。正解是把它推进该目录的 nested CLAUDE.md（新开一份也行，最小的一份才 1.1KB）+ 父文件留一行指针，而不是删别人写的事实。压缩手法（实测有效、不掉事实）：删与正文重复的「关键参考路径」汇总节、把细节推给相邻子文档（别抄别处已记的）、合并同义句、删示例代码里的解释性注释。中文 3 bytes/字，改完**必须 `wc -c` 实测**，别凭感觉估。
2. **>400 行拆分**：按「章 = 候选子域文档」切，子域文档放代码所在目录、头部回指父文档、互指改显式相对路径。参考 2026-07 的 acp/ai/perforce 三分（commit 91ecbc08 一带）。
3. **嵌套地图覆盖**：`apps/editor/CLAUDE.md` 的「嵌套知识地图」表与根 CLAUDE.md 导航表是否覆盖全部现存 CLAUDE.md——`find . -name CLAUDE.md -not -path "*/node_modules/*"` 对照，缺行补行。
4. **与代码漂移**：抽查各文件「文件归位」表点名的文件是否还在原位；章节叙述与代码现状矛盾的，按代码现状改写（禁止照抄旧结论——被后续提交推翻的判据若不核对现状就会被搬成过期事实）。
5. **套路去重**：同一套路出现在多处目录 CLAUDE.md 的，保留最贴近代码的一份，其余改指针。

## 五、收尾

```bash
pnpm check   # 全绿才算完（含 knowledge:check / claude-md:check / skills:check / lint / typecheck / test）
```

发现的问题**当批修完再提交**，不要留「下次再说」的清单——知识体系债务的教训是：清单即坟墓。提交粒度按「失效修复 / 瘦身 / 拆分 / 索引补全」分批，便于回溯。
