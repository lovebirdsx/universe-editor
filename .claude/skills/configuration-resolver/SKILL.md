---
name: configuration-resolver
description: 处理「设置值 / 路径里的 ${...} 变量替换」相关功能时召回——本仓库对齐 VSCode 的 IConfigurationResolverService，把 `${workspaceFolder}`/`${env:NAME}`/`${userHome}`/`${file...}`/`${config:...}`/`${pathSeparator}` 等变量在真正使用时展开成当前上下文的实际值，以及终端 cwd 的「相对拼根 + 无效目录安全回退」。当任务涉及：给某个设置项加变量支持、扩/改变量语法（VariableKind / ${name:arg} 解析 / 平台键 windows·osx·linux）、新增变量的数据源（活动编辑器/工作区/配置/env 快照/扩展）、终端/任务/调试的 cwd 解析与回退、renderer 拿不到的 env·userHome·cwd 怎么经 EnvironmentSnapshot 一次性快照过来、或要理解「一个 ${...} 从字符串走到被替换掉的全过程」时使用。给出三层架构（platform 语法内核 / main env 快照 / renderer 数据源门面）文件地图、变量清单、cwd 回退两段式规则、path.ts 纯函数、IPC 接线七处，以及关键坑（await 后 accessor 失效、win32 env 大小写、cwd 校验在 main）。
disable-model-invocation: true
---

# 配置变量替换：IConfigurationResolverService（${...} 展开）+ 终端 cwd 回退

对齐 VSCode 的「设置值里写 `${workspaceFolder}/scripts`，用的时候才替换成真实路径」。核心思路：**语法内核在 platform（纯函数，不认识任何数据源），数据源在 renderer（活动编辑器 / 工作区 / 配置 / env 快照），main 只负责把浏览器上下文读不到的 env·userHome·cwd 一次性快照过来**。

> ⚠️ 第一原则：先认领改动落在**哪一层**——① **platform 语法内核**（`${name:arg}` 怎么解析、每个变量怎么求值、平台键怎么套用，**不碰任何具体数据**）、② **main env 快照**（把 `process.env`/`homedir()`/`cwd()` 经 IPC 暴露给 renderer）、③ **renderer 数据源门面**（`IVariableResolveContext` 把变量接到活动编辑器/工作区/配置上，注册成单例）。三层几乎不相交，改错层白改。
>
> ⚠️ 第二原则：**解析变量 ≠ 用变量**。`${...}` 展开只产出一个字符串；「展开后这个 cwd 有没有用、无效了怎么办」是**消费方**（终端 `TerminalManagerService` + main `TerminalMainService`）的回退逻辑，不在 resolver 里。两端别混。

## 架构总览（三层 + path 工具）

```
① platform 语法内核   packages/platform/src/configurationResolver/
                        configurationResolver.ts            契约 IConfigurationResolverService + VariableKind 枚举 + VariableError
                        configurationResolverExpression.ts  ${name:arg} 解析（花括号计数）+ 定位追踪 + 回填（含 key 替换）
                        variableResolver.ts                 AbstractVariableResolverService：单变量求值 + 路径运算
                        index.ts  （必须 barrel，再在 src/index.ts re-export）
   platform 路径纯函数  packages/platform/src/base/path.ts
                        pathSeparator / normalizeDriveLetter / isAbsolutePath / joinPath
                        basename / dirname / extname / relativePath  （变量求值 + cwd 拼接用；均输出正斜杠）

② main env 快照       apps/editor/src/shared/ipc/environmentSnapshotService.ts        契约 IEnvironmentSnapshot{userHome,cwd,env}
                        apps/editor/src/main/services/environmentSnapshot/environmentSnapshotMainService.ts   读 process/os 一次

③ renderer 门面       apps/editor/src/renderer/services/configurationResolver/ConfigurationResolverService.ts
                        RendererVariableResolveContext（接 workspace/editor/config）+ 单例注册

   消费方（cwd 回退）  apps/editor/src/renderer/services/terminal/TerminalManagerService.ts   _resolveCwd + computeTerminalCwd(export)
                        apps/editor/src/main/services/terminal/terminalMainService.ts        _resolveCwd + sanitizeCwd + statSync 校验
```

## ① platform 语法内核

三个文件对应 VSCode 三个类，逐一照抄、按本仓库约定微调（见各文件头注释）：

