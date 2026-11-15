# 交付到 main（Delivery）

把子 worktree（会话工作区）的提交交付到目标分支并推送的单一机制。手机收件箱的「交付到 main」
与命令行 `pnpm deliver` 共用同一套 git 扩展原语和同一把仓库锁，区别只在编排与交互：手机走
renderer 状态机，CLI 走无 UI 流水线。git 写操作都在内置 git 扩展里执行，main、renderer 与手机
不直接跑 git。

## 1. 架构分层

| 层       | 实现                                                                                                   | 职责                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎     | `extensions/git/src/delivery/deliveryGit.ts`、`deliveryLock.ts`、`deliveryTypes.ts`                     | inspect、begin、提交源 worktree、临时树 cherry-pick、前移 main、非 force push、worktree 同步、撤销、锁；错误码定义在 `deliveryTypes.ts` 的 `DeliveryErrorCode`            |
| 手机编排 | `apps/editor/src/renderer/services/delivery/sessionDeliveryService.ts`                                  | 交付 record 与状态机、提交信息 side task、冲突解决 agent、待推送确认、重启恢复、手机协议投影                                                                            |
| CLI 编排 | `extensions/git/src/delivery/` 下的 `deliveryPipeline.ts` / `deliveryCli.ts`                            | 无 UI 的顺序流水线：inspect + fetch → blockers → 加锁 + 心跳 → begin → 可选提交 → cherry-pick → 前移 main + push → 同步 worktree → 释放锁                                  |
| 入口     | 手机收件箱 / `pnpm deliver` / skill `deliver-to-main`                                                   | 手机与 CLI 可以同时被调用，但同一仓库同一时间只允许一个交付（见 §6）                                                                                                    |

两个入口的阶段差异：

| 能力           | 手机入口                                                        | CLI 入口                                                     |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| 脏源提交信息   | 基于原会话 fork 只读 side task 生成，失败即终止                  | 必须由 `--message` 提供；生成失败或缺失直接失败               |
| 冲突           | 创建一个受限的 internal 可写会话尝试解决一次，仍失败则终止       | 不自动解决：abort 临时树、main 不动，提示在源 worktree rebase |
| 推送确认       | 停在 `awaiting_push`，用户确认后才前移 main + push               | cherry-pick 成功即前移 main + push（`--dry-run` 只预览）      |
| 撤销           | 支持最近一次交付的 `undoDelivery`                                | 不提供；需要时手工 `git revert` 后推送                        |
| 重启恢复       | 依据持久化 record 与远端状态恢复                                 | 无 record；进程崩溃后先核对 main / 远端与残留临时 worktree，再重新执行 |

## 2. 安全不变量

- 绝不 force push；push 后必须 fetch 并解析远端引用，确认等于期望提交。
- 绝不 stash。
- 只有 main（目标分支）仍在调用方预期的提交、干净、无进行中操作时才移动它。
- main 必须由主 worktree 检出目标分支，且该分支有唯一 upstream；main 与 upstream 分叉直接拒绝
  （`main_diverged`），不做自动 rebase。
- 不支持合并提交；单次交付最多 200 个提交是手机入口的协议 / renderer 限制，CLI 不做该上限检查。
- 源 worktree 有未提交改动或进行中操作时不开始；CLI 要求先提交或传 `--message`。
- 临时 worktree 只承载 cherry-pick；冲突时 abort 并删除，main 保持原状。
- 清理阶段只 reset 仍在预期提交且干净的 main；push 尝试后不回滚，有独立提交的 worktree 绝不被
  reset（交付源按 §7 的契约例外）。
- worktree 同步只动干净、无进行中操作的树；其它 worktree 还必须满足祖先关系。
- 交付始终由用户显式触发：当前版本不做自动交付、自动 review，也不对分叉 worktree 自动 rebase。

## 3. 流水线阶段

1. **inspect + fetch**：识别仓库形态（普通仓库 / 链接 worktree / bare）、主 worktree、目标分支、
   remote 与唯一 upstream；读取源 worktree 的分支、HEAD、脏状态与进行中操作；计算
   `base..sourceHead` 的提交列表。可 fetch 时同时刷新 upstream。合并提交等直接形成 blocker；
   超过 200 个提交由手机入口在 preview 阶段拦截，CLI 不设该上限。
