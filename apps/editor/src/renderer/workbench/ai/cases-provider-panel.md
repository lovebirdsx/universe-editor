# 本文从 apps/editor/src/renderer/workbench/ai/CLAUDE.md 拆出，范围是供应商面板（`AiProvidersPanel`）的交互语义与加载机制——探测弹窗的勾选回填、自动探测的触发指纹与失效时机、刷新两态、写版本守卫。面板文件地图与写盘串行化规则仍在 CLAUDE.md。

## 勾选式弹窗的确认语义是「关于它展示过的那些」，不是「结果集就是全部」

探测弹窗（`providerCard/ProbeModelsDialog.tsx`）只列出端点**这次**报出来的名字，所以一张勾选票只回答「这些名字里留哪些」，不回答「这条 provider 该有哪些模型」。回填纯函数 `mergeProbedSelection(existing, offered, selected)`（`apps/editor/src/shared/ai/protocolMapEdit.ts`）必须保留两类既有条目：

- 端点这次**没报**的 ref——用户压根没机会勾它；
- 被勾中但原本是**对象形**的 ref——`{ id, ref }` 与收窄过的 capabilities 是手写知识，打回裸字符串就丢了。

别把它简化成 `selected.map(...)`（那正是「没报的就删掉」这个 bug 的形状）。边界用例在 `apps/editor/src/shared/ai/__tests__/protocolMapEdit.test.ts`。

## 自动探测：触发用有效连接指纹，失效发生在「变更被检测到」那一刻

`providerCard/useAutoVerify.ts` 的两个时机设计：

- **触发载体是「有效连接指纹」**：`JSON.stringify({ protocol: effectiveProtocol, baseUrl, apiKey })`，三项都取继承展开后的有效值。**不能用 `reloadToken` / providers 数组引用**——每次 reload 都产新数组引用，按引用比对会把任何模型元数据变更都变成重测；有效连接变了（字段编辑/继承变化）才该命中。apiKey 进指纹是刻意的（改 key 必须重测），但指纹只活在这个 hook 里、绝不落日志。
- **在途结果的 token 失效必须发生在「变更被检测到」那一刻，而不是「新探测启动」时**：指纹 effect 一检测到变化就 `tokenRef.current++`（`useAutoVerify.ts:164-166` 的注释即此语义），之后才起 600ms（`AUTO_VERIFY_DEBOUNCE_MS`）防抖延时。若只在发起新探测时 `++token`，慢网络的旧探测会在防抖窗口内带着**旧地址**的结果成功 paint 并写脏缓存。卸载同样 `++token`：在途结果不许 paint、也不许写缓存。连接变得不可测（无有效 protocol/baseUrl）时不是留着旧答案，而是回 `idle` 并删掉缓存条目。
- 守护测试：`clearing the base URL invalidates an in-flight probe immediately`、`a stale in-flight result does not override a newer one`（`apps/editor/src/renderer/workbench/ai/__tests__/AiProvidersPanel.test.tsx`）。

## 刷新：网络枚举不与内存读同批，「加载中」与「没有」是两个状态

`AiProvidersPanel.reload` 拆成两段（`apps/editor/src/renderer/workbench/ai/AiProvidersPanel.tsx` 的 `reloadFast` / `enumerateModels`）：

- **别把「网络枚举」和「内存读」放进同一个 `Promise.all`**：`getModels` 对 discover 型 provider 会发真实 `/v1/models`，端点是黑洞时整批等满 `METADATA_REQUEST_TIMEOUT_MS = 10_000`。**判据＝刷新里只要有一个 await 打网络，整块 UI 的延迟就等于最慢端点的超时。** 四个 main 内存读（`getProviders` / `getProviderIssues` / `isLegacySettingsFormat` / `getModelKnowledge`）先落地；`getModels` 后台化 + `modelsTokenRef` latest-wins（卸载时 `++`，防迟到 setState 泄漏组件实例）。症状正是这两个：改 provider 字段后「已保存」隔数秒才出现、外部改 `aiSettings.json` 回面板列表先空数秒。
- **`modelsLoading` 必须一路贯穿到叶子**：传到 `ProviderEntryCard` / `ProtocolsSection`，叶子才能说「正在问端点」，否则徽标谎报 `0 models`、discover 块显示 "No models resolved"、Pin 按钮谎报 0。第一版只在面板层加 `loaded`，缺陷原样搬到了卡片层。且**只对 discover 模式区分**——static 的 refs 来自配置文件，不依赖网络。
- 守护测试：`renders providers while getModels hangs instead of flashing the empty state`、`a discover card shows fetching copy instead of "No models resolved" while getModels hangs`。

## 去掉 `await reload()` 后必须补写版本守卫

事件驱动的 reload（`onDidChangeModels` / `onDidChangeRemote`）**不走 `enqueueWrite` 队列**，可能在一次写的中途启动，用旧快照回写 `providersRef.current` / `setProviders`，抹掉刚提交的改动——CLAUDE.md「全量替换写 API 必须串行化」那条竞态换了个入口复发。修法＝`writeSeqRef`：每次快照替换（`updateProviders` 开头）`++`，`reloadFast` 落地时版本已前进就跳过写 providers。守护测试：`a second field edit committed mid-flight does not undo the first`。

相关：`apps/editor/src/renderer/workbench/ai/CLAUDE.md`（文件地图、写串行化、易踩坑 11）、`apps/editor/cases-ai-provider-data-model.md`（条目数据模型）、`docs/development/ai-model-layer.md`（registry 侧的定向解析与枚举缓存指纹）。
