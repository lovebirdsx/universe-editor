---
name: win32-spawnsync-cmd-caret-escaping
description: "Windows 上 spawn cmd 中转的参数转义：裸 ^ 被 cmd 吞；包双引号会字面进 argv 也不可靠——正确做法是 caret 转义（^^），空格无解须显式报错"
metadata: 
  node_type: memory
  type: project
---

Windows 上要经 cmd 执行 `.cmd` shim（spawn `.cmd` 直连被 CVE-2024-27980 防护拒 EINVAL），但 `spawnSync(cmd, args, { shell: true })` 在 Node 22.6+ 触发 DEP0190 且 node 仅拼接不转义——参数要再经一层 cmd 解析，两条实测结论：

1. **裸 `^` 等元字符被 cmd 静默吞掉**：turbo filter `pkg^...` 变 `pkg...`，把要跳过的上游重 build 又拉回来（实例见 test-changed.mjs 的 buildFilters）。
2. **给中间参数包双引号也不可靠**：`cmd /d /s /c` 与无 `/s` 均只在命令串**首字符是引号**时才剥首尾引号；中间参数的 `"` 会**字面进入子进程 argv**（`node probe "--filter=x^..."` → argv 是 `"--filter=x^..."` 含引号，turbo 把它当 task 名报 `Could not find task`）。旧教训「包双引号」依赖 pnpm 内部剥引号的巧合，不可复现到所有中转。

**Why:** shell:true 是为了找到 `pnpm.CMD`，但转义行为实测为准——cmd 的引号/^ 语义与直觉相反，且单测测不到（断言的是 JS 数组，转义发生在拼接命令行时）。

**How to apply:** win32 下显式 spawn `cmd.exe ['/d','/s','/c', cmdString]`（无 shell 选项 → 无 DEP0190），参数做 **caret 转义**：`[&|<>^]` 前加 `^`（`^` 自身写 `^^`），不用引号；**空格无法 caret 转义**（cmd 不为它分组），受控 args 含空格/引号时显式报错而非静默错传。实现见 test-changed.mjs 的 `spawnPnpm`/`escapeCmdArg`。验证方式 = 真实链路跑一遍（改叶子包源码跑 `test-changed --check`，看 turbo 任务分发）+ 探针脚本打印 argv。相关：[[cli-stdin-hang-on-prompt]]
