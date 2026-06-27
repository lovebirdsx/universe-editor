---
name: update-claude-agent-acp
description: 更新内置 ACP agent fork（vendor/claude-agent-acp，我们自维护的 git submodule），把上游 agentclientprotocol/claude-agent-acp 的新提交合并进来并重建发布产物。当用户说“更新 claude-agent-acp / 合并上游修改 / 同步 acp agent / 升级内置 agent / 升级 claude-agent-sdk（经由该 fork）”时使用。聚焦“rebase fork 自定义提交到上游 → 解决已知冲突套路 → 构建测试 → push fork → 主仓库提交 submodule 指针”的可复用流程；具体冲突由 agent 当场判断。
disable-model-invocation: true
---

# 更新 claude-agent-acp（合并上游 + 重建产物）

`vendor/claude-agent-acp` 是我们自维护的 fork，**git submodule，不在 pnpm workspace 内，用自带 npm 工具链独立构建**（见根 CLAUDE.md）。上游是 `https://github.com/agentclientprotocol/claude-agent-acp.git`（npm 包 `@agentclientprotocol/claude-agent-acp`，作者 Zed Industries）。我们在某个上游 release 之上叠了若干自定义提交（esbuild 单文件打包、AskUserQuestion extMethod、工具错误上下文、listSessions 时间戳、electron-builder ESM 修复、上下文计算修复等）。

核心套路：**确认分叉点 → 与用户敲定 rebase/merge 与推送范围 → 在工作分支 rebase 自定义提交到上游最新 → 按已知套路解决冲突 → 重新生成 lock + 构建 + 测试 fork → push fork → 主仓库 `pnpm agent:build` + `pnpm check` → 开分支提交 submodule 指针并 push**。

> ⚠️ 第一原则：**fork 的自定义提交必须完整保留在历史顶部，且其承载的功能（尤其 AskUserQuestion 走 extMethod）不能被上游同名实现覆盖掉**。主仓库 renderer 端依赖这些行为；合并时优先“两条路并存”，而不是二选一。

## 流程

### 0. 摸清现状（只读）
全部用 `git ls-remote` / `gh api` 探查，**不要**在 plan/调查阶段改动 submodule：
```bash
cd vendor/claude-agent-acp
git remote -v                 # 通常只有 origin = 我们的 fork(lovebirdsx/...)，无 upstream
git log --oneline -8          # 顶部 N 个是我们的自定义提交，其下是某个上游 release（基线）
grep -A3 -i repository package.json   # 确认上游仓库 URL
git rev-parse main HEAD origin/main   # ⚠️ submodule 常是 detached HEAD；本地 main 分支可能已过时，别用它做基线
```
用 `gh` 确认上游含我们的基线、以及基线后有多少新提交（这步决定工作量）：
```bash
gh api repos/agentclientprotocol/claude-agent-acp/commits/<基线sha> --jq '.commit.message'   # 确认线性分叉
gh api 'repos/agentclientprotocol/claude-agent-acp/compare/<基线>...<上游HEAD或main>' --jq '.ahead_by,.behind_by,.total_commits'
git diff --stat <基线>..<我们的HEAD>   # 我们改了哪些文件 → 预判冲突面
```
> 注：package.json 内部 `version`（如 0.46.0）与上游 git **tag**（可能是 v0.x 旧体系）不是一回事，版本号对不上是正常的，不影响合并。

### 1. 与用户敲定两个决策（AskUserQuestion）
- **rebase vs merge**：默认推荐 **rebase**（历史线性、自定义提交清晰留顶、下次再合更省事；代价是重写历史需 `--force-with-lease` push fork）。
- **推送范围**：默认推荐**全部推送提交**（push fork + 主仓库提交 submodule 指针）。CLAUDE.md 规定提交/推送只在用户要求时做，所以必须先确认。

### 2. 配置 upstream 并 rebase
```bash
cd vendor/claude-agent-acp
git remote add upstream https://github.com/agentclientprotocol/claude-agent-acp.git
git fetch upstream
git switch -C update-upstream <我们最新的HEAD/origin-main的sha>   # 基于最新 fork 提交，不是过时的本地 main
git rebase --onto upstream/main <基线sha>                        # 把 基线..HEAD 的自定义提交重放到上游最新
```
逐个提交解决冲突（见下「冲突套路」），每次 `git add <file>` 后 `GIT_EDITOR=true git rebase --continue`。

