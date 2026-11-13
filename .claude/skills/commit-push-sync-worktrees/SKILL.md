---
name: commit-push-sync-worktrees
description: 自动提交当前 worktree 的未提交改动，把当前分支相对 main 的提交 cherry-pick 到 main，推送 origin/main，并把所有 worktree 同步到 main。
disable-model-invocation: true
---

# 提交、推送 main 并同步所有 worktree

本 skill 只手动调用（`disable-model-invocation: true`，Codex 侧 `agents/openai.yaml` 为 `allow_implicit_invocation: false`）：它会 push 共享 `main`，并对其它干净 worktree 执行 `git reset --hard main`。

## 流程

1. 查看当前 worktree：
   ```bash
   git status --porcelain
   git diff --stat
   ```
2. 有未提交改动时，按 `docs/development/git-commit-msg-rule.md` 生成提交信息：
   - 格式 `type(scope): 中文摘要`；摘要不超过 72 字符、不以句号结尾；
   - 一个 commit 尽量只做一类事；
   - 不加 `Co-Authored-By` 等 AI/工具署名；
   - 用户调用时已给出消息则直接使用。
3. 推荐先预览（只读，不 fetch/commit/push/reset）：
   ```bash
   node .claude/skills/commit-push-sync-worktrees/commit-push-sync-worktrees.mjs --dry-run --message "<msg>"
   ```
4. 正式执行：

   ```bash
   node .claude/skills/commit-push-sync-worktrees/commit-push-sync-worktrees.mjs --message "<msg>"
   ```

   - 没有未提交改动时省略 `--message`；
   - `--no-push` 只做本地提交/cherry-pick/同步，不推送。

5. 把脚本汇总转述给用户；有 `failed` 时先处理失败项，不要盲目重跑。

> 本 skill 不代跑 `pnpm check`；有代码改动时先按根 `CLAUDE.md` 完成验证。

## 脚本行为

1. **提交**：当前 worktree 有改动时 `git add -A` + `git commit`；有改动但没传 `--message` 会直接报错。
2. **对齐 main**：`git fetch origin main`；本地 main 落后则快进，领先则保留，分叉则把本地提交 `rebase --empty=drop` 到 `origin/main`（冲突则 abort 并报错）。
3. **cherry-pick**：当前分支不是 main 时，把 `main..HEAD` 的全部提交按时间顺序逐条 pick 到 main；空提交丢弃，冲突则 `cherry-pick --abort`，main 保持原状。
4. **push**：`git push origin main`，绝不 force。
5. **同步 worktree**：复刻 `extensions/git/src/gitGraphActions.ts` 的 `syncWorktreesToBranch` 非 force 语义：
   - 有未提交改动或进行中操作（rebase/merge/cherry-pick/revert/bisect）的 worktree 跳过；
   - 仅当 `main..HEAD` 的每个 subject 都已出现在 main 自 merge-base 以来的历史中，才 `git reset --hard main`；
   - 有 `.gitmodules` 时执行 `git submodule update --init --recursive`；
   - 不 stash、不 clean、不 force push、不触碰脏 worktree。
6. **main 持有者**：main 被另一个 worktree 检出且有未提交改动时直接中止；main 未被任何 worktree 检出时用临时 worktree 完成 rebase/pick，结束后删除。

## 退出码

- `0`：提交、对齐、pick、push 成功；worktree 的跳过不算失败。
- `1`：任一硬失败（前置条件、commit、fetch、rebase、cherry-pick、push、worktree reset/submodule）。

## 注意事项

- `--dry-run` 是只读预测，不执行 fetch/commit/pick/push/reset，因此无法提前发现 cherry-pick 冲突或真实的 `reset --hard` 失败；冲突会在正式执行时 abort 并保持 main 原状。
- 同步会丢弃“独有提交的 subject 已全部出现在 main”的干净 worktree 的原始提交（内容已在 main 上）；汇总会打印每棵树同步前 HEAD，可用 `git reflog` 恢复。
- 不支持含 merge commit 的分支：会提示先 squash/rebase。

## 关键参考路径

- `docs/development/git-commit-msg-rule.md`
- `extensions/git/src/gitGraphActions.ts`
- `extensions/git/src/worktreeSync.ts`
- `.claude/skills/commit-push-sync-worktrees/commit-push-sync-worktrees.mjs`
