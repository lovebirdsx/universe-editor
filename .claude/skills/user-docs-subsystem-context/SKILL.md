---
name: user-docs-subsystem-context
description: 处理「用户帮助文档」相关功能时召回，提供 docs/user/ 内置用户指南子系统的完整上下文地图——文档从磁盘源文件到编辑器内渲染的全链路（main 侧 IDocsService 读盘 → renderer bootstrap 预热 → docRegistry 同步缓存 → DocEditorInput/DocEditor 渲染 → Help 菜单命令）、打包 staging、多语言回退、docId 路径规范、死链 CI 护栏，以及写作/链接约定。当任务涉及：帮助文档如何被加载/打包（源文件随发布产物落盘 vs 内联）、加/改一篇用户指南 .md、加 Help 菜单里的「打开某文档」命令、文档内相对链接跳转、多语言（zh-CN 基准 + en-US 回退）、DocEditor 渲染/键盘导航、docs:check 死链校验、或要理解「一篇 md 怎么从磁盘走到编辑器 tab」时，先读它建立全局认知。文档渲染复用 markdown 预览的渲染器与键盘导航（见 [markdown-subsystem-context] 线②），跨进程服务套路见 apps/editor/CLAUDE.md 套路 C。
disable-model-invocation: true
---

# 用户帮助文档（docs/user/）子系统 上下文地图

编辑器内置的「用户指南 / 帮助中心」：一批 markdown 源文件（`docs/user/<locale>/**/*.md`）在编辑器里以格式化 markdown tab 呈现，Help 菜单 + 命令面板可打开，文档间可相对链接跳转。

> ⚠️ 第一原则：先认领改动落在**哪一层**——① **文档内容**（写/改某篇 `.md`，纯内容 + 链接护栏，不碰 TS 代码）、② **加载/打包机制**（源文件怎么从磁盘到 renderer，`IDocsService` + `docRegistry` + staging）、③ **渲染/交互**（`DocEditor` 组件、Help 命令、链接跳转，复用 markdown 预览基建）。三层几乎不相交，改错层白改。

## 核心事实：源文件随发布产物落盘，运行时读盘（不再内联进 bundle）

**当前策略**（2026-07 从「Vite `?raw` 编译期内联」改造而来）：文档以**普通 `.md` 文件**随发布产物存在（打包后 `resources/docs/user/`，开发时仓库根 `docs/user/`），renderer 启动时经一次性 IPC 全量读进内存缓存。目的：① agent/用户能直接从磁盘读文档回答「编辑器怎么用」；② 文档不再膨胀 renderer bundle。

- **验证不再内联**：build 后 `grep -rl "界面导览\|__vite_glob_0" apps/editor/out/renderer/assets/` 应为空。
- **旧机制已删勿回退**：`docRegistry.ts` 里的两处 `import.meta.glob('.../docs/user/**/*.md', {query:'?raw', eager:true})` 已移除；`electron.vite.config.ts` 里为它放行的 `server.fs.allow`（仓库根）也已删。

## 全链路数据流（一篇 md → 编辑器 tab）

```
docs/user/zh-CN/getting-started/interface-tour.md   ← 磁盘源文件（docId = "getting-started/interface-tour"）
  │
  │ 打包：scripts/release/runtime-resources.mjs stage → 拷进 .runtime-resources/docs/user/
  │       electron-builder.yml extraResources 把 .runtime-resources 整体带到 resources/
  ▼
main 侧  DocsMainService (main/services/docs/docsMainService.ts)
  │  读盘：packaged 走 process.resourcesPath/docs/user；dev/E2E 走 resolveFromRepo(walk-up)
  │  递归 *.md → { locale: { docId: content } }，缺失降级空 map，结果缓存
  │  经 ProxyChannel.fromService 挂 ServiceChannels.Docs
  ▼  (IPC)
renderer bootstrap (main.tsx，在 contributions 注册 / editor 恢复之前)
  │  const docs = await docsService.getDocs(); initDocRegistry(docs)
  ▼
docRegistry (renderer/services/editor/docRegistry.ts)  ← 模块级同步缓存
  │  resolveDoc / getDocContent / getDocTitle / isDocId / extractH1（全同步读缓存）
  ▼
DocEditorInput (services/editor/DocEditorInput.ts)   虚拟 EditorInput，resource = universe:/doc/<docId>
  │  getName() = 文档首个 H1（同步）；deserialize 用 isDocId 守卫（同步）
  ▼
DocEditor (workbench/editor/DocEditor.tsx)  用 resolveDoc 取内容 → MarkdownView 渲染
```

