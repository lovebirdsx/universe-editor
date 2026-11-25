# apps/editor/src/renderer/workbench/icons/CLAUDE.md

工作台图标 id 的解析中心。`icon` 是贯穿 Action2、菜单、ViewContainer/View、TreeItem、状态栏、QuickPick、Timeline、SCM 的不透明字符串，渲染时才解析成组件。

## 解析管线（`resolveIcon`）

`$(id)` / 裸 id / `id~modifier` 三种写法等价（`iconReference.ts`）：

1. 无 modifier 时先查精选 Lucide 表（`icon-map.ts` 的 `ICON_MAP`、`containerIcons.ts` 的 `CONTAINER_ICON_MAP`）。
2. 未命中再查 `@universe-editor/platform` 的 `codiconLibrary`（649 个真实 codicon，与 `codicon.css` 集合相等，`iconCoverage.test.ts` 守护）；命中则由 `codiconIcon.tsx` 渲染字体字形。
3. 都没有 → `undefined`，由各表面原有兜底处理：ActivityBar 回退 Explorer 字形、菜单不渲染、SCM 回退文件图标、QuickPick 回退 Bot。

**modifier 会强制走 codicon 字体**：`files~spin` 即使 `files` 在 Lucide 表里也渲染字体字形。精选表里但不在 `codiconLibrary` 的 id（如 `changelist`）加 modifier 后会解析失败——扩展文档只承诺“真实 codicon id 可带 modifier”。

**所有 id → 组件查表必须 `Object.hasOwn`**：id 来自扩展 manifest，直接 `MAP[id]` 会让 `constructor` / `toString` 命中原型链。

## agent logo 优先

`claude` / `openai` 等是真实 codicon，但同时也是 Agent 官方 logo。`menuIcon.tsx` 与 `QuickInput.tsx` 必须先查 `agentIcon.tsx` 的 agent 表（`resolveKnownAgentIcon`），未命中才走 `resolveIcon`，最后才用通用 Bot。

## 容器图标 vs 视图图标

- 容器图标解析走 `resolveContainerIcon.ts`（对齐 VSCode `useDefaultContainerInfo`）：容器里还有默认归属自己的视图时用容器 `icon`；可见视图全是别处移入的（含宿主生成的临时容器）时改用第一个视图的 `icon`。
- `contributes.views[].icon` / `trustedViews.icon` 是多视图容器 `ViewPane` 标题栏里的视图图标；单视图容器没有视图标题栏，扩展应改用 `viewsContainers.icon`。
- 扩展 icon 的 `$(id)` 在 `ExtensionPointTranslator` 归一化；文件路径图标未支持，会记一次 warning 后按各表面兜底。

## 测试锚点

- `iconReference.test.ts`：写法解析（包裹/裸/ modifier / 非法路径）。
- `icon-map.test.tsx`：精选命中、codicon 兜底、原型链、组件身份稳定。
- `menuIcon.test.tsx` / `QuickInputPortal.pickButton.test.tsx`：agent-first 与 codicon 兜底。
- `iconCoverage.test.ts`：扫描 renderer 源码、扩展 manifest（含 `extensions-external`）与 e2e spec 里的 `icon:` 字面量，任何拼错都会失败；并校验 `codiconLibrary` 与 `codicon.css` 同步。
- `resolveContainerIcon.test.ts`：容器图标派生的空/原生/混合/全移入分支。

升级 `@vscode/codicons` 时若 `iconCoverage.test.ts` 的集合相等用例失败，按提示重新生成 `codiconLibrary`。
