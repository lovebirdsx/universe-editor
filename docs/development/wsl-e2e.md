# 在 WSL2/Ubuntu 下跑 e2e（避免窗口抢前台焦点）

Windows 本地跑 e2e 时，窗口会真实创建、堆叠在桌面——E2E 静默模式已默认不抢前台焦点（`ready-to-show` 走 `showInactive()`、其余 `focus()` 降级，设 `UNIVERSE_E2E_SHOW=1` 恢复有头调试），多 worker 并行冷启动仍会铺满窗口、干扰操作。在 WSL 内用 xvfb 离屏跑则完全无窗口、零打扰：Electron 窗口在虚拟 X server 内正常持有焦点，依赖 OS 焦点的用例（如 markdownPreview 的真键盘用例）不受影响。CI 本身就在 ubuntu-latest 上用 xvfb 跑全量 e2e，本地照搬即可获得与 CI 一致的环境。

tag 体系、命令、fixture 分层等通用说明见 [testing.md](testing.md) 与 [`apps/editor/e2e/CLAUDE.md`](../../apps/editor/e2e/CLAUDE.md)，本文只讲 WSL 特有的部分。

## 关键前提：仓库必须在 WSL 原生文件系统

必须在 WSL 原生文件系统（如 `~/`）下 clone，**绝不能放 `/mnt/c`、`/mnt/e` 等挂载盘**——跨文件系统 I/O 极慢，且 inotify 在 `/mnt/` 下不可靠，`@parcel/watcher` 收不到文件变更事件，依赖 fs-watch 的 spec 会超时。

想从 Windows 本机已有仓库拉代码（省流量），给 `~/` 下的 clone 加一个指向 `/mnt/` 的 remote，**仅用于 fetch**：

```bash
git clone <remote-url> ~/universe-editor
git -C ~/universe-editor remote add win /mnt/e/git_project/universe-editor   # 按你 Windows 盘符改路径
git -C ~/universe-editor fetch win   # 只 fetch 对象；工作区始终在 ~/ 原生 fs
```

## 环境搭建

WSL2 + Ubuntu 24.04。Node 22 + pnpm 11.10.0（与 CI 一致，pnpm 版本见根 `package.json` 的 `packageManager` 字段）。

```bash
# 1) 系统库 + xvfb
sudo apt update
sudo apt install -y xvfb

# 2) Node 22（nvm 或系统包均可），pnpm 用 corepack 启用（版本跟随 packageManager 字段）
corepack enable
corepack prepare pnpm@11.10.0 --activate

# 3) 依赖
pnpm install --frozen-lockfile

# 4) Playwright 系统依赖（libnss3/libgtk 等；内部走 sudo 装 apt 包，与 CI 同款）
pnpm --filter @universe-editor/editor exec playwright install-deps

# 5) tsserver vendor（peek/outline 的 coreTypescriptApp fixture 需要，与 CI 一致）
npm --prefix vendor/typescript-language-server ci
```

以上步骤已封装为幂等脚本 `scripts/wsl/bootstrap.sh`（含 WSL 环境守卫、AppArmor userns 检测、pnpm 版本动态读取），可一键执行：

```bash
bash scripts/wsl/bootstrap.sh
```

构建无需手动做：`pnpm e2e:smoke` / `pnpm e2e` 等 e2e 脚本前置了 `scripts/e2e/ensure-e2e-build.mjs`，会自动 `turbo run build --filter=@universe-editor/editor...`。首次运行会全量构建，之后命中 turbo 缓存秒过。

> **e2e 不需要 submodule 和 `pnpm agent:build`**。核心 e2e 的 ACP/agents 用例走 echo agent 源码 fixture（`apps/editor/src/test-fixtures/echoAgent.cjs`），不 spawn 真实 fork；CI 的 core e2e job 也不 checkout submodule。`vendor/claude-agent-acp` submodule + `pnpm agent:build` 只在 `pnpm --filter @universe-editor/editor test:integration acpForkContract` 和 `package:win` 打包时才需要。

## 跑测试

用 xvfb-run 包裹，参数与 CI 完全一致：

```bash
cd ~/universe-editor

# @p0 冒烟（日常交互改动首选）
xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" pnpm e2e:smoke

# 全量 core + 扩展（走 turbo，串行）
xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" pnpm e2e

# 定向 core spec
xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" pnpm e2e specs/smoke.foo.spec.ts

# 自由 grep 调试（能选中任意 tag）
xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" pnpm --filter @universe-editor/editor e2eg "<用例标题>"
```

`--auto-servernum` 自动挑空闲 DISPLAY，避免多实例冲突。

## 在 WSL 中运行 AI agent

### 动机