- **`configurationResolverExpression.ts`** = VSCode `ConfigurationResolverExpression`：把字符串或任意对象树里的 `${name}` / `${name:arg}` 解析出来。
  - **花括号计数**（不是正则）：所以 `arg` 里含空格、嵌套 `${}` 都能正确断句。
  - **平台键套用**：解析时把对象里的 `windows`/`osx`/`linux` 子键按当前平台提升到顶层再删除（`applyPlatformSpecificKeys`）。
  - **定位追踪 + 回填**：记录每个替换出现的所有位置（含**对象 key** 本身，`replaceKeyName`），`resolve()` 时全部替换；替换出的新文本会**再解析一遍**（`${env:A}` 展开成 `${env:B}` 也会被接着解），并用 `path` 防自引用死循环。
  - 字符串输入会被 box 成 `{value}`，`toObject()` 再 unbox；未解析的替换**原样保留**。
- **`variableResolver.ts`** = VSCode `AbstractVariableResolverService`：单个 `${name:arg}` 怎么求值。**这是抽象类**，不认识任何数据源——所有数据经构造参数 `IVariableResolveContext` + `userHomePromise` + `envVariablesPromise` 注入。
  - 入口 `resolveAsync(folder, config)` / `resolveWithEnvironment(env, folder, value)`：都是 parse → 遍历 `unresolved()` → `evaluateSingleVariable` → `expr.resolve`。
  - 路径运算全走 platform 的 string-only helper（`basename`/`dirname`/`relativePath`…），`platform` **显式注入**（不依赖全局 `isWindows`）；`fsPath` 直接取 `uri.fsPath`（本仓库 URI.fsPath 已是正斜杠）。
  - **win32 env 大小写不敏感**：`prepareEnv` 把 env 的 key 全 `toLowerCase`，查 `${env:PATH}` 时也 lower（见坑 2）。
  - 需要活动编辑器的变量（`${file...}`/`${selectedText}`/`${lineNumber}`…）取不到时**抛 `VariableError`**（不是静默空），消费方负责 catch 回退（见坑 4）。
- **`configurationResolver.ts`** = 契约 + `VariableKind` 全量枚举 + `VariableError`。交互式 `resolveWithInteraction*`（UI 驱动的 input/command 变量）**故意未实现**——暂无消费方，接口保留、抽象基类不提供。

**支持的变量**（`VariableKind`，均已在 `variableResolver` 求值）：
`env:NAME` · `config:section` · `workspaceFolder[:名]` · `workspaceFolderBasename` · `cwd` · `userHome` · `file` · `fileWorkspaceFolder[Basename]` · `relativeFile[Dirname]` · `fileDirname[Basename]` · `fileExtname` · `fileBasename[NoExtension]` · `lineNumber` · `columnNumber` · `selectedText` · `execPath` · `extensionInstallFolder:id` · `pathSeparator`（别名 `/`） · `command:`/`input:`（走 map，交互式未接）。

> **必须**在 `configurationResolver/index.ts` 加 barrel，再在 `packages/platform/src/index.ts` re-export（`export * from './configurationResolver/index.js'`），否则 `index.test.ts` 覆盖检查失败。改 platform 后 apps 看到的是 `dist/`，dev watcher 自动重建，非 dev 要 `pnpm --filter @universe-editor/platform build`。

## ② main env 快照

renderer 是浏览器上下文，读不到 `process.env` / `os.homedir()` / `process.cwd()`。`EnvironmentSnapshotMainService` 把这三样一次性打包成 `IEnvironmentSnapshot`，经 ProxyChannel 暴露给 renderer。

- 契约在 `shared/ipc/environmentSnapshotService.ts`；实现读一次 `process`/`os`，`undefined` 的 env 值丢弃。
- **安全边界**：全量 env 是刻意暴露（对齐 VSCode env resolver），**仅内存、不落 settings.json、不碰 AI 密钥存储**；终端本来就用这份 env 起子进程，暴露给 renderer 不扩大信任面（见文件头注释）。
- renderer 侧把它当**会话级稳定值**缓存（`snapshotService.getSnapshot()` 一次，`userHome`/`env` 转成 promise 喂给 resolver，`${userHome}`/`${env:X}` 惰性解析），对齐 VSCode 的 `_envVariablesPromise`/`_userHomePromise`。

## ③ renderer 数据源门面

`ConfigurationResolverService extends AbstractVariableResolverService`：把抽象类接到具体数据源。

