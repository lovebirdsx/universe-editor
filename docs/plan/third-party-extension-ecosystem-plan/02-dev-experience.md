# 02 — 扩展开发模式：开发宿主、断点调试与快速重载

> Phase B。目标：对标 VSCode Extension Development Host——从开发目录直接加载未打包扩展、host 进程可断点、改代码后一条命令重载。这是外部开发者留存的关键（现状"改一行 = 重新 pack .vsix + 安装 + 重启"的迭代速度足以劝退任何人）。
> 对标：VSCode `--extensionDevelopmentPath` / `--inspect-extensions` / `workbench.action.restartExtensionHost`。

## 1. 语义定义（先定死，再谈实现）

| 语义点 | 定义 | 理由 |
|---|---|---|
| `--extension-development-path=<dir>` | `<dir>` 是**单个扩展的根**（含 `package.json`），非扩展集目录；可重复传参加载多个 | 对齐 VSCode；作者的工程目录就是扩展根 |
| 扫描合并 | dev 扩展**附加**进扫描集；id 冲突时优先级 **dev > builtin > user** | dev 必须压过一切——开发中的下一版要能覆盖已装/内置的同 id 扩展（如迭代内置 typescript 插件） |
| 与 e2e 通道的关系 | `UNIVERSE_USER_EXTENSIONS_DIR`（整体**替换**用户目录）原样保留，仅供 e2e；两通道并存**不合并** | 合并会破坏 `extensions-external/*` 三个 e2e fixture 的替换语义 |
| dev 扩展的信任 | 豁免 Workspace Trust 激活门控（同 builtin 待遇） | 开发者显然信任自己的代码；且调试用 workspace 常是临时 fixture 目录，天然未受信，不豁免则首次体验就是"扩展没激活" |
| dev 模式实例 | 跳过单实例锁，独立进程；userData 默认隔离 | 见 §3 |
| 未打包形态 | 加载 `<dir>/package.json` + 其 `main` 指向的产物（通常 `dist/index.js`），**不要求 vsix、不要求 install** | scanner 已支持从任意目录读 manifest（e2e 通道验证过，含 symlink/junction） |

## 2. 参数与传递链

复用三段式配置注入（cli > env > file）与既有 host 启动链，全程无新机制：

```
① 声明   main/environment/configItems.ts
           EXTENSION_DEV_PATHS   --extension-development-path（可重复）/ UNIVERSE_EXTENSION_DEV_PATH
           INSPECT_EXTENSIONS    --inspect-extensions=<port>           / UNIVERSE_INSPECT_EXTENSIONS
           （补 description → 自动进 --help）
② 读取   EnvironmentMainService 加 getter：extensionDevPaths: string[] / inspectExtensionsPort?: number
③ 传递   shared/ipc/extensionHostService.ts 的 ExtHostStartSpec 加 devExtensionPaths?: string[]
           renderer ExtensionHostClientService.start() 组 spec 时带上（从 main 侧 env 服务查询，
           或 main 在 start() 里自行合入——取后者，renderer 无需感知，改动更小）
④ 注入   extensionHostMainService.start()：
           env UNIVERSE_DEV_EXTENSIONS = devPaths.join(path.delimiter)   // Windows 路径含冒号，
                                                                          // 分隔符必须用 path.delimiter
           inspect 端口存在时 spawn argv 变为 [`--inspect=127.0.0.1:${port}`, entry]
                                                                          // ELECTRON_RUN_AS_NODE 下
                                                                          // node CLI flag 原生支持
⑤ 消费   packages/extension-host/src/bootstrap.ts：
           扫描 = scanExtensions(builtinDir) ∪ scanExtensions(userDir) ∪ devPaths.map(scanOneExtension)
           按 §1 优先级去重；dev 条目打 isUnderDevelopment: true
```

新文件仅一个：`main/services/extensionHost/devExtensionsDir.ts`（解析/规范化 dev 路径，对齐 `builtinExtensionsDir.ts`/`userExtensionsDir.ts` 的"单一真相"模式）。

**scanner 侧**：现有 `scanExtensions(dir)` 是"目录下每子目录一个扩展"；dev path 需要 `scanOneExtension(dir)`（目录本身即扩展）。从现有实现里抽出单扩展读取函数即可（读 manifest + zod 校验 + NLS 的逻辑全复用），顺带给返回条目加 `isUnderDevelopment` 标志（与现有 `builtin` 标志同级）。