### 3. 重新生成 lock + 构建 + 测试 fork
rebase 时 `package-lock.json` 冲突按下面套路取上游侧；rebase 完成后必须重新生成以纳入我们的依赖：
```bash
npm install            # 重新生成 package-lock.json（纳入 esbuild 等我方 devDep）
npm run build          # esbuild → dist/index.js（确认末行打印 SDK 版本）
npm run typecheck      # tsc --noEmit
npm test               # vitest；仅截错误。已知 2 个 Windows 路径测试会失败（见案例 1），非回归
```
把这些“后处理改动”用 **fixup + autosquash** 并入逻辑所属提交（保持历史干净）：
```bash
git add package-lock.json && git commit --fixup=<esbuild提交sha>
git add <改过的测试文件> && git commit --fixup=<对应功能提交sha>
GIT_SEQUENCE_EDITOR=: GIT_EDITOR=true git rebase -i --autosquash <上游HEAD sha>
```

### 4. 同步 main 并 push fork
```bash
git branch -f main update-upstream    # 可能报 worktree 警告，但若随后 rev-parse 确认 main==HEAD==目标 即成功
git switch main
git push --force-with-lease origin main
git branch -d update-upstream         # 清理临时分支
# 收尾核对：git rev-parse HEAD main origin/main 应全相等
```

### 5. 主仓库重建产物 + 验证
```bash
cd <repoRoot>
pnpm agent:build      # = vendor-install(npm ci 生产依赖) + npm run build；重建 vendor/.../{dist,node_modules}
pnpm check            # lint + typecheck + test，仅截错误
```
> `agent:build` 会把 fork 的 `node_modules` prune 成**生产依赖**，之后想再在 fork 跑 `npm test` 需先 `npm install` 重装 devDeps。
> `pnpm check` 偶发的 `FileWatcherMainService` debounce / `DiffEditor getPosition` 失败是主仓库既有环境 flake，与本次无关——重跑即绿（可单独 `pnpm -w run test` 复核）。

### 6. 提交主仓库 submodule 指针
```bash
git switch -c chore/update-claude-agent-acp     # 当前多在 main（默认分支），先开分支
git diff --submodule=log vendor/claude-agent-acp   # 核对：顶部我方提交 + 其下上游新提交
git add vendor/claude-agent-acp
git commit   # chore(agent): 更新 claude-agent-acp 至上游 <版本> (sdk <x.y.z>)，正文记冲突处理 + Co-Authored-By
git push -u origin chore/update-claude-agent-acp
```

## 冲突套路（按文件）

- **`package-lock.json`**：**不要手动解**。rebase 中冲突时 `git checkout --ours package-lock.json && git add`（rebase 里 `--ours`=上游侧），rebase 全部完成后 `npm install` 一次性重生成。
- **`package.json`**：保留我们的改动（`build` 改成 `node esbuild.config.mjs`、新增 `typecheck`、devDep 加 `esbuild`），`version` 与 SDK/依赖版本取上游。⚠️ Edit 解冲突时**当心重复 key**：冲突标记外的公共行（如 `@eslint/js`）别在 new_string 里再写一遍，否则产生重复键（esbuild 会 warn，`npm install`/typecheck 不报错，易漏）。
- **`esbuild.config.mjs` / `src/interactive.ts`**：我们新增、上游无 → 一般无冲突，直接保留。
- **`src/acp-agent.ts` / `src/tools.ts`**：双方都大改，需语义合并（见案例 2、3）。

## 案例库

> 每条：现象 → 根因 → 解法 → 锚点。新经验往下追加。

