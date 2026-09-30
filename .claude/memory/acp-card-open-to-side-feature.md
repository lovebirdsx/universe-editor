---
name: acp-card-open-to-side-feature
description: 卡片文档「在旁边组打开」全套（Ctrl+点击 + 菜单两项 + ensureSideGroup 抽取）；坑=卡片的阅读入口由 content diff 块驱动，structuredPatch 只喂变更跟踪器
metadata:
  node_type: memory
  type: project
---

ACP 时间线卡片产出的文档除就地打开外，还能落到聊天的**右侧相邻组**：标题行阅读按钮 **Ctrl/Cmd+点击**、右键菜单「在侧边打开预览 / 在侧边打开文件」（两个 Action2 `when` 互斥，同一张卡只多出一行）。落点收口在新 helper `services/editor/openToSide.ts::ensureSideGroup(groups, source = activeGroup)`（markdown/html 预览的 5 行重复也换成它），"预览 else resolver" 收口在 `openResourceForRead`；`useMarkdownFileLink` 的 `toSide` 从死参变成生效（影响面含 markdown 预览正文里的链接 Ctrl+点击）。

**坑（写 agent fixture / 断言卡片 UI 时必踩）**：卡片那个阅读入口（`createdFilePath` → `diffs`）只认 **ACP 标准 `content: [{ type: 'diff', path, oldText: null }]`** 块；`_meta.claudeCode.structuredPatch` 是**另一半**载荷，只喂 session change tracker。只发后者会得到一张没有阅读按钮、右键菜单也没有 `Open File` 行的卡——e2e 里表现为 locator 静默等 30s 超时。`sessionDiffAgent.cjs` 的 `createmd` / `createtxt` 模式两半都发。

**为何 `ensureSideGroup` 只能在真正打开那一帧调用**：新建的空组**不会**被回收（回收只在 group model 变化时触发），提到 `await` 之前建组会让"文件不存在 / 多命中 / 目标是目录"这几种结局各留下一个孤儿空组。

**落点语义**（e2e 已锁）：点卡片时 group body 的 `onMouseDown` 先激活卡片所在组，所以第二次 Ctrl+点击会**复用**第一次开出来的侧边组，不会一路向右裂开；只有源组本身就是最右组时才再新建（单测覆盖另一支）。相关：[[editor-input-identity-isolation]]
