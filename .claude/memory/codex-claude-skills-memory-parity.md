---
name: codex-claude-skills-memory-parity
description: Codex(codex-acp fork)对齐 Claude 的 skills/memory——adapter 层读 .claude/skills 与 .claude/memory，手动开关靠每 skill 的 openai.yaml
metadata:
  type: project
---

让内置 Codex agent(`vendor/codex-acp` fork)与 Claude 在 `.claude/` 上对等:输入 `/` 能看到用户的 skills、自动加载项目 memory。一套 `.claude/` 同时服务两个 agent。

**为什么在 adapter 层做**:codex-acp 是自维护 fork,改 adapter 源码可让所有 repo 自动兼容,无需每仓库手配。用户明确选「改 adapter 源码」而非 repo 静态文件。

**改动(全在 `src/CodexAcpClient.ts`,71 行 diff)**:
- **skills**:`refreshSkills` 在 codex 原生 `.agents/skills` 外，额外把 `cwd/.claude/skills` + 各 `additionalRoots/.claude/skills` 加进 `skills/extraRoots/set`。codex 自动扫 cwd 下 `.agents/skills` 但从不扫 `.claude/skills`，故须显式列。与 `.agents/skills` 对称(无存在性检查)以最小化 diff。
- **memory**:新增 `buildMemoryInstructions(cwd)` 读 `cwd/.claude/memory/MEMORY.md`，作为 `developerInstructions`(附加层，**绝不**用 `baseInstructions`——会替换 codex 系统提示)注入 newSession/resumeSession/loadSession 三入口。对齐 Claude 每轮自动加载 memory 索引；codex 随后按需读 `.claude/memory/<slug>.md`。索引缺失/空则不注入。

**skills 手动开关(对齐 Claude 的 `disable-model-invocation: true`)**:不在 adapter 动态合成，而用每 skill 静态 `agents/openai.yaml`(`policy.allow_implicit_invocation: false`，codex 原生读它)。父项目 `scripts/sync-codex-skill-policy.mjs` 把 SKILL.md 的 `disable-model-invocation: true` 镜像成 openai.yaml，幂等 + `--check` CI 模式;`pnpm skills:policy` / `skills:policy:check`。Claude 忽略 `agents/`,Codex 忽略 Claude frontmatter——SKILL.md 是共享标准。

**已知测试现象**:`CodexAcpClient.test.ts` 3 个用真实 codex 二进制/spy 实际值的测试(extraRoots ×2、map events from dump)在 **Windows 本机**因 `path.join` 反斜杠失败(codex rust `AbsolutePathBuf` 拒无盘符反斜杠路径),**Linux CI 通过**。生产 Windows cwd 总带盘符 → 合法绝对路径，不受影响。已用带盘符 cwd 探针证实。dump 的 `ignoredFields` 加 `extraRoots`(匿名化为字段名)规避快照跨平台漂移。

详见 fork 的 `vendor/codex-acp/CLAUDE.md`「fork 已有的本地改动」。改 fork 源码须用 Bash+Node `.cjs` 脚本绕开父项目 prettier 钩子(见 [[acp-fork-windows-path-test-flake]] 类环境问题)。