2. **blockers**：仓库形态不满足、main 脏 / 进行中 / 分叉、源缺失 / 进行中、没有待交付提交、
   upstream 缺失等都在写操作前拒绝。源目录就是主 worktree 时，正式交付在 blockers 之前直接返回
   `unsupported`；dry-run 仍打印计划，但在计划里标注不能正式交付。
3. **加锁 + 心跳**：获取 `<common-dir>/universe-editor/delivery.lock/owner.json` 目录锁
   （`mkdir` 原子创建，10 分钟 TTL + 心跳；同 host 死 PID 立即回收；owner 未写入的初始化窗口
   视为占用中）。手机与 CLI 共用这把锁，拿不到返回 `lock_held`。
4. **begin**：再次校验期望的 main / upstream / 源 HEAD 未移动，把 main 快进到 upstream
   （ff-only），记录交付前后的 head。
5. **提交源 worktree（可选）**：源有未提交改动时，手机由 side task 生成提交信息、renderer 调用
   `commitSource` 执行 `git add -A` + `git commit`（发送前后校验变更指纹）；side task 失败 /
   超时（90s）/ 空消息 / 指纹变化一律终止，不落固定文案、不继续 cherry-pick。CLI 使用
   `--message` 直接提交。无改动跳过。
6. **cherry-pick**：在主 worktree 同级创建 detached 临时 worktree
   `.universe-editor-delivery-worktrees/<id>`，从交付基点逐个 pick 源分支相对 main 的提交；空提交
   记入 `skippedEmpty`。冲突时：手机交给受限 internal 会话解决一次（只允许编辑冲突文件，校验修改
   集合、冲突标记与未合并路径后再 continue；该会话只对 cwd 内的
   `read/edit/delete/move/search` 选 `allow_once`，无一次性选项就拒绝，
   `execute/fetch/switch_mode/other` 一律拒绝，不写 `allow_always`，elicitation 直接 cancel）；
   CLI 直接 abort。任何解决失败都删除临时树、恢复 main，交付失败。
7. **前移 main + push**：写前校验 main 仍在目标分支、HEAD 仍是交付基点、干净、基点是临时树 HEAD
   的祖先；然后 `reset --hard` 到临时树 HEAD 并 `git push`（绝不 `--force`）。push 成功后 fetch
   并解析远端引用，必须等于期望提交；校验 fetch 失败会重试，仍无法确认时记为 `push_unverified`（推送多半
   已落地，不自动回滚，提示重试确认）。CLI 的重试先复检远端：远端已包含交付提交就直接进入同步；只有
   确认 fetch 成功且远端确实缺失时才再次前移 / 推送，并受总轮次与总耗时预算约束。手机在此前停在
   `awaiting_push`，由用户确认后才执行本阶段。
8. **同步 worktree**：删除临时树后，源 worktree 按契约重置到新 main；其它 worktree 只在 HEAD 是
   新 main 祖先时快进。脏、进行中操作、源 HEAD 已移动、非源 worktree 有独立提交都跳过并记录原因。
9. **释放锁**：成功或失败都释放；失败时按“先 abort pick、再在安全时 restore main、最后释放锁”
   的顺序清理。每一步独立捕获异常：失败详情写进 record（手机）或 `error.detail`（CLI），成功路径上的
   清理问题写入 `cleanupWarnings`；锁释放放在最内层 finally，释放失败也会进入结果而不是只写日志。

`--dry-run` 只执行第 1–2 步（含 fetch）并打印计划，不进入加锁、提交、pick、前移、push 与同步。

手机入口把流程拆成两段，命令只等同步准备、其余在 renderer 后台继续：

- `startDelivery` 同步执行 `_prepareStart`（session guard → `inspect` / expectation 校验 →
  blockers → `acquireLock` → 写 record + 启动心跳）后返回；`_runStart`（`begin` →
  `commitSource` → cherry-pick → `awaiting_push`）后台执行。逃逸异常走 `_failDeliverySafely`：
  基于**最新** record 隔离执行 `abortPick` / `restoreMain` / `releaseLock`，最终落 `failed`。
