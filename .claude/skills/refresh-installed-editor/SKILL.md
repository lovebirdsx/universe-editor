---
name: refresh-installed-editor
description: 把主 worktree 最新 main 生产构建后覆盖本机安装版编辑器并重启，用于本地验证最新功能。当用户说刷新安装版 / 更新已安装编辑器 / 把最新 main 装进安装目录 / 覆盖发布版后重启时使用。
disable-model-invocation: true
---

# 刷新本机安装版编辑器

## 用途

在主 worktree 的 main 上拉取最新代码，走完整生产打包链，然后用 win-unpacked 覆盖本机安装版并重启。只改安装目录，不改 userData、注册表、PATH 和快捷方式。

## 关键：脚本必须独立于编辑器运行

编辑器用 Windows Job Object（`KILL_ON_JOB_CLOSE`）管理本地子进程树；从编辑器内启动的普通子进程会随编辑器关闭一起被杀。脚本默认只在前台预检，然后用 WMI `Win32_Process.Create` 启动一个不在该 Job 内的 worker，由 worker 完成等待、构建、关闭、覆盖和重启。

## 执行时机：等调用会话结束

调用本 skill 的 Claude 会话（环境里的 `CLAUDE_PID`）结束时会有一段收尾延迟。worker 启动后**先等待该进程退出**，会话结束前不做任何同步或构建，避免构建/关闭打断正在收尾的会话。

因此默认执行后：

1. 前台立即返回，打印 worker PID、日志和结果文件路径。
2. worker 在后台等待当前会话结束（关闭 Agent 聊天标签页或退出 Claude CLI）。
3. 会话进程退出后才开始拉取、依赖安装和生产构建；构建成功后才关闭编辑器。
4. worker 独立完成关闭、覆盖并重新启动编辑器。

**调用后请主动结束当前会话**，否则 worker 会一直等待。想跳过等待、立即执行时加 `--no-wait-session`。

注意：编辑器默认会在会话闲置约 5 分钟后回收 agent 进程（配置 `acp.idleProcessTimeoutMs`），进程被回收也会被视为「会话结束」并触发后续流程。

不要在 worker 运行期间重复触发；脚本用 `%TEMP%\refresh-installed-editor\run.lock.json` 防并发。

## 关闭编辑器：与 File → Exit 等价

**不使用 taskkill 强杀，也不逐个窗口发 WM_CLOSE。** worker 在安装版运行时启动 `Universe Editor.exe --quit`：第二个实例拿不到 single-instance 锁，会把参数转发给主实例；主实例走 `app.quit()` 管线——与 File → Exit 相同，`before-quit` 先 `captureSessionForQuit()` 快照全部窗口，再在 `will-quit` 清理异常退出 sentinel。因此不会「关一个窗口重写一次 session」导致下次只恢复最后一个窗口，也不会触发「编辑器异常退出」提示。

- 发送退出请求后只轮询等待安装目录进程全部消失，**超时也不会强杀**：worker 以失败结束，安装目录不动，编辑器保持运行。
- 未保存文件或运行中的会话会照常弹出确认框，确认后编辑器才退出。worker 会先等待调用会话结束，通常不会遇到会话确认。
- 若编辑器长时间不退出，手动 `File → Exit` 后加 `--skip-build` 重跑。

`--quit` 是编辑器主进程的启动参数：已有实例时由 second-instance 转发给主实例；没有实例时冷启动直接退出，不创建窗口。

## 一键命令

先预检：

```bash
node .claude/skills/refresh-installed-editor/refresh-installed-editor.mjs --dry-run
```

预检无误后正式执行：

```bash
node .claude/skills/refresh-installed-editor/refresh-installed-editor.mjs
```

默认使用主 worktree 的 main、prod 打包环境、跳过 release notes 发版门禁；worker 等当前会话结束后开始构建，构建成功后正常关闭、覆盖并重启。

## 默认流程

