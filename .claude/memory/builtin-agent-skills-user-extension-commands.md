---
name: builtin-agent-skills-user-extension-commands
description: 内置 agent skills 注入机制(additionalDirectories)+ 面向最终用户的 new-extension / port-vscode-extension 两个中文 skill
metadata: 
  node_type: memory
  type: project
  originSessionId: f86867f1-14e0-464f-a4ac-a23dc2b222d3
  modified: 2026-08-18T08:18:30.987Z
---

编辑器内置 agent skills 分发机制 + 用户版「创建/移植扩展」skill(2026-08-18 落地)。

**机制(通用,加 skill 零代码)**:skill 放 `apps/editor/resources/agent-skills/.claude/skills/<name>/SKILL.md` → main `environmentSnapshotMainService` 暴露 `builtinAgentSkillsRoot`(packaged=`<resources>/agent-skills`,dev=resolveFromRepo;目录缺失=undefined,接口字段是可选 `?:` 非 `| undefined`)→ renderer `acpSessionService._builtinAgentDirs()`(可选尾参注入+memoized,现有测试零改动)在 new/load/resume/fork 四条 wire 路径 spread ACP 官方 `additionalDirectories` → 两个 fork 零改动发现(codex `refreshSkills` 扫 roots;claude SDK 当 working-dir root,**已实测** `supportedCommands()` 返回两个 skill)。remote authority 会话不注入(本地路径对远端无意义)。打包:runtime-resources.mjs stage 整树 + 每 skill 一条 sentinel。

**Why**:编辑器发布后用户看不到仓库内 `.claude/skills`,须随安装包分发并在会话建立时注入;做成通用目录后后续内置 skill 只需加文件。

**How to apply**:加内置 skill=放 SKILL.md+补 sentinel,详见 `services/acp/session/CLAUDE.md`「加/改内置 agent skill」条。坑:① AcpSessionService 有依赖预算守卫测试(depBudget,加注入须写理由 bump);② 用户版 skill 命名避开本仓库开发者 skill(故叫 `new-extension` 不叫 `create-extension`);③ SKILL.md 要求全旗标非交互脚手架命令(交互 CLI 在 agent 环境挂起);④ Node 版本要求以 docs/extension-dev getting-started 为准(22+)。相关 [[third-party-extension-ecosystem-plan]] [[extension-api-09-surface-expansion]]。