### 为什么是「启动预热 + 同步缓存」而非全面异步化（关键设计决策）

`DocEditorInput.getName()` 是 EditorInput 的**同步契约**，`deserialize()` 里的 `isDocId()` 是 tab 恢复守卫（也同步）。若把 `docRegistry` 改成异步读盘，会污染这两处并波及 `DocEditor.tsx`，回归面大。**取而代之**：40 篇文档仅几十 KB，在 renderer bootstrap 早期一次性 IPC 拉全量灌进 `initDocRegistry()`，`docRegistry` 的导出 API **签名与行为全部保持同步**，`DocEditor.tsx` / `DocEditorInput.ts` **零改动**。预热**必须早于** editor 恢复（`WorkspaceRestoreContribution` 在其 constructor 里同步 `_restore()` → `deserialize` → `isDocId`），故 `initDocRegistry` 放在 `main.tsx` 的 `await import('./contributions/index.js')` **之前**。

## docId 规范

- **docId = locale 相对路径去掉 `.md`**：`docs/user/zh-CN/getting-started/interface-tour.md` → `getting-started/interface-tour`；`docs/user/zh-CN/index.md` → `index`。
- 分隔符统一 `/`（main 侧 `path.sep` → `/` 归一）。
- `docs/user/_template.md`（下划线开头、在 locale 目录外）**永不是 docId**：不在任何 `<locale>/` 下，遍历天然跳过；死链校验也按 `startsWith('_')` 跳过。

## 多语言（locale 回退）

- 支持 locale：`SUPPORTED_LOCALES = ['en-US','zh-CN']`（`shared/i18n/availableLocales.ts`）。
- **基准语言 = `zh-CN`**（`FALLBACK_LOCALE`）：当前唯一有内容的 locale。`en-US/` 目录尚不存在，全部走回退。
- `resolveDoc(docId)`：先按 `getCurrentLocale()` 取；缺失且非基准语言→回退 `zh-CN`，并在返回值带上真实来源 locale。`DocEditor` 据此显示「本页尚无你的语言版本，显示中文版」提示（`data-testid="doc-fallback-notice"`）。
- **每次 openEditor 都读当时的 `getCurrentLocale()`**：切显示语言后新开的文档就是新语言（已打开的 tab 不强制热切）。

## 三类常见任务 → 改哪里

### 任务 A：加/改一篇用户文档（纯内容，不碰 TS）
1. 在 `docs/user/zh-CN/<册>/<页>.md` 写内容，首行必须是 `# 标题`（H1 → tab 标题，`extractH1` 取它）。
2. 文档间互链用**相对路径 + `.md`**（如 `../git/commit.md`、`./faq.md#关键词`），`DocEditor` 的 `resolveDocLink` 解析相对路径 + `#anchor`。
3. 图片放对应 `assets/` 目录，相对引用。
4. **必跑 `pnpm docs:check`**（死链校验，已接入 CI）：校验所有 `[text](相对.md)` 目标存在；`#fragment` 只接受不深验；代码块/行内代码里的 `[](x)` 示例会被剥除不误判。
5. 新文档**自动纳入**——无需注册：main 侧递归遍历磁盘、renderer 全量缓存。只要磁盘有、docId 合法，`DocEditorInput('<docId>')` 就能开。
6. 若这篇文档描述了**用户可见功能的改动**（命令名/快捷键/文案/交互），这正是 CLAUDE.md 要求的「改功能同步 docs/user/」的落点。

