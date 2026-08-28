# 在 WSL2/Ubuntu 下跑 e2e（避免窗口抢前台焦点）

Windows 本地跑 e2e 时，窗口会真实创建、堆叠在桌面——E2E 静默模式已默认不抢前台焦点（`ready-to-show` 走 `showInactive()`、其余 `focus()` 降级，设 `UNIVERSE_E2E_SHOW=1` 恢复有头调试），多 worker 并行冷启动仍会铺满窗口、干扰操作。在 WSL 内则默认 xvfb 离屏跑、完全无窗口零打扰（即便 WSLg 提供了 `DISPLAY=:0` 也默认离屏，见下「自动预检与自动 Xvfb」）：Electron 窗口在虚拟 X server 内正常持有焦点，依赖 OS 焦点的用例（如 markdownPreview 的真键盘用例）不受影响。CI 本身就在 ubuntu-latest 上用 xvfb 跑全量 e2e，本地照搬即可获得与 CI 一致的环境。

tag 体系、命令、fixture 分层等通用说明见 [testing.md](testing.md) 与 [`apps/editor/e2e/CLAUDE.md`](../../apps/editor/e2e/CLAUDE.md)，本文只讲 WSL 特有的部分。

## 关键前提：仓库必须在 WSL 原生文件系统

必须在 WSL 原生文件系统（如 `~/`）下 clone，**绝不能放 `/mnt/c`、`/mnt/e` 等挂载盘**——跨文件系统 I/O 极慢，且 inotify 在 `/mnt/` 下不可靠，`@parcel/watcher` 收不到文件变更事件，依赖 fs-watch 的 spec 会超时。

想从 Windows 本机已有仓库拉代码（省流量），给 `~/` 下的 clone 加一个指向 `/mnt/` 的 remote，**仅用于 fetch**：

```bash
git clone <remote-url> ~/universe-editor
git -C ~/universe-editor remote add win /mnt/e/workspace/universe-editor   # 按你 Windows 盘符改路径
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
#    可选：ensure-e2e-build.mjs 检测缺失会自动装（见下文「构建无需手动做」），
#    保留此步骤可避免首次 e2e 的安装耗时。
npm --prefix vendor/typescript-language-server ci
```

以上步骤已封装为幂等脚本 `scripts/wsl/bootstrap.sh`（含 WSL 环境守卫、AppArmor userns 检测、pnpm 版本动态读取），可一键执行：

```bash
bash scripts/wsl/bootstrap.sh
```

构建无需手动做：`pnpm e2e:smoke` / `pnpm e2e` 等 e2e 脚本前置了 `scripts/e2e/ensure-e2e-build.mjs`，会自动 `turbo run build --filter=@universe-editor/editor...`。首次运行会全量构建，之后命中 turbo 缓存秒过。同一脚本也自动保障 tsserver vendor（缺失时 `npm ci`，存在即跳过），新 clone / worktree 无需手动执行上一步骤 5。

> **e2e 不需要 submodule 和 `pnpm agent:build`**。核心 e2e 的 ACP/agents 用例走 echo agent 源码 fixture（`apps/editor/src/test-fixtures/echoAgent.cjs`），不 spawn 真实 fork；CI 的 core e2e job 也不 checkout submodule。`vendor/claude-agent-acp` submodule + `pnpm agent:build` 只在 `pnpm --filter @universe-editor/editor test:integration acpForkContract` 和 `package:win` 打包时才需要。

## 自动预检与自动 Xvfb

`pnpm e2e` / `pnpm e2e:smoke` / `e2eg` 等所有入口（都经 `scripts/e2e/run-e2e.mjs` 或 `scripts/e2e/ensure-e2e-build.mjs`）在 Linux 上跑测试前会先执行一次秒级预检（`scripts/e2e/linux-preflight.mjs`）：

- 用 `ldd` 探测 Electron 缺失的系统库（如 `libnspr4.so`）。缺失时按环境判定：root / 免密 sudo / 交互 TTY 下**自动**跑 `playwright install-deps` 修复；非交互环境（agent 等）**秒级失败**并给出精确修复命令（`bash scripts/wsl/bootstrap.sh` 或 install-deps 单行）——而不是让 harness 对每个用例做 5/10/20s 退避重试、报错完全不指向根因。
- 检查 electron 二进制存在；无 `DISPLAY` 时检查 Xvfb 可用性；WSL 下仓库位于 `/mnt` 挂载盘时打警告（只 warn 不失败）。
- 开关与去重：`UNIVERSE_E2E_SKIP_PREFLIGHT=1` 跳过；turbo 任务内（`TURBO_HASH` 已设）与已预检的子进程（`UNIVERSE_E2E_PREFLIGHT_DONE=1` 继承）自动去重，避免链路上重复预检。

