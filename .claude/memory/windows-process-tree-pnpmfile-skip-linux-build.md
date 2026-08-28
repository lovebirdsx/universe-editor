---
name: windows-process-tree-pnpmfile-skip-linux-build
description: WSL/Linux pnpm install 报 not found make 的根因与修法；pnpm 11 下 binding.gyp 使 readPackage 剥 install 脚本无效，须用 updateConfig 改 allowBuilds
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-15T13:57:33.673Z
---

WSL Ubuntu `pnpm install` 报 `gyp ERR! not found: make`（2026-08-15 修复）：`@vscode/windows-process-tree` 无 prebuild/os 字段，install 脚本 `node-gyp rebuild` 被 `allowBuilds` 放行，Linux 上也现场编译。

**Why:** 运行时懒加载 + win32 守卫（processList.ts）拦不住安装期构建；且 pnpm 11 对 tarball 含 `binding.gyp` 的包恒判 requiresBuild 并重注入 `scripts.install`，所以 `readPackage` hook 删 install/gypfile 字段**无效**。

**How to apply:** 用根 `.pnpmfile.cjs` 的 `updateConfig` hook 在非 win32 把 `config.allowBuilds['@vscode/windows-process-tree'] = false`（显式 false=禁止构建且不报 ERR_PNPM_IGNORED_BUILDS），Linux 装出空壳即可、无需 build-essential。副作用：lockfile 会多 `pnpmfileChecksum` 字段，pnpmfile 内容变更会导致 `--frozen-lockfile` 校验不匹配。相关：[[remote-dev-v2-full-stack]]