### 任务 B：改加载/打包机制
- **main 侧读盘逻辑 / 路径解析**：`main/services/docs/docsMainService.ts`。dev/E2E 的路径解析**必须走 `resolveFromRepo`（walk-up）**，不能用 `app.getAppPath()/../../`（见下「E2E appPath 坑」）。
- **打包 staging**：`scripts/release/runtime-resources.mjs` 的 `stageRuntimeResources` 里 `copyPath(repoRoot/docs/user, stageDir/docs/user)`；`REQUIRED_SOURCE_FILES` 有 sentinel `docs/user/zh-CN/index.md` 供 verify-source/verify-packaged 校验。**electron-builder.yml 不用改**（`.runtime-resources` 整体带入 `resources/`）。
- **renderer 缓存 / 同步 API**：`renderer/services/editor/docRegistry.ts`。改导出 API 前想清楚同步契约（`getName`/`deserialize`），别轻易异步化。
- **预热时机**：`renderer/main.tsx`，`initDocRegistry(await docsService.getDocs())` 必须在 `await import('./contributions/index.js')` 之前。
- **IPC 接线五处**（套路 C）：`shared/ipc/docsService.ts`（契约）、`shared/ipc/channelNames.ts`（`Docs` 通道名）、`main/services/main-services.ts`（`registerSingletonFactory`）、`main/ipc/registerMainServices.ts`（`fromService`）、`main/window/scopedServicesFactory.ts` + `main/index.ts`（`ApplicationServices.docs` 字段 + `accessor.get`）、`renderer/ipc/registerProxyServices.ts`（`toService` 绑定行）。改动 `ApplicationServices` 记得补两个测试桩（`scopedServicesFactory.test.ts` / `windowMainService.test.ts` 里 `docs: {} as ...`）。

### 任务 C：加/改渲染与命令
- **Help 菜单「打开某文档」命令**：`renderer/actions/helpActions.ts`。照 `OpenDocsAction`（开 `index`）/ `OpenEditorGuideAction`（`getting-started/interface-tour`）/ `OpenAgentGuideAction`（`ai-agent/overview`）加一个 Action2：`run` 里 `accessor.get(IEditorService).openEditor(new DocEditorInput('<docId>'))`，挂 `MenuId.MenubarHelpMenu` group `0_docs`，在 `actions/index.ts` 注册（Action2 套路 A）。
- **文档内链接跳转 / 单 tab trail**：`services/editor/openDoc.ts`（`openDocInGroup`：普通导航复用当前 doc tab，`toSide` 另开）；`DocEditor.tsx` 的 `openDocLink`/`resolveDocLink`。单测 `services/editor/__tests__/openDoc.test.ts`。
- **渲染 / 键盘导航**：`DocEditor` **复用 markdown 预览的渲染器与 vimium 式导航**——`MarkdownView`（渲染）、`useMarkdownReaderNav`（f/F link hints、滚动、find、help）、`MarkdownReaderOverlays`、`MarkdownPreviewHelp`。改这些属于 [markdown-subsystem-context] 线②的共享面，动它要同时顾及 markdown 预览与聊天两个消费方。`DocEditor` 自身只是「又一个 markdown 阅读面」。
- **input→组件注册**：`DocEditorInput.TYPE_ID = 'doc'`，路由在 `BuiltInEditorProvidersContribution.ts` + `EditorArea.tsx`（编辑器输入套路，见 apps/editor/CLAUDE.md）。
- `DocEditorInput.focus()` 覆写把焦点送回文档滚动容器（否则 group body 抢焦点、丢 `markdownPreviewFocused` context key，f/Ctrl+F 失效）——与 `MarkdownPreviewInput.focus()` 同理，靠 `MarkdownPreviewRegistry` keyed by resource。

## 易踩坑速记

