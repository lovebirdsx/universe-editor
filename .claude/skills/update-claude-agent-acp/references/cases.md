# update-claude-agent-acp 案例库

> 每条：现象 → 根因 → 解法 → 锚点。新经验往下追加，并在 `SKILL.md` 的「案例索引」补一行速查。

## 案例 1：fork `npm test` 两个 toDisplayPath 测试在 Windows 必失败（非回归）
- **现象**：`src/tests/acp-agent.test.ts` 的 `should use relative path in title when cwd is provided` 与 `toDisplayPath > should relativize paths inside cwd…` 失败，`Expected "src/main.ts" / Received "src\main.ts"`。
- **根因**：上游 `src/tools.ts` `toDisplayPath` 用 `path.relative` 返回平台分隔符（Windows `\`），但测试硬编码期望 `/`。上游自带（基线即有），CI 在 Linux/Mac 跑未暴露，与我们改动无关。
- **解法**：**直接忽略**，不改上游逻辑（保持合并纯粹）。不影响主仓库 `pnpm check`（vendor 不在 workspace）。已记入记忆 `acp-fork-windows-path-test-flake`。
- **锚点**：`vendor/claude-agent-acp/src/tools.ts`（`toDisplayPath`）。

## 案例 2：AskUserQuestion — 上游 elicitation 实现与我们的 extMethod 实现冲突（两路并存）
- **现象**：`src/acp-agent.ts` 在 `disallowedTools` 处冲突；上游用 `ElicitationSupport` + form-elicitation 渲染 AskUserQuestion，并在无 form 时 `disallowedTools = ["AskUserQuestion"]` 禁用它；我们的提交则改为“通过 extMethod 支持、不再 force-disable”。`src/tools.ts` 的 toolInfo 也双方都实现了。
- **根因**：主仓库 renderer client **只走 extMethod 路径，不声明 `elicitation` 能力**（`acpClientService.ts` 的 `clientCapabilities._meta['universe-editor/ask_user_question']: true`，无 `elicitation`）。若采用上游“无 form 就禁用”的逻辑，我们的 extMethod 路径会被掐断。
- **解法**：**两条路并存**。保留 `elicitationSupport` 定义（后续 `onElicitation` 仍要用 form/url 能力）；**删除** `const disallowedTools = elicitationSupport.form ? [] : [...]` 局部变量（合并后 SDK options 用 `disallowedTools: [...(userProvidedOptions?.disallowedTools || [])]`，不再引用它，留着会成 unused）。`canUseTool` 里上游的 `if (AskUserQuestion && clientCapabilities?.elicitation?.form) return handleAskUserQuestion(...)` 在前、我们的 extMethod 块在后，天然形成“form 优先、extMethod 兜底”。`tools.ts` 的 toolInfo 取上游版本（用规范的 `AskUserQuestionInput` 类型）。
- **锚点**：`src/acp-agent.ts`（`canUseTool` 的 AskUserQuestion 分支、`createSession` 的 `elicitationSupport`/`disallowedTools`/`onElicitation`）、`src/tools.ts`（`AskUserQuestion` case）、主仓库 `apps/editor/src/renderer/services/acp/acpClientService.ts`（能力声明 + extMethod 实现）、`acpSessionService.ts`（`onAskUserQuestion`）。

## 案例 3：工具错误上下文 withToolUseContext 撞上游新的 failActive 控制流
- **现象**：`src/acp-agent.ts` 多处 `is_error` 分支冲突——上游把 `throw RequestError.internalError(...)` 改成了 `failActive(...); break;`，而我们这几处加了 `withToolUseContext(msg, lastToolUse)` 包装。
- **根因**：两边改同几行，一个改控制流、一个改错误信息内容。
- **解法**：合并 = **上游的 `failActive(...) + break` 控制流** 包住 **我们的 `withToolUseContext(...)` 参数**。逐个冲突块连同其后的闭合 `);` 一起替换以保证括号配平（多个块文本相同，别用 replace_all，用更大上下文一次性 Edit）。`lastToolUse` 声明与 streaming 累积逻辑通常能自动合并。
- **锚点**：`src/acp-agent.ts`（turn 主循环里 `error_during_execution` / `error_max_turns` 等 `message.is_error` 分支；`failActive` 定义、`withToolUseContext` 函数）。

## 案例 4：自定义测试用了不存在的 cwd，被上游新增 validateCwd 拦截
- **现象**：`create-session-options.test.ts` 某用例 `expected [] to include 'AskUserQuestion'`，实为 `RequestError: cwd does not exist: /test`。
- **根因**：上游新增 `validateCwd`（`fs.stat(cwd)` 失败即 `throw`）。我们早先写的测试用了不存在的 `cwd: "/test"`，在上游加校验后失效。
- **解法**：把测试里的 `cwd: "/test"` 改成 `process.cwd()`。同时这些 elicitation 断言需随案例 2 的设计更新——“无 elicitation 能力 → AskUserQuestion 仍启用（extMethod 兜底）、onElicitation undefined”“url-only → 不 disable、onElicitation 是 function”，即把上游的 `toContain("AskUserQuestion")` 反转为 `not.toContain`。
- **锚点**：`src/tests/create-session-options.test.ts`（`describe("elicitation")` 块、`validateCwd` 在 `src/acp-agent.ts`）。

## 案例 5：上游 #790「Update to new ACP SDK patterns」把 client 抽象成窄接口 AcpClient，导致 extMethod 静默丢失
- **现象**：rebase 全程**零手动冲突**（acp-agent.ts/tools.ts 都自动合并成功），但 `npm run typecheck` 报 `src/acp-agent.ts: Property 'extMethod' does not exist on type 'AcpClient'`。`canUseTool` 里我方 `this.client.extMethod(ASK_USER_QUESTION_METHOD, ...)` 调用代码完整保留，但调用的方法没了。
- **根因**：基线（#783）里 `this.client` 直接是 SDK 的 `AgentSideConnection`（自带 `extMethod`/`extNotification`）。上游 #790 把它抽象成自定义窄接口 `AcpClient`（line ~610）+ `ClientConnection implements AcpClient`（底层换成 `AgentContext` 的 `ctx.request`/`ctx.notify`）。git 三方合并能把我方的**调用点**保留，但我方当初随 extMethod 一起加的接口/实现是在旧结构上的，被上游的新接口整体替换 → 接口里只剩上游迁移过去的 `extNotification`，`extMethod` 凭空消失。**这类“接口被重写、调用点存活”的丢失靠冲突标记发现不了，必须靠 typecheck 兜底**。
- **解法**：在 `interface AcpClient` 补 `extMethod(method: string, params: Record<string, unknown>): Promise<unknown>;`，在 `class ClientConnection` 补 `extMethod(method, params) { return this.ctx.request(method, params); }`（与紧邻的 `extNotification`→`ctx.notify` 对称；`ctx.request` 接受任意字符串 method，无需 `methods.client.*` 常量）。改完 typecheck 即过。该改动用 `git commit --fixup=<AskUserQuestion提交sha>` 并入命脉提交。
- **教训**：**rebase 零冲突 ≠ 语义正确**。上游做接口/抽象层重构时，我方挂在旧结构上的“接口声明 + 实现”可能被整体顶替而只留调用点。第 3 步的 `npm run typecheck` 是必跑的安全网，别因为 rebase 顺利就跳过。
- **锚点**：`src/acp-agent.ts`（`interface AcpClient` line ~610、`class ClientConnection` 的 `extNotification`/`extMethod`、`canUseTool` 的 `extMethod` 调用 line ~2647）。

## 案例 6：上游 #835「idle without result」校验撞我方 compact_boundary 测试
- **现象**：rebase 完成后 `npm test`，我方「上下文计算」提交的 `usage_update computation > compact_boundary falls back to rawMaxTokens when maxTokens is missing` 失败，报 `RequestError: Internal error: The turn ended without a result: the agent went idle while this prompt was still in flight`（来自 `acp-agent.ts` 的 `failActive(RequestError.internalError(errorKindData("no_result"), TURN_NO_RESULT_MESSAGE))`）。**这是自动合并零冲突、靠 `npm test` 才暴露的语义回归**（同案例 5 的教训：rebase 顺利 ≠ 正确）。
- **根因**：上游 #835/#825「Handle SDK idle turns without results」在 consumer 主循环新增逻辑——一个 turn 走到 `session_state_changed: idle` 却没有先收到 `result`，就判定为「stream 中途掉线/turn 被遗弃」并 `failActive(no_result)`，让 `prompt()` 抛错终结。我方那条 compact_boundary 测试写于上游加此校验之前，注入序列是 `[compact_boundary, session_state_changed:idle]`（有 idle 无 result），正好命中新校验。
- **解法**：把测试里 trailing 的 `{ type: "system", subtype: "session_state_changed", state: "idle" }` **删掉**，让 stream 自然结束（settle 成 end_turn）——与相邻的两条已适配测试（`compact_boundary uses getContextUsage maxTokens…` / `falls back to used:0…`）完全一致，它们已带注释「No trailing idle: an idle with no preceding result now fails the turn as abandoned (issue #825), and a real compaction turn always produces a result」。真实的 compaction turn 总会产出 result，所以裸 idle 本就是不真实的构造。改完用 `git commit --fixup=<上下文计算提交sha>` 并入。
- **教训**：与案例 4 同类——上游新增运行时校验会让我方旧测试的**人为构造序列**失效；判别标准是「这个构造在真实运行时会不会发生」，不真实就按上游新语义改测试，别去改上游逻辑。
- **锚点**：`src/acp-agent.ts`（consumer 循环 `session_state_changed`/`idle` 分支的 `failActive(no_result)`、`TURN_NO_RESULT_MESSAGE`、`errorKindData("no_result")`）、`src/tests/acp-agent.test.ts`（`describe("usage_update computation")` 里三条 compact_boundary 测试，注意 trailing idle 的有无）。

## 案例 7（0.55.0→0.58.1 复盘）：SDK 0.3.205 收紧类型 + 上游新测试 mock 缺字段，三处纯类型/mock 适配
- **现象**：rebase 全程仅 5 处小冲突（见下），但 rebase 后 `npm run typecheck` 报 11 个 error、`npm test` 出 22 个新失败（外加 2 个已知 Windows toDisplayPath）。全部集中在测试文件，非逻辑冲突，靠 typecheck+test 才暴露（同案例 5/6 教训）。
- **根因**（三类，都因上游升级而非我方 bug）：
  1. **SDK `CanUseTool` 返回加 `| null`**（0.3.198→0.3.205，`sdk.d.ts` 的 `Promise<PermissionResult | null>`）→ 我方 live-bash 测试 `expect(result.behavior)` 报 `TS18047 'result' is possibly 'null'`（3 处，`src/tests/acp-agent.test.ts` ~8093/8113/8132）。
  2. **TS lib `AsyncGenerator` 收紧**（要求 `[Symbol.asyncIterator]`/`[Symbol.asyncDispose]`）→ 我方 rewind/fork 测试 8 处 `injectGeneratorSession(agent, function* () {})` 的 sync generator 不再兼容 `(input)=>AsyncGenerator` 签名（`TS2345`）。
  3. **上游新增 `src/tests/session-config-options.test.ts`（#843/#849）的 mock session 写 `settingsManager: {}`**（无 `getSettings`）→ 撞我方「上下文窗口计算」提交在 `applyConfigOptionValue` model 切换分支新引入的 `session.settingsManager.getSettings()` 调用 → 运行时 `TypeError: session.settingsManager.getSettings is not a function`（22 个测试全挂在这一行）。这与案例 4 同类：我方改动引入新依赖，上游后加的测试构造不满足。
- **解法**（全部改测试适配、不动逻辑）：
  1. 三处 `expect(result.behavior)` → `expect(result?.behavior)`（可选链，与文件里 `(result as any).updatedPermissions?.[0]` 的可选风格一致；null 时得 undefined 断言仍失败，语义不变）。`sed -i 's/expect(result\.behavior)/expect(result?.behavior)/g'`。
  2. 八处 `function* () {}` → `async function* () {}`（空 generator 仅为建 session，sync→async 无语义影响）。`sed -i 's/injectGeneratorSession(agent, function\* () {})/injectGeneratorSession(agent, async function* () {})/g'`。
  3. 上游 mock `settingsManager: {}` → `settingsManager: { getSettings: () => ({}) }`（真实 session 一定有 settingsManager，是上游 mock 缺字段，补齐即可）。
- **归属 fixup**：三类分属不同我方提交（result?.behavior→live-bash、sync-generator→rewind、getSettings mock→上下文窗口计算、重生成的 lock→esbuild）。**同一文件混两类改动的分离技巧**：先 `sed` 临时把一类还原成提交态 → `git add` + `git commit --fixup=<A>` 另一类 → 再 `sed` 重新应用 → `git add` + `git commit --fixup=<B>`。最后 `GIT_SEQUENCE_EDITOR=: GIT_EDITOR=true git rebase -i --autosquash <上游HEAD>`。
- **运维坑**：Windows 上 rebase/branch 操作偶发 `index.lock: File exists`（"Another git process..."），实为上一条 git 命令的残留锁；`rm -f <repoRoot>/.git/worktrees/<wt>/modules/vendor/claude-agent-acp/index.lock` 后重试即可（本仓库是 worktree，lock 在 `worktrees/<name>/modules/...` 下，不是 submodule 目录内）。
- **锚点**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`CanUseTool`/`PermissionResult`）、`src/tests/acp-agent.test.ts`（`injectGeneratorSession` 调用点、live-bash `result?.behavior`）、`src/tests/session-config-options.test.ts` line ~113 的 mock、`src/acp-agent.ts`（`applyConfigOptionValue` 里 `computeInitialContextWindow(session.settingsManager.getSettings(), ...)`）。

## 案例 8：上游 #848 在 resume 关键路径引入阻塞 CLI 往返,session 恢复 2s→20s+;我方改为异步纠偏(rebase 时必须保住的本地语义)
- **现象**：0.55.0→0.58.1 后用户恢复 session 从 ~2s 劣化到 20s+。计时定位:`session/load` 的主导耗时是 `getAvailableModels` 里 resume 分支的 `query.getContextUsage()`(等价 /context 的完整上下文装配+token 计数,2.4MB/3.6MB transcript 实测 5.9s/7.1s),另有覆盖时的串行 `setModel`。来自上游 #848(修 #845「resume 应上报 transcript 实际运行的模型」)。
- **解法**（fork 提交 `5e053a7`,本地语义,上游没有）：`getAvailableModels` 在 resume 时**零 CLI 往返**立即返回(env/settings/models[0] 本地解析,0.55.0 语义)+ `resumeSync` 标记(`"read-live-model"` | `"reassert-override"`);`createSession` 在 sessions 表落位后 `void this.reconcileResumedSessionModel(...)` 后台执行原 #848 逻辑,纠偏经 `updateConfigOption` → `config_option_update` 通知客户端。编辑器侧 `ConfigOptionStateMachine.ingestUpdate` 天然消化该通知,无需改动。后台任务容错:session 关闭/被替换/用户已切模型均静默放弃(后写者胜)。
- **rebase 注意**：下次合上游时,`getAvailableModels`(返回类型是 `{ state, resumeSync? }` 而非裸 state)、`reconcileResumedSessionModel`、`readResumedLiveModel` 周边极易与上游对 #848 的后续改动冲突。**原则:任何 CLI 控制请求(getContextUsage/setModel)都不得回到 session/load 关键路径**,上游若有新的 resume 期同步逻辑,一律并入 `reconcileResumedSessionModel` 后台任务。`[perf]` 计时日志(loadSession/createSession/readResumedLiveModel/setModel)是按仓库「关键逻辑加调试输出」规则永久保留的,别当临时插桩删掉。集成测试 `session-load.test.ts` 的 #845 用例断言时机是「load 返回后等 config_option_update」而非「load 响应里」,上游同名用例若冲突以我方为准。
- **锚点**：`src/acp-agent.ts`(`getAvailableModels` 的 `isResumedSession` 早返回、`reconcileResumedSessionModel`、`createSession` 里 `resumeSync` 调度点)、`src/tests/resumed-model-sync.test.ts`(全部我方新增)、`src/tests/session-load.test.ts`(#845 用例)。

## 案例 9（0.58.1→0.62.0 复盘）：上游 #894 把 contextWindow seeding 也做进 resume 关键路径，与案例 8 正面冲突；及五类新坑
- **现象**：上游 #894（remove ~15s stall on session/new and model switch）建了 `contextWindowCache`/`immediateContextWindow` 同步 seeding 体系，同时把 `readResumedLiveModel` 扩成返回 `{model, contextWindow}`、`getAvailableModels` 返回 `{modelState, resumedContextWindow}`——**resume 的 getContextUsage 仍在 session/load 关键路径**（上游认为 resumed session 的 report pre-turn 可得，但我方实测大 transcript 要 6-7s，案例 8）。与我方 `dd49937`（案例 8）、`6b585e3`（maxTokens 有效窗口）、`2045546`（autoCompactWindow clamp）三个提交同时冲突。
- **解法**（语义合并，案例 8 原则优先）：
  1. `getAvailableModels` 保持我方 `{ state, resumeSync? }` 签名——resume 零往返，`resumedContextWindow` 概念整体删除（seededWindow 只走 cache/heuristic）。
  2. `readResumedLiveModel` 吸收上游维度扩成 `{ model, contextWindow, used }`（contextWindow 用我方 `pickWindowSize(maxTokens) ?? pickWindowSize(rawMaxTokens)`，非上游的裸 rawMaxTokens），保留 `[perf]` 日志。
  3. `reconcileResumedSessionModel` 后台应用窗口纠偏：`session.contextWindowSize = min(report, clamp)` + `contextWindowAuthoritative = true` + 发 `usage_update { used, size }` 推送客户端（report 的 totalTokens 是真实 used，一并发）。
  4. `2045546` 的 clamp 叠加到上游每个 seed 点：session 创建（seededWindow）、model switch、message_start heuristic 升级、result 的 modelUsage fallback（cache 存物理窗口、clamp 在读取处应用）。
  5. 上游新增测试 `session/load seeds the window from the resumed session's getContextUsage report` 断言同步 seed——**与我方语义直接冲突，按案例 8「以我方为准」改写**为「load 零往返 seed 200k → `vi.waitFor` 后台纠偏到报告值」。
