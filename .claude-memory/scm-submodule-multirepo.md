---
name: scm-submodule-multirepo
description: SCM 支持 git submodule 多 repo 显示，命令路由用 rootUri 而非 source control id
metadata: 
  node_type: memory
  type: project
  originSessionId: 1a9da2ca-57fd-4850-b9e9-25a6ed5af1db
---

SCM 视图现已支持 git submodule：主 repo + 每个已初始化 submodule 各作为独立 SourceControl provider（独立 commit box / 暂存·工作区分组 / stage·commit·push）。仿 VSCode。

**关键设计决策**：所有 git source control 的 `id` 固定为 `'git'`（菜单 when 子句与 `isGitProvider = model.id === 'git'` commit 按钮逻辑依赖它），因此命令无法用 id 区分 repo。路由改用每 repo 唯一的 **`rootUri`**：
- provider/group 级命令：renderer 传 `{ rootUri, sourceControlId }`（ScmView.tsx / ScmViewToolbar.tsx）。
- 资源/文件夹级命令：用 arg 里的绝对 `resourceUri` 做**最长前缀匹配**（submodule root 是 main root 子路径，最长者命中 submodule）。
- 兜底返回 main repo。
路由集中在 `extensions/git/src/repositoryManager.ts` 的 `RepositoryManager.resolveRepo(arg)`，`norm()` 统一正斜杠 + 去尾斜杠 + Windows 盘符小写。

**范围决策**：仅主 repo 显示状态栏分支/同步条目（submodule 信息走 provider header label `Git: <name>`）；启动时发现一层 submodule，不监听 `.gitmodules` 动态增删、不递归嵌套。submodule 发现逻辑抽到 `repoDiscovery.ts`（`git submodule status` 解析），被 extension.ts 与 gitGraphSource.ts 共用。

本仓库 `vendor/claude-agent-acp` 是真实 submodule，可用 `pnpm dev` 手测验证。相关：[[extension-system-progress]]
