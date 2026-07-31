---
name: win32-spawnsync-cmd-caret-escaping
description: "Windows spawnSync shell:true 走 cmd，裸 ^ 等元字符被吞——turbo filter `pkg^...` 静默变 `pkg...`，参数须包双引号"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5a8dfb6e-ab4d-409e-86bc-347ca327832f
---

Node `spawnSync(cmd, args, { shell: true })` 在 Windows 走 cmd.exe，参数里的裸 `^` 是 cmd 转义符会被**静默吞掉**（`!` 在延迟展开下同理）。实例：`scripts/test-changed.mjs` 传 turbo `--filter=@universe-editor/editor^...`（只 build 上游），经 cmd 变成 `--filter=...editor...`（含自身），把要跳过的 electron-vite 重 build 又拉了回来——单测断言数组值全绿，运行时才露馅。

**Why:** shell:true 是为了能 spawn `pnpm.CMD`，但代价是参数再过一层 cmd 解析；单测测不到这层（测试断言的是 JS 数组，转义发生在 spawnSync 拼接命令行时）。

**How to apply:** win32 下给含 cmd 元字符（`^ & | < > !`）的参数整体包双引号（cmd 双引号内 `^` 字面保留，且引号经 pnpm.CMD → node 逐层正确剥除）：`process.platform === 'win32' ? `"${arg}"` : arg`。修复见 test-changed.mjs 的 quoteFilter。验证方式 = `turbo --dry-run=text` 看 Packages in scope 是否含预期外的包。相关：[[cli-stdin-hang-on-prompt]]