- **坑 1（最大的一波隐性失败）：dogfood 环境污染测试**。fork 自身功能（`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`）会被 fork 注入它 spawn 的 CLI 的 env——在 fork dogfood 的 shell（包括 Claude Code 会话本身）里跑 `npm test` 时，这些变量经 `...process.env` spread 和 `resolveAutoCompactWindow` 的 process.env 候选泄漏进几十个测试（context window 测试成片挂、subagent pin 测试挂）。**解法**：vitest `setupFiles`（`src/tests/setup.ts`）里**直接赋值** `process.env.X = ""` 清空——不要用 `vi.stubEnv`（测试的 `unstubAllEnvs` 会把 setup 的 stub 一并恢复出脏值；直接赋值后测试自己的 stub/unstub 往返恰好恢复到干净值）。
- **坑 2：git 三方合并的对齐吞噬**。两侧在相同锚点各自追加内容时，相同的结尾行（`}`、`/**`）会被 git 对齐成公共行，手动拼接「HEAD 块 + theirs 块」容易丢 HEAD 函数的闭合 `}` 或 theirs 注释的开头 `/**`（本次 tools.ts、tools.test.ts 各一处，`typecheck` 的 TS1005 兜底）。拼接「各自追加」型冲突块后**必须立即 typecheck**，别等全部 rebase 完。
- **坑 3：extNotification 旁路 sendUpdate 的语义丢失**。上游靠 `sendUpdate` 包装器给 agent_message_chunk 置 `session.emittedAssistantText = true`（delivered 标记，抑制 #453 result-text fallback）；我方 18f9c85 把 compacting 改成 extNotification 后旁路了该标记 → `/compact` turn 的 result text 被 fallback 误转发。**我方每处把 sendUpdate 换成 extNotification 的地方，都要核对上游挂在 sendUpdate 上的副作用**。解法：compacting 分支显式 `session.emittedAssistantText = true`。
- **坑 4：autosquash 的时序陷阱**。fixup 到较早提交的 hunk，若其上下文由**更晚提交引入**（如 c0416bd 的内联测试 mock），autosquash 重排到目标时点无法应用，呈现「HEAD 空 vs base/theirs 有完整测试块」的 add/add 冲突。解法：取 HEAD 跳过、让后续提交正常引入；跳过前先确认那些 mock 的测试本不需要该补丁（本次两处都是预防性批量补丁的副产品，跳过无损）。**教训：批量 sed 补丁（如给 34 处 mock 补 extNotification）做的 fixup 归属，冲突面会放大——补丁越机械，越应按 describe 归属到引入对应测试的提交**。
- **坑 5：rebase 中途的 git 操作禁忌**。为验证「某测试在旧版是否通过」误用 `git stash` + `git checkout <old> -- .` + `stash pop`（产生冲突、差点丢修复改动）——验证旧行为一律 `git clone -q --no-hardlinks . /tmp/xxx` 到临时目录做，恢复手段是 `git reset --hard <branch>` + `git stash pop`。
- **案例 1 扩展**：上游 #867 新增的 4 个 streamed-input refine 测试同患 Windows 路径分隔符缺陷（`src\x` vs `src/x`），与原 2 个 toDisplayPath 失败同属上游 `path.relative` 平台分隔符问题，同样忽略——**当前已知 Windows flake 总数 6 个**。
- **锚点**：`src/acp-agent.ts`（`seededWindow`/`immediateContextWindow`、model switch clamp、`reconcileResumedSessionModel` 的窗口/used 纠偏、compacting status 的 `emittedAssistantText`）、`src/tests/setup.ts`（环境污染清理）、`src/tests/create-session-options.test.ts`（resume seed 改写用例）、`src/tests/subagent-model.test.ts`（beforeEach stub）。