无 `DISPLAY` 时，e2e-harness 的 Playwright globalSetup 会自动启动一个 Xvfb（自动挑选空闲 display 编号，屏幕参数与 CI 的 `xvfb-run` 完全一致：`-screen 0 1280x1024x24`；WSLg 下 `/tmp/.X11-unix` 只读、无法创建 socket 文件也没关系，X server 会经 Linux 抽象 socket 服务），运行结束自动回收。**WSL 下即便有 WSLg 的 `DISPLAY=:0` 也默认离屏**——除非显式要求有头，否则照常启动 Xvfb 覆盖 DISPLAY；若未装 xvfb（启动失败 / 编号耗尽 / 超时），不会让整趟失败，而是回退到 WSLg/现有 DISPLAY 的真实窗口并打一行警告提示。设 `UNIVERSE_E2E_SHOW=1`（或 `e2e:headed` / `e2e:ui`）恢复真实窗口。所以 headless Linux / WSL 上裸跑 `pnpm e2e` 即可，无需手动 `xvfb-run` 包裹。

最后还有一层 harness 兜底：`launch.ts` 把「error while loading shared libraries / Unable to open X display」这类环境错误从瞬态重试中排除，立即失败并附修复指引——覆盖不经预检脚本的入口（如 `test:visual` 直跑 playwright）。

> **bootstrap.sh 仍是首次一键初始化的推荐方式**：`sudo` 类系统安装（xvfb、Playwright 系统库、AppArmor 检测等）仍需它来做。预检的定位是「忘了初始化」时不再以重试风暴收场、并给出精确修复指令，而不是替代 bootstrap.sh。

## 跑测试

headless Linux（无 `DISPLAY`，如未启用 WSLg 的 WSL2、远程服务器/容器）已无需手动 `xvfb-run` 包裹——e2e-harness 的 globalSetup 会自动启动 Xvfb 离屏运行（见上「自动预检与自动 Xvfb」）。直接裸跑：

```bash
cd ~/universe-editor

# @p0 冒烟（日常交互改动首选）
pnpm e2e:smoke

# 全量 core + 扩展（走 turbo，串行）
pnpm e2e

# 定向 core spec
pnpm e2e specs/smoke.foo.spec.ts

# 自由 grep 调试（能选中任意 tag）
pnpm --filter @universe-editor/editor e2eg "<用例标题>"
```

`xvfb-run` 包裹仍是可选项（参数与 CI 完全一致，`--auto-servernum` 自动挑空闲 DISPLAY、避免多实例冲突），用于想与 CI 完全对齐或有特殊显示需求时：

```bash
xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" pnpm e2e:smoke
```

**WSLg（已有 `DISPLAY=:0`）下零窗口离屏跑**：现在裸跑默认就是零窗口——globalSetup 检测到 WSL 后，即便有 `DISPLAY` 也会自动启动 Xvfb 离屏（见上「自动预检与自动 Xvfb」），无需再手动包裹。`DISPLAY= pnpm e2e:smoke` 前缀与 `scripts/wsl/e2e.sh` 仍有效但已非必要（`e2e.sh` 保留价值 = 与 CI 完全同参数）。想看真实窗口调试，用 `UNIVERSE_E2E_SHOW=1 pnpm e2e ...` 或 `e2e:headed` / `e2e:ui`。

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

agent 在非交互 shell 里跑 e2e 时，预检不会动系统（无 TTY、非 root、无免密 sudo 时不会自动 install-deps），缺库 / 缺 Xvfb 会秒级失败并打印精确修复指令——照 `bash scripts/wsl/bootstrap.sh` 跑一遍再重试即可。

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
- 原生模块（`@parcel/watcher`、`@lydell/node-pty`、`@vscode/ripgrep`）均有 Linux prebuild；`@vscode/windows-process-tree` 无 Linux prebuild 且 install 脚本是 node-gyp rebuild，安装期由根 `.pnpmfile.cjs` 的 updateConfig 钩子在非 win32 平台把该包从构建放行改为跳过构建（因此无需 build-essential），运行时由懒加载 + `process.platform === 'win32'` 守卫隔离。
