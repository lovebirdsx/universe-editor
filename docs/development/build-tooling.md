# 构建与工具链

改构建脚本（`scripts/**`、各包 `esbuild.config.mjs` / `build`）、打包配置（`electron-builder.yml`）、依赖安装（`.pnpmfile.cjs` / lockfile）或 tsgo 类型检查前读本文。日常命令与依赖分层见根 [`CLAUDE.md`](../../CLAUDE.md)；跑测试见 [testing.md](testing.md)，WSL 环境搭建见 [wsl-e2e.md](wsl-e2e.md)。

## 1. turbo 依赖图：跨包引源码 / dist 必须声明 workspace 依赖

turbo 的 `^build` **只认 package.json 声明的直接 workspace 依赖**（devDependencies 也进依赖图），裸 `../other-pkg/src` 路径引用对它完全隐形。任何构建脚本（esbuild / vite / tsc）跨包引用其他 workspace 包的 src 或 dist 产物时，必须在 package.json 声明 `workspace:*`——声明同时修两件事：`^build` 的调度顺序，以及「上游改动 → 下游缓存失效」的 hash 感知。

缺边的后果是**时序敏感的 CI-only 竞态**：上游 miss（真实编译需 1-2s）时下游并发启动、读到半成品 `dist`；上游命中 turbo 缓存（replay 恢复 dist 早于下游启动）时不暴露——所以本地几乎必赢，只在「改了上游包且 restore 到旧 turbo 缓存」时 CI 偶发。实测案例：`remote-server` 的 esbuild 打 `../extension-host/src/bootstrap.ts`（它引 extension-api 的 dist 产物）却没声明这条边 → CI Build 报 `Could not resolve "@universe-editor/extension-api"`；日志特征是下游 esbuild 任务先于上游 tsgo 启动、被 turbo 取消的 tsgo 报 `[ELIFECYCLE] Command failed.`（signal）或静默 0 退出。修法即补声明——`packages/remote-server/package.json` 的 devDependencies 现有 extension-host / extension-api / extension-packaging 三条，`packages/remote-server/esbuild.config.mjs` 仍打 extension-host 源码。

验证：`turbo run build --filter=<包> --dry` 看依赖边（输出里该包的上游应出现在依赖列表中）。

## 2. 子进程 spawn 的三个坑

### 2.1 交互型 CLI 的 stdin 挂起

spawn 交互型 CLI（p4 / git / npm…）若不显式处理 stdin，命令在**需要输入**时永久挂起——没有输入途径就卡死；就算传空 stdin（`{ input: '' }`）兜底，也只是把挂起变成快速失败（`EOF reading terminal`），想要的东西仍拿不到。**正解是换一个纯只读命令**，而不是给交互命令补 stdin —— 尤其别用名字带 login 的命令去「读」：`p4 login -p` 不是「读现有 ticket」而是**重新认证**（安全服务器会要密码），`p4 login -s` 只报会话状态，`p4 tickets` 才只读 P4TICKETS 文件里已有的 ticket。

案例与锚：`extensions/perforce/src/swarm/swarmAuth.ts` 头注释逐字写明了这三个命令的语义差异；凭据探针的 15s 紧超时见 `extensions/perforce/docs/pitfalls.md`。

### 2.2 win32 经 cmd 中转的参数转义

win32 上要经 cmd 执行 `.cmd` shim（spawn `.cmd` 直连被 CVE-2024-27980 防护拒 `EINVAL`），而 `spawnSync(cmd, args, { shell: true })` 在 Node 22.6+ 触发 DEP0190，且 node 只拼接、不转义——参数会再经一层 cmd 解析。两条实测结论：

1. **裸 `^` 等元字符被 cmd 静默吞掉**：turbo filter `pkg^...` 变 `pkg...`，把要跳过的上游重 build 又拉回来（实例见 `scripts/test-changed.mjs` 的 buildFilters）。
2. **给中间参数包双引号也不可靠**：`cmd /d /s /c` 与无 `/s` 都只在命令串**首字符是引号**时才剥首尾引号；中间参数的 `"` 会**字面进入子进程 argv**（探针实测 `node probe "--filter=x^..."` 的 argv 含引号，turbo 把它当 task 名报 `Could not find task`）。旧教训「包双引号」依赖 pnpm 内部剥引号的巧合，不可复现到所有中转。

