# 在 WSL2/Ubuntu 下跑 e2e（避免窗口抢前台焦点）

Windows 本地跑 e2e 时，`windowMainService` 在 `ready-to-show` 无条件 `win.show()`（`apps/editor/src/main/services/window/windowMainService.ts`），多 worker 并行冷启动会反复把测试窗口顶到前台抢焦点，干扰日常操作。在 WSL 内用 xvfb 离屏跑则完全无窗口、零打扰：Electron 窗口在虚拟 X server 内正常持有焦点，依赖 OS 焦点的用例（如 markdownPreview 的真键盘用例）不受影响。CI 本身就在 ubuntu-latest 上用 xvfb 跑全量 e2e，本地照搬即可获得与 CI 一致的环境。

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