本仓库重度依赖 AI 编码 agent（Claude Code 等）跑 `pnpm check` / `pnpm e2e`。agent 在 Windows 仓库工作时，即便已启用 E2E 静默模式（`ready-to-show` 走 `showInactive()` 不抢焦点，`UNIVERSE_E2E_SHOW=1` 恢复有头），多 worker 并行冷启动仍会在桌面铺满窗口。让 agent 整体在 WSL 内工作——clone 在 `~/` 原生文件系统，check/e2e 全部原生执行、e2e 走 xvfb 离屏——与 Windows 前台彻底隔离：这是比「静默不抢焦点」更硬的一层边界，也符合 agent 沙箱化的通行实践。

### 目录布局

- WSL 内 `~/` 下独立 clone 一个仓库专供 agent 使用；Windows 侧继续用自己的 clone，互不干扰。
- 多 agent 并行时用 git worktree 各开一条（本仓库以 `.worktrees/<name>` 管理并行工作树，照此习惯对齐即可）。
- 与 Windows clone 互通只走 fetch-only remote，见上方「关键前提」一节，此处不重复。

### Claude Code 在 WSL 内安装与运行

- 安装走 npm 全局装即可（也可用 Anthropic 官方安装脚本）：

  ```bash
  npm i -g @anthropic-ai/claude-code
  ```

- WSL 内是**独立登录**：首次在 WSL 里单独跑 `claude` 完成 OAuth 登录，与 Windows 侧会话无关。
- 若要在 WSL 内直接 `pnpm dev` 起应用验证，注意 agent/CI 类 shell 可能注入 `ELECTRON_RUN_AS_NODE`，先 `unset ELECTRON_RUN_AS_NODE`——见下方「常见问题」。

### 一键初始化与 xvfb 包装

环境搭建（xvfb / corepack+pnpm / 依赖 / Playwright 系统库 / tsserver vendor / AppArmor 检测）已封装为幂等脚本，可反复执行：

```bash
bash scripts/wsl/bootstrap.sh
```

跑 e2e 不必每次手打 xvfb-run，用包装脚本（参数与 CI 一致，自动切到仓库根）：

```bash
scripts/wsl/e2e.sh pnpm e2e:smoke      # @p0 冒烟
scripts/wsl/e2e.sh pnpm e2e            # 全量 core + 扩展
scripts/wsl/e2e.sh pnpm --filter @universe-editor/editor e2eg "<用例标题>"   # grep 调试
```

> 用脚本而非 shell alias：agent 常跑在非交互 shell，`.bashrc` 里的 alias 默认不展开；提交进仓库的脚本可被 agent 直接调用，也便于文档/CI 引用。

### 界限：哪些仍需回 Windows / 交给 CI

WSL 无法覆盖的部分，agent 不应在此尝试：

- Windows-only 用例（`smoke.update.spec.ts`、`smoke.windowCloseFolderLock.spec.ts`）在 WSL 下 `test.skip`，涉及这两块改动仍需回 Windows 验证。
- `package:win` 打包、需要真实 Windows 桌面（Defender、安装器）的验证，回 Windows 或交给 CI 的 `package-windows` job。
- 视觉基线更新在 WSL 里天然正确（见「局限」），但需要真实 Windows 桌面的 UI 走查仍回 Windows。

## 常见问题

### Electron SUID sandbox 报错（Ubuntu 24.04 AppArmor）

Ubuntu 24.04 默认限制非特权 user namespace，Electron 的 SUID sandbox 会报 `The SUID sandbox helper binary was found, but is not configured correctly`。临时放开：

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

持久化：写 `/etc/sysctl.d/60-unprivileged-userns.conf` 一行 `kernel.apparmor_restrict_unprivileged_userns=0`，再 `sudo sysctl --system`。

### ELECTRON_RUN_AS_NODE

e2e 不受影响——`packages/e2e-harness` 的 launch 已自动 strip 该变量。但若在 WSL 里直接 `pnpm dev` 跑应用验证，agent/CI 类 shell 可能注入 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成纯 node 导致 ESM 主进程崩溃，先 `unset ELECTRON_RUN_AS_NODE`。

### Electron 下载慢

electron 42+ 的二进制改为首次 require 时懒下载，仍尊重 `@electron/get` 的镜像 env。下载慢时：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

## 局限

- 两个 Windows-only 用例在 WSL 下 `test.skip`、不执行：`smoke.update.spec.ts`（自动更新）、`smoke.windowCloseFolderLock.spec.ts`（目录删除锁）。涉及这两块改动仍需回 Windows 验证。
- 视觉基线是 Linux-only（跨平台 fonts/antialiasing 差异），在 WSL 里更新基线天然正确，流程见 [`apps/editor/e2e/baselines/README.md`](../../apps/editor/e2e/baselines/README.md)。
- 原生模块（`@parcel/watcher`、`@lydell/node-pty`、`@vscode/ripgrep`）均有 Linux prebuild；`@vscode/windows-process-tree` 是 Windows-only 但已懒加载隔离，无需处理。