做法：显式 `spawnSync(cmd.exe, ['/d', '/s', '/c', cmdString])`（无 `shell` 选项 → 无 DEP0190；cmd.exe 走 `process.env.ComSpec` 兜底），参数做 **caret 转义**：`[&|<>^]` 前加 `^`（`^` 自身写 `^^`），不用引号；**空格无法 caret 转义**（cmd 不为它分组），受控 args 含空格 / 引号时**显式报错**而非静默错传。实现见 `scripts/test-changed.mjs` 的 `spawnPnpm` / `escapeCmdArg`。

### 2.3 这类转义单测测不到

单测断言的是 JS 数组，而转义发生在**拼接命令行**那一刻——单测全绿也证明不了链路正确。验证必须走真实链路（改叶子包源码跑 `test-changed --check`，看 turbo 任务分发是否符合预期）+ 探针脚本打印子进程实际 argv。

## 3. tsgo 类型检查

工具链 pin：`@typescript/native-preview 7.0.0-dev.20260707.2`（`pnpm-workspace.yaml` 的 catalog），`tsgo` 经 `pnpm exec tsgo` 调用。

### 3.1 WSL 时钟漂移 → 幽灵 typecheck

**现象**：`pnpm check` / `pnpm typecheck` 报出与本次改动完全无关的 TS2339 / TS2305（如 `ManagedChildProcess` 缺成员、`e2e-contract` 缺导出），但对应上游包源码与 `dist/*.d.ts` 明明都对；`pnpm build` 全绿也修不好。也可能反向表现为假绿（漏报新错）。**仅 WSL 复现，Windows 正常。**

**机制**：WSL2 的 RTC 可能大幅偏移（该机实测快约 24 小时，`timedatectl` 可见）——内核先用 RTC 初始化系统时间，NTP 稍后才校正；窗口内写出的 `*.tsbuildinfo` / dist 产物 mtime 落在「未来」。校正后长达一天内，`tsgo --build` 的 mtime 顺序比较全部失真：输入比「未来」的 buildinfo 旧 → 项目误判 up-to-date → 跳过重查 → 按旧声明报幽灵错或漏报。turbo、eslint（`--cache-strategy content`）、vitest 都按内容 hash 判定、免疫；**唯一受害者是 tsgo**。tsgo 当时已是 npm 最新 dev 版，升级无解。

**判别**：报错文件本次未改动 + HEAD 干净态同样报错（`git stash` 验证），然后再怀疑缓存；跑 `node scripts/dev/ensure-fresh-mtimes.mjs` 看是否命中未来 mtime。

**机器层缓解**（守卫频繁命中时）：确认 Windows 宿主时间正确后 `wsl --shutdown` 重启；WSL 内 `sudo hwclock --systohc` 把校正后的系统时间写回 RTC。RTC 可能再漂移，长期保障靠仓库守卫。

### 3.2 仓库侧根治（已落地，别退回手工流程）

- **`scripts/dev/ensure-fresh-mtimes.mjs` 入口守卫**（仅 WSL 生效——检测 `WSL_DISTRO_NAME` / `/proc/version`，其它环境静默跳过、零开销）：扫描 apps / packages / extensions / extensions-external，未来 mtime 的 `*tsbuildinfo*` **删除**（touch 到 now 反而让它比真实输入更新、误判依旧），其它未来文件 touch 归一（方向安全：只会多查不会漏查）。已接在 `build` / `typecheck` / `check` / `check:full` 四个入口之前；健康仓库静默，全量扫描约 70ms。
- **`apps/editor/scripts/typecheck.mjs` 失败自愈重试**：typecheck 失败自动删三个 buildinfo（`dist/.tsbuildinfo-node`、`dist/.tsbuildinfo-web`、`integration/tsconfig.tsbuildinfo`）重跑一次；**重试仍败才是真类型错误**。

### 3.3 tsgo / tsc 跨平台分歧：「CI typecheck 挂、本地绿」的复现法

tsgo 与官方 tsc 存在跨平台 / 实现分歧：同一条件类型场景 Windows tsgo 漏报、Linux（CI）的 tsgo 与官方 tsc 一致报错。遇到「CI typecheck 挂、本地 tsgo 绿」**别怀疑缓存**，直接用 tsc 复现：

```bash
pnpm exec tsc -p tsconfig.web.json --noEmit --tsBuildInfoFile $TEMP/x.tsbuildinfo
```

tsc 报错即真错。噪音识别：tsc 与 tsgo 的 DOM lib 有已知差异（如 `PerformanceEventTiming.interactionId` tsc 5.x 不认识），tsc 复现时忽略这类 lib 差异噪音。

## 4. electron-builder 打包

### 4.1 workspace 包必须放 devDependencies