## 3. 开发宿主实例（单实例锁、userData、标识）

- **单实例锁**：`main/index.ts` 现为 `hasSingleInstanceLock = e2eEnabled || app.requestSingleInstanceLock()`。dev path 存在时同 e2e 待遇——不参与单实例协商，独立起进程。否则 `uex dev` 拉起时只会 focus 已开的主实例，dev 参数被丢进 `second-instance` 事件里没人消费。
- **userData 默认隔离**（README 决策 7）：`productPaths.ts` 的 `applyProductIdentity()` 在 dev path 存在时切到 `<产品名> - ExtDev` 目录 + 独立 AppUserModelId（模式表加一行，紧挨现有 dev/E2E 两行）。理由：我们的 storage 是 JSON 文件读写，主实例与开发宿主并发写 settings/storage 会互相覆盖——VSCode 敢共享 userData 是因为它的 storage 层做了多实例仲裁，我们没有。`--user-data-dir` 显式覆盖依旧最高优先。**代价要写进文档**：开发宿主里看不到主实例的主题/设置（Phase E 文档如实说明 + 给"想共享就传 --user-data-dir"的口子，风险自担）。
- **窗口标识**：窗口标题追加 `[扩展开发宿主]`（localize；对照 VSCode `[Extension Development Host]`）。renderer 侧再加一个状态栏条目展示 dev 扩展数量与路径 tooltip（套路 E，低成本高辨识度）。判定依据经 env/IPC 暴露一个 `isExtensionDevelopment` 标志给 renderer。

## 4. Workspace Trust 豁免

`packages/extension-host/src/activationService.ts` 的 `_isActivatable`：现有豁免条件 `builtin` 旁并列 `isUnderDevelopment`。**不复用 builtin 标志**（别偷懒把 dev 扩展标成 builtin）：两个标志语义不同——builtin 还参与"不可卸载"、"id 碰撞胜出"等分发侧判断，混用会让 dev 扩展在管理 UI 里显示成"内置"。管理 UI（`ExtensionsWorkbenchService`）给 dev 扩展一个独立徽标"开发中"，且屏蔽卸载/禁用操作（它不在 `extensions.json` 里，这些操作本就无意义，与其各处兜底不如 UI 直接不给入口）。

## 5. 断点调试

- **`--inspect-extensions=<port>`**：显式给端口（对齐 VSCode，不设默认值——默认端口会在多实例场景撞车）。§2 ④ 注入 `--inspect=127.0.0.1:<port>`——**显式 bind loopback**，绝不 `0.0.0.0`（inspector 协议等于远程代码执行，这是安全红线）。
- **`--inspect-brk-extensions`**（激活前断点，调 activate 本身必需）：机制同上仅 flag 不同（`--inspect-brk`），顺手一起做；host 会停在首行等 debugger，注意 renderer 侧 `_whenReady` 的启动超时/崩溃判定别把"等 attach"误判为启动失败（实施时检查 `_handleCrash` 的窗口期逻辑，必要时 inspect-brk 模式下放宽）。
- **sourcemap 约定**：host 加载的是 `dist/index.js`，断点要回到 `src/*.ts` 全靠 sourcemap。约定写进模板与文档：esbuild `sourcemap: true`（外置 .map）+ `sourcesContent: true`（调试器无需再解析源路径）。这属于模板职责（03 章），本章只定约定。
- **launch.json 形态**（脚手架内置，03 章交付）：`attach` 到 `127.0.0.1:<port>` + `outFiles: ["${workspaceFolder}/dist/**/*.js"]`；配合 `uex dev --inspect=9229` 一次拉起。F5 复合配置（launch 编辑器 + attach）作为模板增强，MVP 是"两步：uex dev 起宿主，F5 attach"。
- **host 崩溃重启会掉 debugger**：`_handleCrash` 指数退避重启后是新进程，inspect 端口重新监听但 attach 断开。文档如实写"host 重启后需重新 F5 attach"，不做自动 re-attach（VSCode 也不做）。

## 6. 重启命令与自动重载

