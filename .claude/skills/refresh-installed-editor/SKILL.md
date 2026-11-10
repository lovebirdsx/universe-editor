---
name: refresh-installed-editor
description: 把主 worktree 最新 main 生产构建后覆盖本机安装版编辑器并重启，用于本地验证最新功能。当用户说刷新安装版 / 更新已安装编辑器 / 把最新 main 装进安装目录 / 覆盖发布版后重启时使用。
disable-model-invocation: true
---

# 刷新本机安装版编辑器

## 用途

在主 worktree 的 main 上拉取最新代码，走完整生产打包链，然后用 win-unpacked 覆盖本机安装版并重启。只改安装目录，不改 userData、注册表、PATH 和快捷方式。

## 关键：脚本必须独立于编辑器运行

编辑器用 Windows Job Object（`KILL_ON_JOB_CLOSE`）管理本地子进程树；从编辑器内启动的普通子进程会随编辑器关闭一起被杀。脚本默认只在前台预检，然后用 WMI `Win32_Process.Create` 启动一个不在该 Job 内的 worker，由 worker 完成构建、关闭、覆盖和重启。

因此默认执行后：

1. 前台立即返回，打印 worker PID、日志和结果文件路径。
2. worker 在后台继续构建；构建成功后才关闭编辑器。
3. 编辑器关闭时，Claude 会话/当前终端会退出，这是正常现象。
4. worker 独立完成覆盖并重新启动编辑器。

不要在 worker 运行期间重复触发；脚本用 `%TEMP%\refresh-installed-editor\run.lock.json` 防并发。

## 一键命令

先预检：

```bash
node .claude/skills/refresh-installed-editor/refresh-installed-editor.mjs --dry-run
```

预检无误后正式执行：

```bash
node .claude/skills/refresh-installed-editor/refresh-installed-editor.mjs
```

默认使用主 worktree 的 main、prod 打包环境、跳过 release notes 发版门禁，并在构建成功后关闭、覆盖、重启。

## 默认流程

| 阶段 | 动作 |
|---|---|
| 预检 | 定位主 worktree（必须是 main）、检查工作区与 submodule 干净、`.env.prod` 存在、安装目录存在、记录当前进程与版本 |
| 同步 | 主 worktree 执行 `git pull --ff-only --no-recurse-submodules`，随后 `git submodule update --init --recursive` |
| 依赖 | `pnpm-lock.yaml`、workspace、根 manifest、`.npmrc`、patches 变化时执行 `pnpm install --frozen-lockfile` |
| 构建 | 主 worktree 执行生产打包（等价于 `package:win:dir`），产出 win-unpacked 目录 |
| 关闭 | 只匹配可执行路径在安装目录下的进程；先 `taskkill /PID` 优雅关闭，超时后 `/T /F` |
| 覆盖 | `robocopy /E` 覆盖安装目录；保留卸载器、`app-update.yml`、`elevate.exe` 等安装器专属文件 |
| 校验 | 比较 exe/app.asar 大小与时间戳、确认卸载器存在，并运行 `verify-packaged` |
| 重启 | 清理 E2E/自定义 userData 等环境变量，detached 启动安装版，等待进程出现 |

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--dry-run` | 关 | 只预检并打印计划，不执行写操作 |
| `--foreground` | 关 | 在当前进程执行完整流程；编辑器外调试用，编辑器内会被关闭打断 |
| `--skip-build` | 关 | 跳过拉取/依赖/构建，复用现有产物；用于覆盖失败后的重跑 |
| `--skip-pull` | 关 | 不拉取 main，允许主 worktree 有本地改动 |
| `--env <mode>` | `prod` | 打包环境，读取主 worktree 的 `.env.<mode>` |
| `--strict-notes` | 关 | 不跳过 release notes 发版门禁 |
| `--no-restart` | 关 | 覆盖后不启动编辑器 |
| `--install-dir <path>` | `%LOCALAPPDATA%\Programs\Universe Editor` | 安装目录 |
| `--main-worktree <path>` | 自动探测 | 主 worktree 路径 |
| `--grace-timeout <秒>` | 15 | 优雅关闭等待上限 |
| `--allow-missing-env` | 关 | `.env.<mode>` 缺失时继续 |

## 结果与日志

- 最近一次结果：`%TEMP%\refresh-installed-editor\last-result.json`（包含 `ok`、`exitCode`、`message`、`logFile`）。
- 每次运行的完整日志：`%TEMP%\refresh-installed-editor\<runId>\run.log`。
- 构建输出、关闭、覆盖、重启日志都在 run.log 中。
- 编辑器重启后，可让 Claude 读取 last-result.json 和日志尾部确认结果。

## 失败恢复

| 失败阶段 | 编辑器状态 | 恢复方式 |
|---|---|---|
| 预检 / pull / 依赖 / 构建 | 未关闭，可继续使用 | 查看日志修复后重跑；若产物已完整可加 `--skip-build` |
| 关闭进程 | 可能部分关闭，安装目录未动 | 手动关闭后重跑；或加 `--skip-build` 跳过构建 |
| 覆盖/校验 | 已关闭，可能半覆盖 | 修复文件占用/磁盘后加 `--skip-build` 重跑；`robocopy /E` 可重复执行 |
| 重启 | 已关闭，安装目录已更新 | 手动运行安装目录下的 `Universe Editor.exe` |

脚本不会自动 stash、reset、clean 或 push；主 worktree 脏、submodule 有本地改动、分支不是 main 时直接中止。

## 注意事项

- 执行前先保存编辑器内未保存的文件和正在运行的 Agent 会话。优雅关闭可能等待确认，超时后会强杀。
- 主 worktree 必须干净且位于 main；不会自动处理未提交改动。
- 默认使用 prod 打包环境，要求主 worktree 存在 `.env.prod`；缺失时用 `--env dev` 或 `--allow-missing-env`。
- 构建可能持续数分钟到十几分钟；worker 独立运行，不要重复触发。
- 只关闭安装目录下的进程，不会影响 dev 实例或其他 worktree 的绿色版；但安装目录外若已有实例占用同一 userData，重启可能被单实例锁转发，日志会报错。
- `%LOCALAPPDATA%\Programs\Universe Editor` 是 NSIS per-user 安装目录；脚本不修改注册表、PATH、快捷方式或 userData。
