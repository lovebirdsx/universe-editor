---
name: ai-providers-visual-editing
description: AI Settings 的 Providers 图形化编辑（现 8 字段）；全量替换写 API 必须串行化；连通性自动探测（useAutoVerify）
metadata:
  type: project
---

单层 `providers[]`（提交 fc09ae82）之后补的可视化编辑：字段全部有图形入口，统一「即时保存 + 内联反馈」范式。地图在 `apps/editor/src/renderer/workbench/ai/CLAUDE.md`（`providerCard/` 子目录），纯函数在 `shared/ai/{protocolMapEdit,providerInheritance,providerTemplates}.ts`。

> 2026-08 变更：`AiProviderEntry.label` 字段已彻底删除（类型/schema/UI/i18n），一切展示回退 `id`；「Test connection」按钮已删，连通性改为**自动探测**（`providerCard/useAutoVerify.ts`），明文存储横幅与帮助文案已删（docs/user 安全须知保留）。

跨会话教训：

1. **全量替换的写 API + 逐字段即时保存 = 必须串行化并基于最新快照。** `updateProviders(all)` 覆盖整个数组，而 React 闭包里的 `providers` 是渲染时的旧值。用户 Tab 换字段会让两次提交重叠，后一次用旧快照写回，静默抹掉前一次——两张卡都还显示「已保存」。修法＝`providersRef` + `enqueueWrite` promise 链，**且 main 侧同样是读改写的 `setApiKey/deleteApiKey` 也要进同一条队列**。回归测试用可控 deferred 卡住第一次写，验证过「不加修复必失败」。

2. **继承字段的「有效值」不能只读自身。** 纯继承条目 `{ id, extends }` 自己没有 baseUrl/apiKey，探测/验证若只读 `provider.baseUrl` 会去拨协议默认端点且不带鉴权，报一个卡片刚说过不该发生的失败。统一走 `effectiveConnection(provider, all)`；它返回**祖先的明文密钥**，只可发往 main 建连，绝不渲染（继承的密钥在子卡片只显示「继承自 X」）。

3. **勾选式弹窗的确认语义是「关于它展示过的那些」，不是「结果集就是全部」。** 探测弹窗只列出端点这次报的名字，所以回填必须保留两类既有条目：端点没报的（用户压根没机会勾）、以及被勾中但原本是对象形的 ref（`{id, ref}` / 收窄过的 capabilities 是手写知识，不能被打回成裸字符串）。这条规则收在纯函数 `mergeProbedSelection(existing, offered, selected)` 里。

4. **自动探测的触发载体用「有效连接指纹」，不能用 reloadToken/数组引用**——每次 reload 都产新数组引用，按引用比对会把任何模型元数据变更都变成重测。指纹 = `JSON.stringify({protocol, ...effectiveConnection})`，字段编辑/继承变化才命中。

5. **防抖重测时，在途结果的 token 失效必须发生在「变更被检测到」那一刻，而不是「新探测启动」时**（代码审查抓出）：若只在发起新探测时 `++token`，慢网络的旧探测会在防抖窗口（≤600ms）内带着旧地址的结果成功 paint 并写脏缓存。指纹 effect 里变更一检测到就 `tokenRef.current++`。测试要 gate 在途探测覆盖此窗口。

相关：[[ai-service-foundation-progress]]（服务三层与密钥明文策略）、[[ai-pricing-no-guess-cost-separation]]（费率不跨 provider 兜底）
