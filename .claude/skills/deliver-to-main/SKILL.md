---
name: deliver-to-main
description: 把当前 worktree 交付到 main（与手机「交付到 main」同一引擎的 CLI 入口）
disable-model-invocation: true
---

# 交付当前 worktree 到 main

手动调用。`pnpm deliver` 走内置 git 扩展的交付引擎，与手机「交付到 main」共用锁和 worktree 同步规则；完整语义见 [交付流水线](../../../docs/development/delivery.md)。

## 流程

1. 查看当前 worktree 与待交付内容：
   ```bash
   git status --porcelain
   git diff --stat
   ```
2. 有未提交改动时，按 [提交信息规范](../../../docs/development/git-commit-msg-rule.md) 生成消息：`type(scope): 中文摘要`，摘要 ≤72 字符、不以句号结尾；一个提交尽量只做一类事，不加 AI/工具署名。用户已给出消息时直接使用。
3. 先预览（会 fetch，但不提交、不移动 main、不同步 worktree）：
   ```bash
   pnpm deliver --dry-run --message "<msg>"
   ```
4. 正式交付（无未提交改动时省略 `--message`）：
   ```bash
   pnpm deliver --message "<msg>"
   ```
   在 workspace 子包目录内用 `pnpm -w deliver`。正式交付必须从子 worktree 发起；源目录是 main
   worktree 时返回 `unsupported`（dry-run 仍会打印计划并标注不能正式交付）。
5. 转述汇总（main 移动、提交、worktree 同步结果）；失败按输出的 blocker / 错误码处理，不要盲目重跑。
   - 冲突：在源 worktree `git rebase` 到 upstream 后重试。
   - `push_unverified` / `push_failed`：main 可能已停在交付提交；先核对 main 与远端，远端缺失时可
     `git push <remote> <branch>`，不要重新交付一遍。
6. 同一仓库同时只允许一个交付；手机或另一个 CLI 持锁时返回 `lock_held`，等其结束或确认 owner 失效，
   不要手工删锁。

> 本 skill 不代跑 `pnpm check`；有代码改动时先按根 `CLAUDE.md` 完成验证。

退出码：`0` 成功（worktree 跳过不算失败）/ `1` 交付失败（含推送成功但某个 worktree 同步 `failed`，
此时只需手动处理同步）/ `2` 参数错误。

## 关键参考

- [交付流水线](../../../docs/development/delivery.md)：阶段、共享锁、CLI 用法、worktree 同步语义
- [提交信息规范](../../../docs/development/git-commit-msg-rule.md)
- 引擎：`extensions/git/src/delivery/`（`deliveryGit.ts` / `deliveryPipeline.ts` / `deliveryCli.ts`）
- 启动器：`extensions/git/scripts/deliver.mjs`
