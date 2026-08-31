---
name: scm-host-scoped-path-gating
description: SCM 线上契约是裸 host 路径，门控必须按主机作用域（scmHostPath）而非 scheme 白名单
metadata:
  type: project
---

SCM 域「resource → 查表/路由用的路径」一律走 `apps/editor/src/renderer/services/scm/scmHostPath.ts` 的 `scmHostPath(resource, remoteAuthority)`：本地窗口只收 `file:`，远程窗口只收 `remote-ssh:` 且 authority 两侧过 `normalizeRemoteAuthority` 后相等，off-host 返回 `undefined`。

**Why**：SCM 线上契约（`ISourceControlResourceStateDto.resourceUri` / `rootUri`）携带的是**裸 host fs-path 字符串**（扩展宿主只认自己那台机器的路径），所以每次查表/路由的键都是 host 路径而非 URI。由此两条都是 bug：
- 裸 `resource.scheme === 'file'` 门控 → 远程资源（`remote-ssh`）直接短路，2026-08 曾致远程工作区 Explorer 的 gitignore 变暗**整体失效**（git 扩展本就跑在远端、`check-ignore` 通的，只差 renderer 这层判定）。
- 裸 `scmPathKey(resource.fsPath)` 查表 / 裸 `fsPath` 喂 `resolveScmProviderId` → 远程窗口里也能打开本地 `file:` 资源，Windows 远端的 `C:\repo\a.ts` 与本机同名路径按 `fsPath` 跨主机误命中，把另一台机器的 git 状态 / HEAD 画到本地文件上。

**How to apply**：装饰查表只走 `IScmDecorationsService.getFile/getFolder`（内部已过 `scmHostPath`），别自己拼键。authority 在 React 里取 `useRemoteAuthority()`（订阅 `onDidChangeWorkspace`，**不要** `useMemo` 裸读 `workspace.current`，见 [[agent-settings-remote-authority-routing]]），非 React 取 `currentRemoteAuthority(workspace.current)`，Action2 里须在任何 `await` 之前同步取（见 [[action2-async-accessor-invalidation]]）。命令式读 authority 的服务要自己给出变更信号——`ScmDecorationsService` 把 workspace epoch 读进 `decorations` derived，否则切工作区时快照不变、旧颜色粘住。**非 SCM 的「file-backed 资源」门控**（Explorer auto-reveal、tab 文件图标、拖拽 uriList）不需要主机作用域，用既有的 `isFileSystemUri`（同时接受 `file` 与 `remote-ssh`）即可。

已收敛的调用点：`ScmIgnoredResourcesService`、`ScmDecorationsService`、`ExplorerView`、`EditorGroupView`、`ExplorerContextMenu`、`useEditorGroupScopedContextKey`（editor 标题栏 `resourceScmProvider`）、`layoutActions` 的 `ShowScmAction`、`dirtyDiffActions` 的 open-changes、`DirtyDiffContribution._bind`、`ScmView` 的 changelist 拖拽落点。约定写在 `apps/editor/src/renderer/workbench/scm/CLAUDE.md`。相关：[[path-comparison-convergence]]、[[remote-dev-v2-full-stack]]。