### 案例 1：fork `npm test` 两个 toDisplayPath 测试在 Windows 必失败（非回归）
- **现象**：`src/tests/acp-agent.test.ts` 的 `should use relative path in title when cwd is provided` 与 `toDisplayPath > should relativize paths inside cwd…` 失败，`Expected "src/main.ts" / Received "src\main.ts"`。
- **根因**：上游 `src/tools.ts` `toDisplayPath` 用 `path.relative` 返回平台分隔符（Windows `\`），但测试硬编码期望 `/`。上游自带（基线即有），CI 在 Linux/Mac 跑未暴露，与我们改动无关。
- **解法**：**直接忽略**，不改上游逻辑（保持合并纯粹）。不影响主仓库 `pnpm check`（vendor 不在 workspace）。已记入记忆 `acp-fork-windows-path-test-flake`。
- **锚点**：`vendor/claude-agent-acp/src/tools.ts`（`toDisplayPath`）。

### 案例 2：AskUserQuestion — 上游 elicitation 实现与我们的 extMethod 实现冲突（两路并存）
- **现象**：`src/acp-agent.ts` 在 `disallowedTools` 处冲突；上游用 `ElicitationSupport` + form-elicitation 渲染 AskUserQuestion，并在无 form 时 `disallowedTools = ["AskUserQuestion"]` 禁用它；我们的提交则改为“通过 extMethod 支持、不再 force-disable”。`src/tools.ts` 的 toolInfo 也双方都实现了。
- **根因**：主仓库 renderer client **只走 extMethod 路径，不声明 `elicitation` 能力**（`acpClientService.ts` 的 `clientCapabilities._meta['universe-editor/ask_user_question']: true`，无 `elicitation`）。若采用上游“无 form 就禁用”的逻辑，我们的 extMethod 路径会被掐断。
- **解法**：**两条路并存**。保留 `elicitationSupport` 定义（后续 `onElicitation` 仍要用 form/url 能力）；**删除** `const disallowedTools = elicitationSupport.form ? [] : [...]` 局部变量（合并后 SDK options 用 `disallowedTools: [...(userProvidedOptions?.disallowedTools || [])]`，不再引用它，留着会成 unused）。`canUseTool` 里上游的 `if (AskUserQuestion && clientCapabilities?.elicitation?.form) return handleAskUserQuestion(...)` 在前、我们的 extMethod 块在后，天然形成“form 优先、extMethod 兜底”。`tools.ts` 的 toolInfo 取上游版本（用规范的 `AskUserQuestionInput` 类型）。
- **锚点**：`src/acp-agent.ts`（`canUseTool` 的 AskUserQuestion 分支、`createSession` 的 `elicitationSupport`/`disallowedTools`/`onElicitation`）、`src/tools.ts`（`AskUserQuestion` case）、主仓库 `apps/editor/src/renderer/services/acp/acpClientService.ts`（能力声明 + extMethod 实现）、`acpSessionService.ts`（`onAskUserQuestion`）。

### 案例 3：工具错误上下文 withToolUseContext 撞上游新的 failActive 控制流
- **现象**：`src/acp-agent.ts` 多处 `is_error` 分支冲突——上游把 `throw RequestError.internalError(...)` 改成了 `failActive(...); break;`，而我们这几处加了 `withToolUseContext(msg, lastToolUse)` 包装。
- **根因**：两边改同几行，一个改控制流、一个改错误信息内容。
- **解法**：合并 = **上游的 `failActive(...) + break` 控制流** 包住 **我们的 `withToolUseContext(...)` 参数**。逐个冲突块连同其后的闭合 `);` 一起替换以保证括号配平（多个块文本相同，别用 replace_all，用更大上下文一次性 Edit）。`lastToolUse` 声明与 streaming 累积逻辑通常能自动合并。
- **锚点**：`src/acp-agent.ts`（turn 主循环里 `error_during_execution` / `error_max_turns` 等 `message.is_error` 分支；`failActive` 定义、`withToolUseContext` 函数）。

### 案例 4：自定义测试用了不存在的 cwd，被上游新增 validateCwd 拦截
- **现象**：`create-session-options.test.ts` 某用例 `expected [] to include 'AskUserQuestion'`，实为 `RequestError: cwd does not exist: /test`。
- **根因**：上游新增 `validateCwd`（`fs.stat(cwd)` 失败即 `throw`）。我们早先写的测试用了不存在的 `cwd: "/test"`，在上游加校验后失效。
- **解法**：把测试里的 `cwd: "/test"` 改成 `process.cwd()`。同时这些 elicitation 断言需随案例 2 的设计更新——“无 elicitation 能力 → AskUserQuestion 仍启用（extMethod 兜底）、onElicitation undefined”“url-only → 不 disable、onElicitation 是 function”，即把上游的 `toContain("AskUserQuestion")` 反转为 `not.toContain`。
- **锚点**：`src/tests/create-session-options.test.ts`（`describe("elicitation")` 块、`validateCwd` 在 `src/acp-agent.ts`）。

### 案例 5：上游 #790「Update to new ACP SDK patterns」把 client 抽象成窄接口 AcpClient，导致 extMethod 静默丢失
- **现象**：rebase 全程**零手动冲突**（acp-agent.ts/tools.ts 都自动合并成功），但 `npm run typecheck` 报 `src/acp-agent.ts: Property 'extMethod' does not exist on type 'AcpClient'`。`canUseTool` 里我方 `this.client.extMethod(ASK_USER_QUESTION_METHOD, ...)` 调用代码完整保留，但调用的方法没了。
- **根因**：基线（#783）里 `this.client` 直接是 SDK 的 `AgentSideConnection`（自带 `extMethod`/`extNotification`）。上游 #790 把它抽象成自定义窄接口 `AcpClient`（line ~610）+ `ClientConnection implements AcpClient`（底层换成 `AgentContext` 的 `ctx.request`/`ctx.notify`）。git 三方合并能把我方的**调用点**保留，但我方当初随 extMethod 一起加的接口/实现是在旧结构上的，被上游的新接口整体替换 → 接口里只剩上游迁移过去的 `extNotification`，`extMethod` 凭空消失。**这类“接口被重写、调用点存活”的丢失靠冲突标记发现不了，必须靠 typecheck 兜底**。
- **解法**：在 `interface AcpClient` 补 `extMethod(method: string, params: Record<string, unknown>): Promise<unknown>;`，在 `class ClientConnection` 补 `extMethod(method, params) { return this.ctx.request(method, params); }`（与紧邻的 `extNotification`→`ctx.notify` 对称；`ctx.request` 接受任意字符串 method，无需 `methods.client.*` 常量）。改完 typecheck 即过。该改动用 `git commit --fixup=<AskUserQuestion提交sha>` 并入命脉提交。
- **教训**：**rebase 零冲突 ≠ 语义正确**。上游做接口/抽象层重构时，我方挂在旧结构上的“接口声明 + 实现”可能被整体顶替而只留调用点。第 3 步的 `npm run typecheck` 是必跑的安全网，别因为 rebase 顺利就跳过。
- **锚点**：`src/acp-agent.ts`（`interface AcpClient` line ~610、`class ClientConnection` 的 `extNotification`/`extMethod`、`canUseTool` 的 `extMethod` 调用 line ~2647）。

## 速记
1. 调查阶段全程只读（`git ls-remote` / `gh api`），别在 plan mode 改 submodule。
2. submodule 是 detached HEAD；**本地 `main` 分支常已过时**，rebase 基线和工作分支都用 `origin/main`/当前 HEAD 的真实 sha，别信本地 main。
3. rebase 里 `--ours` = 被 rebase 到的上游侧、`--theirs` = 正在重放的我方提交（与平时相反）。`package-lock.json` 取 `--ours` 后用 `npm install` 重生成。
4. AskUserQuestion 是本 fork 的命脉：主仓库走 extMethod、不支持 elicitation。合并时**两路并存**，绝不让上游的 form-only 逻辑禁用它（案例 2）。
5. package.json 解冲突当心**重复 key**（公共行别在 new_string 重写）；version/依赖取上游、build/esbuild 取我方。
6. 后处理改动（重生成的 lock、适配的测试）用 `git commit --fixup=<sha>` + `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash` 并入逻辑所属提交。
7. fork 测试已知 2 个 Windows toDisplayPath 失败是上游缺陷（案例 1），别误判为回归；主仓库 `pnpm check` 的 FileWatcher/DiffEditor/`Channel closed`(IPC) 偶发失败是既有 flake，单独 `pnpm --filter @universe-editor/editor run test` 重跑即绿。
8. `pnpm agent:build` 会 prune fork 到生产依赖；之后要再跑 fork 测试先 `npm install`。
9. 全流程末尾用 `git diff --submodule=log vendor/claude-agent-acp` 核对“我方提交在顶 + 上游新提交在下”，再提交主仓库指针。
10. **rebase 零冲突 ≠ 语义正确**：上游做接口/抽象层重构时，我方挂在旧结构上的接口声明+实现可能被整体顶替而只留调用点（案例 5）。第 3 步 `npm run typecheck` 是必跑安全网，别因 rebase 顺利就跳过。

## 关键参考路径
- 根 `CLAUDE.md`「内置 ACP agent」段 + `scripts/release/{vendor-install.mjs,runtime-resources.mjs}`、`package.json` 的 `agent:build`
- `vendor/claude-agent-acp/src/{acp-agent.ts,tools.ts,interactive.ts,elicitation.ts}`
- 主仓库 `apps/editor/src/renderer/services/acp/{acpClientService.ts,acpSessionService.ts,acpSession.ts}`、`workbench/agents/QuestionCard.tsx`
- 记忆 `acp-fork-windows-path-test-flake`

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件