## 案例 10：vendor submodule `npm ci` 报 `Missing ... from lock file`（peer 无祖先链节点）
- **现象**：`vendor/claude-agent-acp` 等 submodule 的 `npm ci`（`agent:build`/打包时）报 `Missing: X from lock file` / `EUSAGE`，本机 `npm install` 却正常。
- **根因**：某包的 **peerDependencies 在 lock 中无满足节点**——lock 里已有的 X 嵌套在别的包下、不在 peer 消费者的祖先链上，`npm ci` 构建理想树时需要顶层放置新版本（registry 最新），lock 没有即 `EUSAGE`。多由上游依赖链演进（如 `vitest→vite→rolldown→@napi-rs/wasm-runtime` peer `@emnapi/*`）引起，老 lock 突然失效。
- **解法**：submodule 内 `npm install --package-lock-only --registry=https://registry.npmjs.org`，验证 `npm ci --dry-run` 通过后提交 fork 分支（注意 gitlink 指向的分支可能是 `main-060726` 这类平行分支，先 `git branch -a --contains <gitlink>` 确认），再更新主仓库 gitlink。
- **Why 必带 `--registry`**：本机 npm 常配了镜像（如腾讯 `mirrors.tencent.com`），不指定 `--registry` 会把镜像 URL 写进 lock 的 `resolved` 字段，CI（境外 runner）拉包慢甚至不通。**凡在 `vendor/*` 重新生成 lock，一律带 `--registry=https://registry.npmjs.org`**；提交后本地 `pnpm agent:build` 全链路验证。
- **锚点**：`vendor/claude-agent-acp/package-lock.json`、主仓库 `scripts/release/vendor-install.mjs`（`npm ci` 调用处）；与 SKILL.md 要点 8「optional 依赖静默省略导致隔天 `npm ci` 挂」是同一 lock 环节的两个坑。相关记忆 `agent-binary-silent-download-e2e-fix`。