1. **E2E appPath 坑**（本子系统头号，已修勿回退）：E2E 用 `electron out/main/index.js` 启动，`app.getAppPath()` **不是** `apps/editor` 而是指向更深目录 → 若 dev 路径按 `app.getAppPath()/../../docs/user` 解析会读不到文档，doc center E2E 断言链接可见全挂。**必须**用 extensionHost/tsserver 同款 walk-up `resolveFromRepo(relative)`（从 appPath 向上找到含 `docs/user` 的目录）。
2. **预热时机**：`initDocRegistry` 晚于 editor 恢复 → 恢复的 doc tab `deserialize` 时缓存空，`isDocId` 返回 false，tab 被丢弃。放在 contributions 导入之前。
3. **同步契约别破**：`getName()`/`deserialize` 同步；`docRegistry` 导出 API 保持同步。要动数据源，改成「预热灌缓存」，别把这两处改异步。
4. **docId 路径分隔符**：main 侧 `path.relative` 在 Windows 出 `\`，必须 `.split(path.sep).join('/')` 归一，否则 docId 与 renderer 侧 `/` 分隔的链接对不上。
5. **死链护栏**：加/删文档或改互链后必跑 `pnpm docs:check`（CI 会拦）。链接写相对 `.md`；`#anchor` 不深验但不要写错文件路径。
6. **打包 sentinel**：`runtime-resources.mjs` 的 `REQUIRED_SOURCE_FILES` 有 `docs/user/zh-CN/index.md`——若删了 index.md 或重构目录，verify-source/packaged 会失败，记得同步。
7. **`_template.md` / 非 md 文件**：遍历只收 locale 目录下 `.md`；`assets/*.png` 等非 md 天然忽略，`_` 前缀文件死链校验跳过。别把模板当 docId。
8. **改功能要同步文档**：CLAUDE.md 硬约束——改了用户可见功能（命令名/快捷键/文案/交互）就查 `docs/user/` 有无对应页要更新。

## 验证

```bash
pnpm docs:check                                   # 文档内部相对链接死链校验（已接入 CI；check 会先跑它）
pnpm check                                         # lint+typecheck+test，仅看错误
pnpm --filter @universe-editor/editor build        # e2e 跑 out/ 产物，改 renderer/main 后必重建
cd apps/editor && pnpm exec playwright test smoke.markdownPreview -g "doc center"   # 文档中心端到端（渲染真实文档+链接+键盘导航，验证运行时读盘可用）
node scripts/release/runtime-resources.mjs verify-source   # 校验 docs/user sentinel 存在（stage 前置）
```

## 关键参考路径

- `docs/user/` —— 文档源文件树（`zh-CN/` 基准；`_template.md` 模板；各册 `index/getting-started/ai-agent/editing/search-navigation/git/customization/reference`）
- `docs/plan/user-doc-system-plan/` —— 这套系统的设计文档（目录规范/写作约定/多语言/CI 护栏，00-foundation 是地基说明）
- `apps/editor/src/main/services/docs/docsMainService.ts` —— main 读盘 + 路径解析（packaged vs dev walk-up）+ 缓存降级
- `apps/editor/src/main/services/docs/__tests__/docsMainService.test.ts` —— 读盘/docId 路径化/缺失降级/缓存 单测
- `apps/editor/src/shared/ipc/docsService.ts` —— `IDocsService` 契约 + `DocsByLocale` 类型
- `apps/editor/src/renderer/services/editor/docRegistry.ts` —— 同步缓存 + `initDocRegistry` + `resolveDoc/getDocContent/getDocTitle/isDocId/extractH1`
- `apps/editor/src/renderer/main.tsx` —— bootstrap 预热点（contributions 导入前 `initDocRegistry`）
- `apps/editor/src/renderer/services/editor/DocEditorInput.ts` —— 虚拟 input（resource `universe:/doc/<docId>`、getName=H1、focus 覆写）
- `apps/editor/src/renderer/workbench/editor/DocEditor.tsx` —— 渲染组件（MarkdownView + 复用 useMarkdownReaderNav + locale fallback 提示 + resolveDocLink）
- `apps/editor/src/renderer/services/editor/openDoc.ts` —— `openDocInGroup`（单 tab trail vs toSide），单测 `__tests__/openDoc.test.ts`
- `apps/editor/src/renderer/actions/helpActions.ts` —— Help 菜单命令（OpenDocs/EditorGuide/AgentGuide/ShowReleaseNotes）
- `scripts/release/runtime-resources.mjs` —— staging（拷 docs/user + sentinel 校验）
- `apps/editor/electron-builder.yml` —— `extraResources` 把 `.runtime-resources`（含 docs/user）带入 resources/
- `scripts/check-doc-links.mjs` —— `pnpm docs:check` 死链校验
- `apps/editor/e2e/specs/smoke.markdownPreview.spec.ts`（`-g "doc center"`）—— 文档中心 E2E
- 相关 skill：[markdown-subsystem-context]（渲染器/键盘导航共享面，线②）；跨进程服务套路见 apps/editor/CLAUDE.md 套路 C
- 相关 memory：[[markdown-preview-local-images-app-scheme]]（markdown 渲染相关）

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件