- `RendererVariableResolveContext` 实现 `IVariableResolveContext`：
  - `getFolderUri(name)` / `getWorkspaceFolderCount()` ← `IWorkspaceService`（**单文件夹工作区**：只有 current 一个，按 name 匹配）。
  - `getConfigurationValue(_, section)` ← `IConfigurationService.get`。
  - `getFilePath()` ← `IEditorService.activeEditor`（结构化读 `.resource?.fsPath`，activeEditor 类型是 legacy input 无 resource，但实例都带）。
  - `getExecPath`/`getSelectedText`/`getLineNumber`/`getColumnNumber`/`getExtension` 目前返回 undefined（未接活动编辑器选区/扩展定位）——要支持 `${selectedText}`/`${lineNumber}` 就在这里接 Monaco。
- 构造时取 env 快照，`platform` 来自 `IHostService.platform`。
- **两个 decorator**：跨进程用的是 platform 的 `IConfigurationResolverService`；本地又建了个 `IConfigurationResolverServiceRenderer`（`createDecorator`）做注册 id。消费方按 `@IConfigurationResolverServiceRenderer` 注入、类型标 `IConfigurationResolverService`。
- 末尾 `registerSingleton(..., InstantiationType.Delayed)`；`renderer/services/index.ts` 加副作用 import（已加 `./configurationResolver/ConfigurationResolverService.js`）。

## 终端 cwd 的两段式回退（消费方，不在 resolver 里）

「变量展开」只给一个字符串；「这个 cwd 能不能用」分两段，renderer 一段、main 一段：

**renderer `TerminalManagerService._resolveCwd`**（决定目标目录）：
1. 取 `spec.cwd ?? config('terminal.integrated.cwd')` 作 `rawCwd`。
2. `resolver.resolveAsync(scope, rawCwd)` 展开变量；**抛错就降级成「无自定义 cwd」**（如 `${workspaceFolder}` 但没开文件夹），log warn，让回退兜底。
3. `computeTerminalCwd(resolved, workspaceCwd, userHome, platform)`（**export，单测点**）= VSCode `terminalEnvironment.getCwd`：
   - 绝对路径 → 原样用；相对 + 有 workspace 根 → `joinPath(根, resolved)`；相对但无根 → 丢弃。
   - 都没有 → 回退 `workspaceCwd || userHome || undefined`。undefined 时让 node-pty 用进程默认。
   - `userHome` 经 `_getUserHome()` 从 env 快照惰性取一次并缓存。

**main `TerminalMainService._resolveCwd`**（最后一道校验，防启动失败）：
1. `normalizeWindowsDriveCwd`（去掉 `/C:/` 前导斜杠）+ `sanitizeCwd`（剥包裹引号 microsoft/vscode#160109 + 盘符大写 #9448）。
2. `statSync(cwd).isDirectory()` 校验——**不存在 / 不是目录就忽略**（log warn），返回 undefined 让 pty 用默认，**绝不因坏 cwd 让终端创建失败**。
3. `_cwdStat` / `_platform` 是构造注入的可替换依赖（`statSync` / `process.platform`），单测据此注入假 stat。

## IPC 接线（EnvironmentSnapshot，套路 C 七处）

加/改这个跨进程服务时，七处对齐（参考本次 diff）：
1. `shared/ipc/environmentSnapshotService.ts` —— 契约 + decorator。
2. `shared/ipc/channelNames.ts` —— `ServiceChannels.EnvironmentSnapshot`。
3. `main/services/main-services.ts` —— `registerSingleton(IEnvironmentSnapshotService, new SyncDescriptor(...))`。
4. `main/ipc/registerMainServices.ts` —— `server.registerChannel(..., ProxyChannel.fromService(app.environmentSnapshot))`。
5. `main/window/scopedServicesFactory.ts` —— `ApplicationServices.environmentSnapshot` 字段。
6. `main/index.ts` —— `environmentSnapshot: accessor.get(IEnvironmentSnapshotService)`。
7. `renderer/ipc/registerProxyServices.ts` —— `PROXY_SERVICE_BINDINGS` 加 `{ id, channel }`（`ProxyChannel.toService` 自动绑）。

> 改 `ApplicationServices` 记得补测试桩：`scopedServicesFactory.test.ts` / `windowMainService.test.ts` 里加 `environmentSnapshot: {} as ...`（本次已补）。

## 用户可见面

