---
name: builtin-agent-skills-user-extension-commands
description: 内置 agent skills 注入机制(additionalDirectories)+ 面向最终用户的 new-extension / port-vscode-extension 两个中文 skill
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-19T02:39:59.062Z
---

编辑器内置 agent skills 分发机制 + 用户版「创建/移植扩展」skill(2026-08-18 落地)。

**机制(通用,加 skill 零代码)**:skill 放 `apps/editor/resources/agent-skills/.claude/skills/<name>/SKILL.md` → main `environmentSnapshotMainService` 暴露 `builtinAgentSkillsRoot`(packaged=`<resources>/agent-skills`,dev=resolveFromRepo;目录缺失=undefined,接口字段是可选 `?:` 非 `| undefined`)→ renderer `acpSessionService._builtinAgentDirs()`(可选尾参注入+memoized,现有测试零改动)在 new/load/resume/fork 四条 wire 路径 spread ACP 官方 `additionalDirectories` → 两个 fork 零改动发现(codex `refreshSkills` 扫 roots;claude SDK 当 working-dir root,**已实测** `supportedCommands()` 返回两个 skill)。remote authority 会话不注入(本地路径对远端无意义)。打包:runtime-resources.mjs stage 整树 + 每 skill 一条 sentinel。

**Why**:编辑器发布后用户看不到仓库内 `.claude/skills`,须随安装包分发并在会话建立时注入;做成通用目录后后续内置 skill 只需加文件。

**How to apply**:加内置 skill=放 SKILL.md+补 sentinel,详见 `services/acp/session/CLAUDE.md`「加/改内置 agent skill」条。坑:① AcpSessionService 有依赖预算守卫测试(depBudget,加注入须写理由 bump);② 用户版 skill 命名避开本仓库开发者 skill(故叫 `new-extension` 不叫 `create-extension`);③ SKILL.md 要求全旗标非交互脚手架命令(交互 CLI 在 agent 环境挂起);④ Node 版本要求以 docs/extension-dev getting-started 为准(22+)。相关 [[third-party-extension-ecosystem-plan]] [[extension-api-09-surface-expansion]]。

**2026-08-19 优化**:两 skill 接入示例仓库 universe-editor-extension-samples(24 示例全带 e2e)——幂等克隆到 `~/.universe-editor/extension-samples`+每次参考前 pull --ff-only,失败降级不阻塞;port 四档评估先用其根 README 的官方 sample 对照表粗定位。资料分工事实:extension-api npm 包 `files` 只有 dist(9 个带 JSDoc 的 .d.ts=API 最终裁决)+自动附带 README;**COMPATIBILITY.md 与 docs/extension-dev 都不进 npm 包也不进 node_modules**,概念文档只在编辑器安装目录 `resources/docs/extension-dev/zh-CN/`(runtime-resources.mjs 复制)。agent-skills 打包是整树复制,skill 可加 SKILL.md 之外的辅助文件(verify 清单只校验 SKILL.md)。

**2026-08-19 隐式调用治理**:内置 skill 统一声明 `disable-model-invocation: true`(仅 `/` 手动调用,不进模型自动隐式调用)。Claude 端原生 CLI 解析该 frontmatter 即生效;codex 端原生二进制不读 frontmatter、只认 per-skill `agents/openai.yaml` 的 `policy.allow_implicit_invocation`(缺省 **true**=允许隐式调用),故由 codex-acp fork 在接入层桥接:`skillPolicyBridge.ts` 读 SKILL.md frontmatter → 物化 openai.yaml(sentinel 首行 `generated-by: codex-acp skill-policy-bridge`,flag 移除即回收,绝不碰无 sentinel 的用户手写 yaml),只处理 additionalDirectories 派生的 `.agents/skills`/`.claude/skills` 两个 root、**不碰 cwd/.claude/skills**(用户项目目录)。生成的 yaml 由根 .gitignore 忽略;`scripts/sync-codex-skill-policy.mjs` 仍服务于直接跑官方 codex CLI 的仓库开发者。
