---
name: codex-session-skills-scan-slow
description: codex 新建 session 慢 5 秒的真因是 thread/start 内 spawn 的 git rev-parse --git-dir 子进程在 Windows 下挂起 ~4.5s（与目录是否为 git 仓库相关，非大小、非 skills）
metadata: 
  node_type: memory
  type: project
  originSessionId: afdee6a6-4c00-425a-beff-5cc0d554bf1b
---

内置 codex ACP agent 新建/恢复 session 慢 ~5 秒(恒定 5.1s)。**触发条件:cwd 是 git 仓库**(仓库大小无关，全新 1 文件的 tiny 仓库一样慢;非 git 目录 ~127ms 秒开)。这解释了用户观察:`D:/git_project/universe-editor` 慢、`F:\test\test`(非 git)快、命令行 `codex exec`/TUI 在同目录也快。

**根因(日志+受控实验铁证):** codex 原生二进制(`@openai/codex` 0.142.2) 在处理 `thread/start` RPC 时会同步 spawn 一个 `git -c core.hooksPath=NUL -c core.fsmonitor=false rev-parse --git-dir` 子进程。该 git 进程在 Windows 下 **CPU=0、无 TCP 连接、无 git-lfs 子进程、纯挂起不退出 ~4.5 秒**(像一个固定超时)，codex `wait()` 它后才让 thread/start 返回。
- 决定性验证:gap 期间主动 `Stop-Process` 杀掉那个挂起的 git → thread/start **立即从 5150ms 降到 1861ms**。
- 100ms 间隔追踪:多个 git 在 <1s 完成，唯独这一个 git 进程从 ~0.9s 挂到 ~5.4s。
- `codex exec`/TUI 无此 gap:git 探测推迟到 turn 内(`built_tools→load_discoverable_tools`)，与 LLM 请求重叠，不阻塞会话创建。这是 app-server 模式特有。

**已逐一证伪(不要再查):** skills 扫描(skills/list 仅 47ms)、shell_snapshot、git ls-remote/github plugins、plugin marketplace sync、网络(gateway /models 端点 0.03s)、目录大小、sandbox(elevated/danger-full-access 都慢)、list_models online 解码失败(gateway 返回 `{data:[]}` 而 codex 期望 `{models:[]}`，但两边都 fallback 到 models_cache，不阻塞)、代理 env、CPU 计算。GIT_TERMINAL_PROMPT/OPTIONAL_LOCKS/ASKPASS/CONFIG_NOSYSTEM、本地禁用 filter.lfs 均无效。Node 各种 spawn(detached/windowsHide/stdio 组合)都无法复现挂起 → 是 codex(Rust)进程创建方式特有，外部环境变量解决不了。

**Why:** git 挂起的精确内核原因是 codex 原生二进制黑盒行为，外部手段不可再分解。系统级 git 配置含 `filter.lfs.process`/`filter.lfs.required=true`(git-lfs)，但禁用后仍慢，已排除。git 版本 2.54.0.windows.1。

**How to apply:** 修复方向(待定，未实施):此问题在 codex 原生二进制内，**adapter `vendor/codex-acp` 无法直接修**(cwd 是 thread/start 必传参数)。可选路径:(1) 升级/降级 codex 原生二进制版本试规避(关注 openai/codex issue #14795 "timeout waiting for child process to exit"、Windows git 相关 #29408/#22085);(2) 向 codex 上游报 bug;(3) 编辑器侧权衡。**严禁污染 fork 源码**(用户红线:`vendor/codex-acp/src/*` 保持干净，便于上游合并;PostToolUse prettier 会重排整文件)。受控实验套路:spawn `codex app-server`，按 newline-JSON-RPC 发 initialize→thread/start{cwd,config:{}} 测耗时;用 PowerShell `Get-CimInstance Win32_Process` 抓 git 子进程。codex 内部 trace 日志在 `~/.codex/logs_2.sqlite`(表 logs);`RUST_LOG=trace` 输出到 stderr。关联 [[codex-three-auth-modes]]。