- **只有一处文案**：`terminal.integrated.cwd` 设置描述新增「支持 `${workspaceFolder}`、`${userHome}`、`${env:NAME}` 等变量」（`SettingsContribution.ts` 英文 + `i18n/messages/zh-CN.ts` 中文，两处同步）。
- **用户文档**：`docs/user/zh-CN/customization/settings.md` 的「在设置值里使用变量」一节（变量表 + 相对路径拼根 + 无效 cwd 回退）。改变量清单 / 回退行为要同步这里，跑 `pnpm docs:check`。

## 易踩坑速记

1. **改错层白改**：语法/新变量求值 → platform `variableResolver`；变量接哪个数据源 → renderer `RendererVariableResolveContext`；「拿不到 env/home」→ main env 快照。三层别串。
2. **win32 env 大小写**：`prepareEnv` 把 env key 全小写、查询也小写。新增涉及 env 的逻辑别绕过它，否则 Windows 上 `${env:Path}` vs `${env:PATH}` 不一致。
3. **未解析变量原样保留**：`toObject()` 对没 resolve 的 `${x}` 保留原文，不报错。若消费方期望「未知变量清空」，得自己处理。
4. **需要活动编辑器的变量会抛**：`${file}`/`${selectedText}`/`${lineNumber}` 等在无编辑器时 throw `VariableError`。终端消费方**必须 catch** 并回退（`_resolveCwd` 已 try/catch）；直接用 `resolveAsync` 的新消费方别忘了兜。
5. **cwd 校验在 main，不在 renderer**：renderer 只算目标路径，`statSync` 目录校验在 `TerminalMainService`。别在 renderer 加 fs 校验（renderer 无 node fs，且职责错层）。
6. **Action2 里用 resolver 要防 accessor 失效**：`resolveAsync` 是 async，Action2 的 `ServicesAccessor` 遇第一个 await 即失效——在 await 前同步取完 service（见 [[action2-async-accessor-invalidation]]）。
7. **path.ts 新函数输出正斜杠**：`joinPath`/`basename`/`dirname`/`relativePath` 都不带平台原生分隔符（`${pathSeparator}` 才给 `\`）。要平台原生分隔符另说，别指望这些函数给。
8. **env 快照是会话级缓存**：renderer 取一次就不再更新。若将来要「运行时 env 变了要重读」得改缓存策略（当前刻意对齐 VSCode 的一次性 promise）。

## 验证

```bash
pnpm --filter @universe-editor/platform build         # 改 platform 后，apps 才看到新导出
pnpm check                                            # lint+typecheck+test，仅看错误
pnpm docs:check                                       # 改了 settings.md 变量说明后跑
# 单测重点：
#   packages/platform/src/__tests__/configurationResolver/*.test.ts   （语法内核）
#   packages/platform/src/__tests__/base/path.test.ts                 （path 纯函数）
#   apps/editor/.../configurationResolver/__tests__/ConfigurationResolverService.test.ts  （renderer 数据源）
#   apps/editor/.../terminal/__tests__/TerminalManagerService.test.ts + terminalMainService.test.ts  （cwd 两段式回退）
```

## 关键参考路径

- `packages/platform/src/configurationResolver/{configurationResolver,configurationResolverExpression,variableResolver,index}.ts` —— 语法内核三件套（文件头注释标了 vs VSCode 的裁剪点）
- `packages/platform/src/base/path.ts` —— 变量求值 + cwd 拼接用的 string-only 路径纯函数
- `apps/editor/src/shared/ipc/environmentSnapshotService.ts` —— env 快照契约（含安全边界注释）
- `apps/editor/src/main/services/environmentSnapshot/environmentSnapshotMainService.ts` —— main 读 process/os
- `apps/editor/src/renderer/services/configurationResolver/ConfigurationResolverService.ts` —— renderer 数据源门面 + 单例
- `apps/editor/src/renderer/services/terminal/TerminalManagerService.ts` —— `_resolveCwd` + `computeTerminalCwd`（renderer 段回退）
- `apps/editor/src/main/services/terminal/terminalMainService.ts` —— `_resolveCwd` + `sanitizeCwd` + statSync 校验（main 段回退）
- `docs/user/zh-CN/customization/settings.md` —— 用户侧「在设置值里使用变量」
- 相关 skill：[explorer-subsystem-context]（另一个用 workspace/editor 数据源的子系统）；跨进程服务套路见 `apps/editor/CLAUDE.md` 套路 C
- 相关 memory：[[action2-async-accessor-invalidation]]（async run 的 accessor 失效）、[[path-comparison-convergence]]（path.ts 的路径身份约定，与本 skill 新增的路径纯函数同域）

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件