被 electron-vite bundle 进 `out/` 的纯逻辑 workspace 包（platform / workbench-ui 等）**必须放 `apps/editor` 的 devDependencies**（`externalizeDeps.exclude` 已把它们打进 bundle，运行时不需要其 node_modules 副本）。放 dependencies 会在开启 `asarUnpack` 后打包崩：electron-builder 对每个被收集文件按 **realpath** 判定归属，workspace 包的 symlink realpath 是 `packages/platform/...` 这类**不含** `/node_modules/` 的路径 → 直接抛 `<file> must be under <appDir>` 中止。归位纪律与特例见 `apps/editor/src/main/services/extensionManagement/CLAUDE.md`。

### 4.2 新增原生 npm 依赖

在 `electron-builder.yml` 的 `asarUnpack` 加 `**/node_modules/<pkg>/**`（带子包的原生模块连 `**/node_modules/<pkg>-*/**` 一起加，现有条目可照抄：`@parcel/watcher`、`@vscode/ripgrep`、`@lydell/node-pty`、`@vscode/windows-process-tree`），并保持 `npmRebuild: false`——这些都是 prebuilt N-API，无需重编。

### 4.3 本机验证

```bash
pnpm --filter @universe-editor/editor package:win:dir
```

**必须走这个脚本**：`electron-builder.yml` 的 `publish.url` 是 `${env.UE_UPDATE_FEED_URL}`，脚本入口（`scripts/release/package-editor.mjs`）会先 `loadEnv()` 注入；裸 `pnpm exec electron-builder` 会因变量未定义而中止。产物检查：`release/win-unpacked/resources/app.asar.unpacked/**/*.node` 存在。

## 5. pnpm 依赖安装

### 5.1 平台条件构建（`.pnpmfile.cjs`）

`@vscode/windows-process-tree` 是 Windows-only 原生模块，tarball 自带 `binding.gyp`——非 win32 平台由根 `.pnpmfile.cjs` 的 `updateConfig` 钩子在 `allowBuilds` 里把该包显式置 `false` 跳过构建（显式 false = 禁止构建且不报 `ERR_PNPM_IGNORED_BUILDS`）。`readPackage` 删 install / gypfile **无效**（pnpm 11 对含 `binding.gyp` 的 tarball 恒判 requiresBuild 并重注入 `scripts.install`）。根因、运行时守卫与「无需 build-essential」见 [wsl-e2e.md](wsl-e2e.md) 的「局限」节；钩子实现与其头注释在 `.pnpmfile.cjs`，此处不重复。

### 5.2 pnpmfileChecksum 与 --frozen-lockfile

根 `.pnpmfile.cjs` 的存在会让 lockfile 多出 `pnpmfileChecksum` 字段（`pnpm-lock.yaml` 现有 1 处）。**pnpmfile 内容变更会导致 `--frozen-lockfile` 校验不匹配**——改它要预期 lockfile 同步更新。

## 6. pnpm check 的组成与边界

`pnpm check`（根 `package.json`）= 护栏族 `docs:check` / `sensitive:check` / `skills:check` / `knowledge:check` / `claude-md:check` / `builtin-engines:check` / `temp-root:check` / `primitives-deps:check` + `test:scripts` + `test-changed --check`（按变更在 targeted / related / 退 turbo 全量三档里选）。

`pnpm check:full` = `docs:check` / `sensitive:check` / `skills:check` / `primitives-deps:check` + `test:scripts` + `turbo run lint typecheck test…build`。

**`check:full` 不是 `check` 的超集**：它不含 `knowledge:check`、`claude-md:check`、`builtin-engines:check`、`temp-root:check`。根 CLAUDE.md 的「需要全量语义用 `pnpm check:full`」只在 lint / typecheck / test / build 维度成立——按它替代 `check` 会**丢掉 CLAUDE.md 体积（及 knowledge / temp-root / engines）护栏**，而 CLAUDE.md 恰恰是常年贴顶、最容易撑破预算的一类文件。两者维度不同、互补：日常收尾用 `check`（护栏 + 选择性测试），大改动 / 发版前跑 `check:full`（全量 lint / typecheck / test / build）并用 `pnpm claude-md:check` 手动补上体积护栏。

**CI 只跑得动其中一部分**：`.github/workflows/ci.yml` 不调 `pnpm check`，而是把各步逐条拆开（为并行与独立失败归因），所以**新增护栏不会自动进 CI**——目前实际执行的是 `docs:check` / `sensitive:check` / `knowledge:check` / `claude-md:check`，加上经 `pnpm test:release` 带出的 `test:scripts`；`skills:check` / `builtin-engines:check` / `temp-root:check` / `primitives-deps:check` 仍未进 CI，只在本地 `check` 里生效。