- `confirmDeliveryPush` 同步执行 `_prepareConfirmPush`（校验 → `_ensureLock` → 落 `pushing` 并
  等落盘）后返回；`_runPush`（`promoteAndPush` → 同步）后台执行。异常走 `_failPushSafely`：
  先经 `_remoteDeliveryState` 复核远端（扩展 RPC 可能在 push 已成功后 reject），`pushed` 转
  同步、`local_only` 回到 `awaiting_push`，否则释放锁并落 `failed`；整条路径保留临时 worktree
  供「重试」再次推送。同实例用 `_pushInFlight` 防止重复确认，跨窗口仍由目录锁兜底。

## 4. CLI：`pnpm deliver`

根 `package.json` 的 `deliver` script 调用 `extensions/git/scripts/deliver.mjs`，启动器用
esbuild 现场打包 `deliveryCli.ts` 后执行。

```text
pnpm deliver [--message "<msg>"] [--dry-run] [--json] [--target <branch>] [--cwd <path>] [--help]
```

| 选项                | 说明                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--message <msg>`   | 源 worktree 有未提交改动时必填；没有改动时省略。提交信息按 [提交信息规范](git-commit-msg-rule.md) 生成                  |
| `--dry-run`         | 只 fetch + inspect + blockers，打印计划（脏源按 +1 个待创建提交计数）；不提交、不移动本地分支、不同步 worktree          |
| `--json`            | 只在 stdout 输出 JSON 结果；人类可读日志与注意事项走 stderr（`--json --help` 输出 `{ usage }`）                         |
| `--target <branch>` | 目标分支，默认 main worktree 的当前分支（通常 `main`）                                                                  |
| `--cwd <path>`      | 交付源目录，默认调用者目录（`INIT_CWD`）；相对路径按 `INIT_CWD` 解析                                                    |
| `--help`            | 打印用法                                                                                                               |

在 workspace 子包目录内调用时使用 `pnpm -w deliver`（pnpm 默认只在当前包的 scripts 里找 `deliver`）。

CLI 在进入流水线前校验 `--message`：必须是已知 type 的 `type(scope): 摘要`、摘要 ≤72 字符、
不以句号结尾，且不含 AI/工具署名；不合法按参数错误返回 2。`--json` 下参数错误也输出 JSON
（`error.code = invalid_arguments`）。正式交付拒绝直接在主 worktree 发起（返回 `unsupported`，
检查发生在 blockers 之前）；`--dry-run` 仍打印计划，但会在注意事项里标注不能正式交付。

`--json` 的正式结果包含 `exitCode`、`ok`、`phases`、`plan`（dry-run / 失败时可用）、`picked`
（cherry-pick 到临时树的提交；推送成功前不属于 main）、`delivered`（推送成功后真正落到 main 的提交）、
`skippedEmpty`、`pushedSha`、`mainHead`、`worktrees`、`cleanupWarnings` 与可选的 `error`。
锁 owner 只输出 pid / hostname / label，不输出 token。

正式执行会在加锁前打印计划注意事项（例如 main 有未推送提交会随本次 push 一并发布）；`--json` 下
这些注意事项与阶段日志走 stderr，stdout 始终只有最终 JSON。

退出码：

- `0`：交付成功；worktree 跳过（脏 / 进行中 / 有独立提交）不算失败。
- `1`：交付失败（前置条件、commit、fetch、cherry-pick、push 等；含脏源未传 `--message` 时的
  `invalid_message`）；也包括推送成功但某个 worktree
  同步结果为 `failed`（`skipped_*` 仍算成功），此时汇总会提示“推送已落地，仅同步失败，可手动处理”。
- `2`：参数解析或提交信息格式错误（未知选项、位置参数、缺少选项值、不合规的 `--message`）。

常用流程：

```bash
pnpm deliver --dry-run --message "feat(editor): 增加示例命令"
pnpm deliver --message "feat(editor): 增加示例命令"
```

没有未提交改动时：

```bash
pnpm deliver
```

失败处理：

- `main_diverged`：main 与 upstream 已分叉，先人工决定合并 / rebase 方式并同步远端，不要直接重跑。
- `main_moved` / `head_mismatch` / `upstream_changed`：预览后 main、源 worktree 或 upstream 移动了；
  重新 `--dry-run` 确认当前状态后再交付。
- `lock_held`：同仓库已有手机交付或另一个 CLI 在跑；等它结束或确认 owner 已失效后再试，不要手工删锁。
- `conflict`：临时树已 abort、main 未动。在源 worktree 把分支 rebase 到 upstream 后重新预览 / 交付。
- `temp_worktree_failed`：临时 worktree 创建或读取失败；检查 main worktree 同级的
  `.universe-editor-delivery-worktrees/` 是否有残留，以及磁盘空间 / 权限。
- `push_failed` / `push_unverified`：main 可能已停在交付提交。先核对 main 与远端；远端缺失时可在
  main worktree 执行 `git push <remote> <branch>`，不要盲目重新交付。`push_unverified` 表示推送多半
  已落地、CLI 未能在时限内确认，先看远端再决定是否重试。
- `nothing_to_deliver` / `nothing_to_commit`：源没有待交付提交或没有可提交改动，确认是否调用了错误的
  `--cwd`；源目录若是 main worktree 会先得到 `unsupported`。

本 CLI 不代跑 `pnpm check` 或测试；有代码改动时先按根 `CLAUDE.md` 完成验证。

## 5. 撤销（仅手机入口）

`undoDelivery` 只允许最近一次交付：

- 未推送：main 仍在期望 head 且干净时恢复到交付前。
- 已推送：要求 main / upstream 仍等于 `pushedSha`，按逆序 `git revert --no-edit`；冲突则
  `revert --abort` 并失败。成功后重新同步 worktree，绝不 force push。
- 撤销失败记录 `failedAction:'undo'`，手机「重试」继续撤销而不是转成重新交付。

## 6. 互斥与并发

同一仓库同一时间只允许一个交付。锁位于 `<common-dir>/universe-editor/delivery.lock/`，所有
worktree 与编辑器窗口共享：

- `mkdir` 是原子抢占步骤，随后写入 `owner.json`（token、pid、hostname、心跳时间）。
- 心跳周期续期（CLI 每 60 秒），超过 10 分钟未续期视为过期；同 host 上 PID 已死的 owner 立即视为过期；其它 host 依赖 TTL。
- 释放时校验 token，绝不删除别人的锁；owner 尚未写入的刚创建目录视为正在初始化，不清理。
- 锁 owner 记录窗口实例 id：重启后的 record 不复用持久化 token 直接心跳，而是重新尝试 acquire
  （被活窗口持有时保持 busy）。
- 手机侧另有两层辅助防线：renderer 内存 record（同窗口重复启动）与 hub 跨窗口探测
  （`getDeliveryContext` / `listActiveDeliveries`）；真正跨进程的互斥仍由目录锁保证。
- 交付期间（无论手机还是 CLI 持锁），手机对**同仓库**的 `sendPrompt` / `newSession` /
  `deleteSession` 都会被仓库级 `delivery_busy` 拒绝，避免 agent 在交付中途改写源树；`startDelivery`
  遇到锁被占用时返回带 owner 信息的 `lock_held` / `delivery_busy`。
- CLI 只有目录锁这一层；遇到手机正在交付时同样返回 `lock_held`，反之 CLI 持锁期间手机也会被
  `delivery_busy` 拒绝。

## 7. 失败、恢复与 push 校验

任何一步失败都终止并清理：删除临时树；只有 main 仍在预期提交且干净时才 reset 恢复；绝不
stash、绝不 reset 有独立提交的 worktree、绝不 force push。

手机入口有持久化 record 与重启恢复：

- `awaiting_push` 继续持有锁。
- `pushing` 只信远端状态：远端已是临时树 HEAD 则转同步；本地 main 已是该提交但远端没有则回到
  `awaiting_push`；其余失败且不回滚。后台 push 的异常收尾复用同一判断，因此运行中出错与重启
  恢复结论一致。
- 其它中间态 abort 临时树 + 恢复 main + 失败。源会话不在 live 时按 durable id 非激活恢复，
  让收件箱行重新出现。

CLI 没有持久化 record；进程崩溃后不要直接重跑：先检查 main 是否已停在交付提交、远端是否已有该提交，
以及 `.universe-editor-delivery-worktrees/` 下是否有残留临时 worktree（确认没有交付在运行后可手工删除）。
锁由 TTL / 死 PID 回收接管；核对清楚后再重新预览 / 交付。

## 8. worktree 同步语义对照

仓库里有三套同步规则，按“谁发起”区分：

| 场景                   | 实现                                                                       | 判定                                                                                                   | 动作                                                               |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Git Graph 手动同步     | `extensions/git/src/gitGraphActions.ts` 的 `syncWorktreesToBranch`          | 用户显式操作；默认要求干净，且目标分支历史（自 merge-base 起）已包含该树独有的每个 subject             | 不满足则 `skippedUnmatchedMessages`；满足则 `reset --hard` 并更新 submodule |
| pull 后自动同步        | `extensions/git/src/worktreeSync.ts` 的 `syncWorktreesToCommit`             | 自动运行；干净、无进行中操作，且 HEAD 是新提交的严格祖先                                               | 快进 `reset --hard`（分支 worktree 的分支引用随之前移），更新 submodule；否则跳过 |
| 交付后同步             | `extensions/git/src/delivery/deliveryGit.ts` 的 `syncWorktreesDelivery`     | 源 worktree 必须仍是 cherry-pick 使用的 HEAD（脏源提交后的 HEAD）、干净、无进行中；其它 worktree 必须干净、无进行中且 HEAD 是 newHead 祖先 | 源按契约 reset；其它快进；脏 / 进行中 / 分叉分别跳过；更新 submodule |

选择理由：

- **手动同步按 subject**：用户明确要求把所有 worktree 对齐到目标分支，subject 覆盖能处理
  cherry-pick / squash 后“内容已在目标分支、但提交对象不同”的情况；同时仍拒绝会丢弃真实独立
  提交的树。
- **pull 后自动同步按祖先**：没有用户显式操作，任何比祖先更松的判定都可能让 `reset --hard`
  丢掉只是内容等价的提交对象；因此只做严格快进。
- **交付同步是混合规则**：源 worktree 的提交刚被 cherry-pick 到 main，旧 HEAD 一定不是新 main
  的祖先，所以源按“cherry-pick 使用的 HEAD + 干净 + 无进行中”做契约式 reset；其它 worktree 没有
  参与交付，仍按祖先快进，避免自动丢弃它们的独立提交。

同步跳过不是交付失败：手机记录为 `skipped_dirty` / `skipped_in_progress` / `skipped_diverged` /
`skipped_source_changed`，CLI 在汇总中列出并以退出码 0 结束。CLI 的同步结果为 `failed` 时（例如读不到
HEAD / status 或 reset 失败）推送已经落地，CLI 以退出码 1 结束并提示可手动处理，不应重新交付。

## 9. 错误码

完整定义在 `extensions/git/src/delivery/deliveryTypes.ts` 的 `DeliveryErrorCode`。常用分组：

- 仓库形态：`not_a_repository`、`not_a_worktree_repository`、`bare_repository`、
  `no_main_worktree`、`detached_main`、`detached_source`、`target_branch_mismatch`、
  `no_upstream`、`no_remote`。
- 状态与并发：`main_dirty`、`main_in_progress`、`main_diverged`、`source_missing`、
  `source_dirty`、`source_in_progress`、`nothing_to_deliver`、`nothing_to_commit`、
  `merge_commit_unsupported`、`lock_held`、`lock_lost`、`unsupported`。
- 执行期：`upstream_changed`、`main_moved`、`head_mismatch`、`source_changed`、`conflict`、
  `temp_worktree_failed`、`fetch_failed`、`git_failed`、`push_failed`、`push_unverified`、
  `remote_moved`、`remote_diverged`。
- 输入：`invalid_message`、`invalid_branch`。

手机网关把引擎错误归并为 `delivery_busy` / `delivery_not_found` / `delivery_conflict` /
`delivery_unsupported` 四个协议错误码，见 [mobile-gateway.md](mobile-gateway.md) 的命令与错误码表。

## 10. 相关路径

- 手机协议、命令表、超时与 inbox 投影：[mobile-gateway.md](mobile-gateway.md)
- 提交信息规范：[git-commit-msg-rule.md](git-commit-msg-rule.md)
- 开发者入口 skill：[.claude/skills/deliver-to-main/SKILL.md](../../.claude/skills/deliver-to-main/SKILL.md)
- 引擎测试：`extensions/git/src/__tests__/deliveryGit.test.ts`；renderer 状态机测试：
  `apps/editor/src/renderer/services/delivery/__tests__/sessionDeliveryService.test.ts`