- **命令 `workbench.action.restartExtensionHost`**（id 对齐 VSCode，仓库红线）：Action2（套路 A，`extensionsActions.ts`，f1: true，title "重启扩展宿主"/localize）→ `ExtensionHostClientService` 暴露公有 `restartHost()` 包装现有私有 `_restart('manual')`。重启机制（stop → start → 重 translate → replay 激活）是现成的、被崩溃/信任撤销/enablement 三条链路验证过的——本命令只是给它第四个入口。**顺手收益**：这个命令对所有用户有价值（扩展卡死自救），不只 dev。
- **自动重载（已落地，2026-08）**：watch dev 扩展 manifest `main` 入口产物变更 → debounce → `restartHost()`。最终选型：只 watch **入口文件所在目录**（非递归），复用 `watchOutOfWorkspace` 的 node:fs 目录 watch 通道——刻意不走 parcel 递归 watcher（win32 崩溃重灾区的案底依然有效）；debounce 500ms + in-flight 串行（重启中再变更则尾随补一次）+ armTime stat 确认（`mtime > armTime` 才算真变更，防 esbuild watch 首写产物时的误触发）。开关为 setting `extensions.autoRestartOnChange`（boolean，默认 `true`，仅在扩展开发窗口生效）；首次自动重启弹一次性通知说明它会断开已 attach 的调试器。手动命令保留作兜底（产物分散多目录等监听覆盖不到的形态）。
- **`--disable-extensions`（可选增强）**：隔离调试用（只跑 dev 扩展）。机制现成——把全部已装+内置 id 灌进 `ExtHostStartSpec.disabledIds` 即可，dev 扩展不在其列天然存活。VSCode 同名 flag。

## 7. E2E 与验证

- **e2e 新增** `smoke.extensionDev.spec.ts`：fixture 扩展目录（可复用 e2e 现有的最小扩展 fixture）→ 以 `--extension-development-path` 启动 → `hasCommand(fixture 命令)` 出现 → `restartExtensionHost` 命令后命令仍在（重启链路完整）。注意 e2e fixture 启动参数经 `packages/e2e-harness` 的 launch 选项传入。
- **手动验证清单**（Phase B 完成标准）：
  1. 手工目录（package.json + dist/index.js）→ `--extension-development-path` 启动 → 窗口标题带标识、命令面板出现其命令、未信任 workspace 下仍激活；
  2. 主实例开着的同时能起开发宿主，两者 settings 互不污染；
  3. `--inspect-extensions=9229` → VSCode attach → 断点命中 `src/extension.ts`（经 sourcemap）；`--inspect-brk-extensions` 能停在 activate 前；
  4. 改代码重编 → 命令面板"重启扩展宿主" → 新行为生效，全程不重启编辑器；
  5. 同 id 覆盖：dev 目录用一个内置扩展的 id → dev 版本胜出。

## 8. 坑与注意

- **`path.delimiter` 不是 `:`**：Windows 路径 `D:\...` 含冒号，env 里多路径分隔必须 `;`（win）——用 `path.delimiter` 而非硬编码，bootstrap 侧同样。
- **dev 扩展不进 enablement/管理链路**：`getEffectiveDisabledIds` 交集计算基于"已装∪内置"，dev 扩展天然不在其中不会被误过滤——但要加测试钉死这个行为，防未来重构把 dev 扩展卷进禁用集。
- **workspace 切换重启后 dev 扩展要还在**：`_restart` 重组 spec 的路径必须重新带上 devExtensionPaths（若采用"main 在 start() 合入"方案则天然满足——再一个选它的理由）。
- **spawn argv 顺序**：`--inspect` 必须在 entry 之前（node flag vs script arg）；`ELECTRON_RUN_AS_NODE` 下 Electron 二进制吃 node flags 的行为在 win/darwin/linux 一致，但 e2e 只覆盖 win+linux，darwin 留手动验证项。
- **treeKill/优雅停链路别被 inspect 破坏**：inspect 模式下 host 停止仍走 stdin EOF 优雅停；debugger attach 挂起的进程可能不响应，stop 超时后 treeKill backstop 已有——确认超时参数在"断点停住"场景下的表现（停在断点的 host 收不到 stdin 循环，会走 backstop 硬杀，可接受，文档写明）。