| 阶段 | 动作 |
|---|---|
| 预检 | 定位主 worktree（必须是 main）、检查工作区与 submodule 干净、`.env.prod` 存在、安装目录存在、记录当前进程与版本 |
| 等待会话 | 等待 `CLAUDE_PID` 退出；`--no-wait-session` 跳过，`--session-wait-timeout` 设置上限 |
| 同步 | 主 worktree 执行 `git pull --ff-only --no-recurse-submodules`，随后 `git submodule update --init --recursive` |
| 依赖 | `pnpm-lock.yaml`、workspace、根 manifest、`.npmrc`、patches 变化时执行 `pnpm install --frozen-lockfile` |
| 构建 | 主 worktree 执行生产打包（等价于 `package:win:dir`），产出 win-unpacked 目录 |
| 关闭 | 运行 `"Universe Editor.exe" --quit`（等价于 File → Exit，先快照全部窗口），等待正常退出；超时则失败，不强杀 |
| 覆盖 | `robocopy /E` 覆盖安装目录；保留卸载器、`app-update.yml`、`elevate.exe` 等安装器专属文件 |
| 校验 | 比较 exe/app.asar 大小与时间戳、确认卸载器存在，并运行 `verify-packaged` |
| 重启 | 清理 E2E/自定义 userData 等环境变量，detached 启动安装版，等待进程出现 |

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--dry-run` | 关 | 只预检并打印计划，不执行任何写操作 |
| `--foreground` | 关 | 在当前进程执行完整流程；编辑器外调试用，会跳过等待调用会话（前台等待会死锁） |
| `--skip-build` | 关 | 跳过拉取/依赖/构建，复用现有产物；用于覆盖失败后的重跑 |
| `--skip-pull` | 关 | 不拉取 main，允许主 worktree 有本地改动 |
| `--env <mode>` | `prod` | 打包环境，读取主 worktree 的 `.env.<mode>` |
| `--strict-notes` | 关 | 不跳过 release notes 发版门禁 |
| `--no-restart` | 关 | 覆盖后不启动编辑器 |
| `--no-wait-session` | 关 | 不等待调用会话结束，worker 立即执行 |
| `--session-wait-timeout <秒>` | `0`（不限） | 等待调用会话结束的上限；超时中止且不做任何写操作 |
| `--install-dir <path>` | `%LOCALAPPDATA%\Programs\Universe Editor` | 安装目录 |
| `--main-worktree <path>` | 自动探测 | 主 worktree 路径 |
| `--grace-timeout <秒>` | 60 | 发送关闭请求后等待正常退出的上限；超时只报错，不强杀 |
| `--allow-missing-env` | 关 | `.env.<mode>` 缺失时继续 |

## 结果与日志

- 最近一次结果：`%TEMP%\refresh-installed-editor\last-result.json`（包含 `ok`、`exitCode`、`message`、`logFile`）。
- 每次运行的完整日志：`%TEMP%\refresh-installed-editor\<runId>\run.log`。
- 等待会话、构建输出、关闭、覆盖、重启日志都在 run.log 中。
- 编辑器重启后，可让 Claude 读取 last-result.json 和日志尾部确认结果。

## 失败恢复

| 失败阶段 | 编辑器状态 | 恢复方式 |
|---|---|---|
| 预检 / pull / 依赖 / 构建 | 未关闭，可继续使用 | 查看日志修复后重跑；若产物已完整可加 `--skip-build` |
| 等待会话超时 | 未关闭，未做任何写操作 | 结束会话后重跑，或加 `--no-wait-session` |
| 关闭进程 | 编辑器保持运行（--quit 被确认框拦下或未响应） | 脚本不强杀；手动 File → Exit 后加 `--skip-build` 重跑 |
| 覆盖/校验 | 已关闭，可能半覆盖 | 修复文件占用/磁盘后加 `--skip-build` 重跑；`robocopy /E` 可重复执行 |
| 重启 | 已关闭，安装目录已更新 | 手动运行安装目录下的 `Universe Editor.exe` |

脚本不会自动 stash、reset、clean 或 push；主 worktree 脏、submodule 有本地改动、分支不是 main 时直接中止。

## 注意事项

- 执行前先保存编辑器内未保存的文件和正在运行的 Agent 会话。正常关闭遇到未保存确认会等待；超时后脚本失败而不是强杀。
- 主 worktree 必须干净且位于 main；不会自动处理未提交改动。
- 默认使用 prod 打包环境，要求主 worktree 存在 `.env.prod`；缺失时用 `--env dev` 或 `--allow-missing-env`。
- 构建可能持续数分钟到十几分钟；worker 独立运行，不要重复触发。
- 只关闭安装目录下的进程，不会影响 dev 实例或其他 worktree 的绿色版；但安装目录外若已有实例占用同一 userData，重启可能被单实例锁转发，日志会报错。
- `%LOCALAPPDATA%\Programs\Universe Editor` 是 NSIS per-user 安装目录；脚本不修改注册表、PATH、快捷方式或 userData。
