# apps/editor/src/renderer/workbench/scm/CLAUDE.md

本目录是 SCM 域 workbench 侧的家：SCM 视图（`ScmView.tsx`）、mergeConflict、dirty-diff 的视图代码（`dirtyDiff/`，gutter 色条与内联 peek）；dirty-diff 的服务端在 `services/scm/`。本文是 SCM 视图侧 + 多 provider 仲裁的上下文地图（处理相关任务前通读）。dirty-diff 内联 peek 的完整案例复盘在 [cases-dirty-diff-peek.md](cases-dirty-diff-peek.md)。

## 多 provider 仲裁与双格式冲突标记（SCM 可视化泛化）

gutter / peek / blame / open-changes 对 git 与 perforce 共用同一套 renderer 代码，provider 只在**数据路由层**出现：

- **🔴「resource → host path」一律走 `scmHostPath(resource, remoteAuthority)`**（`services/scm/scmHostPath.ts`）。SCM 线上契约携带的是**裸 host fs-path 字符串**，门控必须按**主机作用域**而非 scheme 白名单：远程窗口里也能打开本地 `file:` 资源，Windows 远端的 `C:\repo\a.ts` 与本机同名路径按 `fsPath` 会跨主机误命中。**禁止**裸 `resource.scheme === 'file'` 门控（曾致远程 gitignore 变暗整体失效）与裸 `scmPathKey(resource.fsPath)` 查表；装饰查表只走 `IScmDecorationsService.getFile/getFolder`（内部已过 scmHostPath）。authority 在 React 里取 `useRemoteAuthority()`（不要 `useMemo` 裸读 `workspace.current`），非 React 取 `currentRemoteAuthority(workspace.current)`；Action2 里须在任何 `await` 之前同步取。
- **仲裁**：`resolveScmProviderId(sourceControls, fsPath, selectedRootUri?)`（`services/extensions/ScmService.ts`）——selectedRootUri 命中的归属者优先，未命中回退最长前缀；同 root 多 provider 首个命中者赢。消费方从 `scmViewState.selectedRepo` 取当前选择，并挂 `sourceControls` 的 autorun：启动竞态——selectedRepo 从 storage 恢复时目标 provider 的 source control 可能还没注册，仲裁回退到最长前缀；provider 后注册时必须重仲裁，否则回退结果一直粘住。blame 侧另配 `_refreshSeq` 代次守卫：回退 provider 的慢 fetch 后完成时不得覆盖新仲裁结果。
- **selectedRepo 的持久化在 workbench 层**（`ScmSelectedRepoContribution`，仿 `OutlineViewStateContribution`）：恢复+写回都不依赖 ScmView 挂载（曾放 ScmView 的 React effect 里，SCM 面板不打开就不恢复，blame/dirty-diff 仲裁一直停在最长前缀回退）。hydrate 只在无内存值时应用存储值，写回 autorun 无 first-pass skip。ScmView 只消费 `scmViewState.selectedRepo`。
- **选中仓库仲裁有两类语义，别混**：**显示类**（Explorer/标签页装饰 `ScmDecorationsService.decorations`、状态栏条目、ActivityBar 徽章）**全局跟随选中仓库**——装饰侧走 `resolveSelectedSourceControl(sourceControls, selectedRootUri)` 在 derived 里只取选中者；状态栏侧由 `ActiveRepoSyncContribution` 对每个 provider 广播 `<providerId>.setActiveRepo`（选中者发 rootUri、其余不传参——显式 undefined 跨 IPC 会变 null，接收端一律 `== null` 判定），git/p4 各自 `setVisible(false)` 全 hide（可见性用 `mgr.has(root)` 独立标志，**不能**读有回退语义的 `mgr.active`）。**行为类**（gutter dirty-diff、blame、open-changes 路由）仍按 **per-path** 仲裁（`resolveScmProviderId`）——同一文件同属两 provider 时跟随选中，只归未选中 provider 的文件照常可用。**「有没有改动」门控与显示解耦**：`IScmDecorationsService.hasChanges(resource)` 跨**所有** provider 判定（`_anyProviderChanges` derived），供 dirty-diff 门控与 `scmActiveResourceHasChanges` context key 用——显示可以只画选中仓库，但选中 git 时 p4 文件的「打开更改」入口不能消失。
- **缓存分槽防串扰**：`DirtyDiffContribution` / `ScmBlameContribution` 的缓存 key = `providerId + '\n' + path`；切 repo 时不清缓存，旧槽保留供切回秒显。
- **ignored 变暗按 `selectedRepo` 仲裁**（`services/scm/ScmIgnoredResourcesService.ts`，git/p4 共用 `<providerId>.checkIgnore` 通路）：`_flush()` 必须把 `scmViewState.selectedRepo.get()` 作第三参传进 `resolveScmProviderId`（漏传永远按最长前缀选 git）。与 dirty-diff/blame **刻意不同，它不分槽**：切 repo 整体 `_invalidate()` 重查——ignored 缓存是布尔、一条批量命令就能重解析，dirty-diff/blame 缓存的是 HEAD 正文/annotate（昂贵）。同理它也订阅 `sourceControls`。
- **Explorer working-tree hint（`ScmWorkingTreeHintService`，p4 的 `<providerId>.checkWorkingTree`）同样按 `selectedRepo` 仲裁**，两处必改：①仲裁 autorun 必须同时 read `scmViewState.selectedRepo`——SCM 源切换只改 selectedRepo 不改 sourceControls，漏读则文件 LRU 永久残留；②`_flush()` 第三参同 ignored。**缓存按 provider id 分槽**（嵌套 `Map<providerId, Map>`）：切 repo 只改读取过滤 + bump version、不清数据——读取时 `_ownerProviderId` 与 `_visibleProviderId` 不一致即返回 undefined。git 无 checkWorkingTree 命令，切到 git 后重查落 clean、提示整体消失。目录漂移的权威来源是 provider 的 `resourceStates` 常驻分组。
- **blame 状态栏点击**走内部命令 `scm.blame.openCommit` → 派生命令 `` `${providerId}-graph.view` ``（`git-graph.view` / `perforce-graph.view` 均为 renderer Action2）；该命令未注册时状态栏项不带 command。
- **配置在 `scm.*` 命名空间**（`ScmConfigurationContribution`）：`scm.blame.*`（6 项）+ `scm.mergeEditor` + `scm.diffDecorations`（`all|gutter|overview|minimap|none`，派生纯函数 `resolveDirtyDiffDecorationsVisibility` 在 `contributions/dirtyDiff.ts`）。扩展只读不写；git 扩展的 `git.blame.*` / `git.mergeEditor` 已删。
- **dirty-diff 装饰画三处**（gutter 色条 / 总览标尺 / minimap 色带），颜色**必须传具体 hex**：standalone monaco 的主题色表只含 `editor*`/`diffEditor*` 前缀，传 ThemeColor `{id}` 解析不到 `minimapGutter.*` 会静默不画。`_resolveColors()` 用 `normalizeColor(theme.getColor(id))` 归一成 6/8 位 hex；**主题切换必须两步走**（重算 `_colors` + 重新 `collection.set(...)`）——monaco 自己的颜色缓存失效只遍历 overviewRuler 桶，纯 minimap decoration 不会被刷新。`_render` 是唯一写 `_regions` + `_navigation.setState` 的入口，主题/配置变更只走 `_applyDecorations()`。
- **shift+alt+y 是唯一 open-changes 入口**：renderer Action2 `workbench.action.scm.openChanges`（`actions/dirtyDiffActions.ts`，四合一：快捷键 / 标题栏图标 / 命令面板 / explorer 右键 `3_compare` 组）。`*.openChange` 已降级为纯 provider 能力命令（仅作 SCM 行 `resource.command` 与统一委派目标），无参 fallback 已删；两扩展 manifest 不得再自建 `editor/title`/`explorer/context` 条目（各 `__tests__/openChangeContribution.test.ts` 守护——重复条目的症状是同属两 provider 的文件出现两个对比图标）。**只有「拿到基线」归 renderer**：目标 == 活动 FileEditorInput 且 `getHeadContent` 返回非 null 时走 buffer-aware，其余一律委派 `<providerId>.openChange`。`getHeadContent` 把「无基线」与「取失败」都塌缩成 `null`，只有 provider 分得清——renderer 自作主张拼空左侧会把两者都渲染成「整个文件新增」。
- **mergeConflict/conflictParser.ts 单状态机识别两种标记格式**：git 七字符（`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`）与 p4 四字符（`>>>> ORIGINAL`→base、`==== THEIRS`→incoming、`==== YOURS`→current、`<<<<`→结束；YOURS 可省略 = 空 current 侧）。安全依据：生成者互斥、开始标记互不前缀、块内转移只认当前格式标记、残缺块在下一个开始标记处整体丢弃。`CONFLICT_START_MARKERS` 供 `inlineConflictController` 预筛。
- 验证单测：`ScmService.test.ts`（仲裁）/ `ScmIgnoredResourcesService.test.ts`（p4 路由、嵌套 git-in-p4 切换）/ `ScmWorkingTreeHintService.test.ts` / `conflictParser.test.ts`（双格式）/ `ScmBlameContribution.test.ts`（后注册重仲裁）；e2e `extensions/perforce/e2e/specs/{perforceDirtyDiffBlame,perforceIgnored}.spec.ts`。

## 案例：dirty-diff 内联 peek

完整复盘（骨架/布局公式/Esc 接线/E2E 套路/易踩坑/参考路径）已迁至 [cases-dirty-diff-peek.md](cases-dirty-diff-peek.md)——在某行下方弹真 Monaco diff editor 的浮层，做 peek 相关改动前通读。一句话结论：**别手写 DOM diff**；用 overlay-widget + 空 view-zone 占位内嵌 `createDiffEditor`。相关 memory [[dirty-diff-inline-peek-feature]] / [[linediff-myers-perf]]（Myers 约束**仅 gutter region 用，peek 面板不用**）；skills [fix-disposable-leak] / [register-monaco-command] / [fix-keybinding-not-firing]。

## 验证

```bash
pnpm check
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts smoke.dirtyDiffPeek
pnpm --filter @universe-editor/git build            # 动了 Stage 后端（git 扩展 dist）
```

## 其它

- 后续用本文，发现新经验，需同步更新本文件
