# 对话上下文：changelist / Swarm review 进 Agent

把 p4 的 changelist 与 Swarm review 加进 AI 对话上下文。两条链路对等 git commit 的既有两个入口：

| 入口 | 实现位置 | 形态 |
|---|---|---|
| Agent 输入框 `#` 面板 | **本扩展** `src/chatContext.ts`（`chat.registerChatContextProvider`） | 引用药丸（`PromptRef.kind='chatContext'`），正文以 `text` 块发送 |
| Perforce Graph 行 / SCM changelist 组头 / Swarm reviews 行右键 | **renderer**（`actions/agentContextActions.ts` 的 `workbench.action.agent.sendContextToChat`） | 纯文本注入输入框 |

## `#` provider（本扩展侧）

两个 provider 在 `activate` 里注册（`extensions/perforce/src/extension.ts`）：无 workspace root / 无 client 时 `activate` 早已 return，所以**注册点本身就是「p4 插件生效时才出现」的门控**，不需要新 activation event。

流程是**两步式**：`#` 面板只显示一条入口项（label + `keywords`，匹配为大小写不敏感子串），用户接受后宿主回调 `resolve(query, context)`，由扩展自己弹 `window.showQuickPick` 选真正的条目，返回的 `ChatContextItem` 才成为药丸——候选集（几千个 CL）因此永不离开扩展进程。`ChatPickItem.item` 挂在 pick 行上随 `showQuickPick` 往返，这是把载荷带出 picker 的手段。

**取数期间不留白**：`pickItem` 把 loader **promise 交给 `showQuickPick`**（不是先 `await` 再弹），picker 立刻弹出，p4 / Swarm 的往返期间用户看得到东西（列表区立即显示「Loading…」；顶部进度条由 workbench-ui 的 `BUSY_BAR_DELAY_MS` 节流——**慢于 800ms 的加载才画**，快取回不留一条闪过的动画）；空列表由扩展关掉 picker 并弹 info 提示（`settled && loaded.length === 0` 判定——用户在加载期间按 Esc 不算「没有可添加的」，不会事后被弹一条空提示；面板一关，`showQuickPick` 立刻以 `undefined` 结算，不继续等取数）。因此**能同步（或只读配置）拿到的判断必须在 `showQuickPick` 之前做完**——例如 Swarm 未配置的提示若放进 loader，picker 会一闪即关。

- **changelist**：范围是**当前 session 所在目录**（`context.sessionDir`，不在任何 client 内时回退整个 client root）——pending 用 `client.pendingChangelistsUnder(scopeDir)`（取自上次 refresh 的 `_changelistByPath` 缓存，**不发 p4 调用**；跳过 `default`），submitted 用 `client.getGraphChanges(100, [buildScopeFilespec(scopeDir, true)])`（与 Graph 共用 `P4CacheNs.changesSubmitted` 缓存）；两段合并去重后**整体截断到 100 条**（`MAX_CHANGELIST_PICKS`，pending 优先保留）。**只有 shelf、没有 opened 文件的 CL 不会出现在按目录过滤后的 pending 列表里**（缓存映射的是 opened 文件）。
- **swarm review**：`SwarmClient.dashboard({ needsActionAuthors, windowDays })`——**同一份侧栏配置**（沿用 `perforce.swarm.reviewWindowDays` 与 `perforce.swarm.needsActionAuthors`），`needsAction` 在前、`authored` 在后，`mergeSwarmPicks` 按 id 去重（同一 review 两组都出现时只留一条）。注册函数由 `swarm/swarmCommands.ts` 调用，直接复用那里的 `readSwarmConfig()` / `guard()`（未配置 → 提示 `perforce.swarm.notConfigured`；未授权 → 登录流程；错误 → toast），**不绕命令层**，避免 ext-host → renderer → ext-host 的往返。URL 由 `swarmReviewUrl(baseUrl, id)` 拼。**两段式**：配置判断（便宜，只读配置）在 `showQuickPick` 之前决定要不要开 picker，`dashboard` 网络请求放在 `loadReviews`（loader）里，进度条覆盖它。
- 候选为空（`pickItem`）与用户取消都返回 `undefined`——renderer 什么都不插入。
- 文案在 `src/nls.ts` 的 `perforce.chat.*`（label / description / empty / placeholder + `state.pending` / `state.submitted`）。

## 注入正文的格式

`ChatContextItem.text` 是**模型唯一能看到的内容**（agent 丢弃 `resource_link` 的 name/description/_meta），故必须是完整自足的字符串：

- `Perforce changelist 1234: fix the parser`（无描述时退化成 `Perforce changelist 1234`）
- `Swarm review 1001 "fix the parser": Needs Review — <review url>`

该模板**存在两份**：`extensions/perforce/src/chatContext.ts` 与 renderer 的 `apps/editor/src/renderer/services/acp/chatContextFormat.ts`（扩展不能 import renderer 代码），两侧各有测试钉住形状。**改一处必须改另一处**。**不要为消重把模板挪进 `extensions-common`**：本扩展目前对该包只有 type-only 依赖（类型被擦除、不进 dist），首个 value import 会让 esbuild 把整个 barrel 打进 `dist/extension.js`——实测 +230KB 且带进 zod / ProxyChannel，为几个纯函数不值。

## 右键入口（renderer 侧，不在本扩展）

三个菜单项都在 renderer 实现，共用同一套格式化纯函数与同一个注入 helper：

- **Perforce Graph 行**（`workbench/perforceGraph/PerforceGraphEditor.tsx`，数据已在行上 `change.message`）与 **Swarm reviews 行**（`workbench/swarm/SwarmReviewsView.tsx`，数据来自 `SwarmReviewDto` 列表）→ 命令 `workbench.action.agent.sendContextToChat`（`SendContextToAgentChatAction`，payload = 渲染好的文本）。
- **SCM changelist 组头** → 命令 `workbench.action.agent.sendChangelistToChat`（`SendChangelistToAgentChatAction`）：Action2 自己声明 `MenuId.ScmResourceGroupContext` + `when: scmProvider == perforce && scmResourceGroup =~ /^(cl|shelved):/`（default 组没有编号也没有自己的描述，故排除），`arg` 只有组 id → **描述另行现取**，走能力命令 `perforce.getChangelistDescription`（`extension.ts` 运行时 `commands.registerCommand`，不进 `contributes.commands`，与 `checkIgnore` / `getHeadContent` 同族的 `<providerId>.<capability>` 约定；探测靠 `CommandsRegistry.getCommand`）。解析 SCM 组的展示串（`#<n>: <描述>`）会是隐式耦合，故不采用。

## 验证

```bash
pnpm --filter @universe-editor/perforce test    # chatContext.test.ts 钉住 pick 顺序 / 去重 / 正文
pnpm check
```

手测（dev + p4 workspace，建议把 session cwd 放到 client root 的子目录）：`#changelist` / `#cl` / `#swarm` → picker **立即**出现（顶部进度条只在取数慢于 800ms 时出现）→ 填充后列表只含本目录相关的条目（≤100）→ 药丸；Swarm 列表「需要我处理」在前、「我发起的」在后且无重复；取数期间 Esc 立刻关闭且**立刻结束调用**（不等 dashboard 返回）、无残留面板、扩展侧无报错；三个右键入口各注入一次，正文与 `#` 路径一致。
