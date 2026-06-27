---
name: async-session-create
description: 新建 session 异步化——本地 uuid 立即渲染，后台握手，双 id（id vs sessionIdOnAgent）
metadata: 
  node_type: memory
  type: project
  originSessionId: a0725e18-bb93-4673-b17f-0638a710bc98
---

新建 ACP session 从「等 init(1-5s) 再显示」改为异步：createSession 同步建好 AcpSession 并立即返回（UI 立即可输入），spawn+initialize+session/new 在后台 `_connectSession` 跑。

关键设计（双 id）：
- `AcpSession.id` = 本地随机 uuid（generateUuid），构造即有，用于 React key / 运行期缓存 / activeSessionId。
- `AcpSession.sessionIdOnAgent: IObservable<string|undefined>` = agent 颁发的 durable id，attach 后才有。history、change tracker（record/changesFor）、active-session 持久化、editor tab serialize、协议通知路由全用它。
- `AcpSessionService._findSession(id)` 同时匹配本地 id 与 agent id（通知/getById/setActive/closeSession 都走它）。

连接前发消息：`sendPrompt` 立即 append user 消息 + 入 `_queuedPrompts`，attach 后 `_flushQueuedPrompts` 自动派发（用户无感）。状态机：初始 `'connecting'`，attach→`idle`，失败→`failConnection`（status `errored` + `[error]` 消息，**createSession 不再 reject**）。

新增 `AcpSession.whenConnected(): Promise<void>`——attach/fail/close 后 resolve。**测试必须在访问 `client.connected[...]`、注入 agent 通知、断言 seed 状态前 `await session.whenConnected()`**；resume 流程仍全程 await（行为不变），且 resumed.id === entry.sessionIdOnAgent。

坑：测试里给 AcpSessionService 自身用的 FakeStorage 若在启动微任务 fire onDidChangeWorkspaceScope，会触发 `_onWorkspaceSwap` 把刚建的 session close 掉（旧同步代码碰不到，新异步会）。

相关：[[session-diff-feature]] [[codex-session-skills-scan-slow]]
