# 计划 05 · 扩展系统

> 配套总览：[README.md](./README.md)
> 范围：`packages/{extension-host,extension-api,extensions-common}/`、`extensions/`、`main/services/extensionHost/`
> 主轴：**API 兼容性策略** + **fs 网关纵深防御** + **extensionService 拆分** + **extension-api 契约测试**。

> 参考 memory：`extension-system-progress`、`typescript-builtin-plugin`、`language-features-plugin-migration-roadmap`。Phase 0–6 已完成，本计划是其上的治理与加固。

---

## 现状肯定

- **双 host 信任级隔离 + fs 网关**：trusted/restricted 分级，restricted host 走 Node `--experimental-permission`。
- **扩展崩溃隔离彻底**：激活失败仅日志不中止（`extensionService.ts:955-957`）；`unhandledRejection` 钩子仅记录不杀宿主（`bootstrap.ts`）。
- **lazy activation**：按 activation event 激活，不全量加载；激活前 RPC 排队（`serviceReady` Promise）。
- **TS LSP 自管理**：typescript 扩展自 spawn tsserver，崩溃不影响编辑器（选项 B 真 VSCode 范式）。
- **git 扩展测试相对完整**（14 测试，覆盖 statusParser / repository / worktree）。

---

## P1 · fs 网关 symlink 纵深防御（非"漏洞"，是加固）

### 问题
fs 网关 `acpPathPolicy.check` 是**纯文本级**判定，不解析 symlink。理论上 workspace 内的 symlink 指向敏感目录（`~/.ssh` 等）时，文本检查通过，实际访问跟随链接逃逸。

### 证据
`renderer/services/acp/acpPathPolicy.ts:7-9` 注释明确：
```
The policy is intentionally text-level (no real fs lstat): the renderer has
no synchronous fs primitives ... Anything beyond what we can decide from
strings is left to the underlying IFileService.
```
`MainThreadFs._guard`（`MainThreadFs.ts:28-37`）每次操作都过 policy，但 policy 不查 realpath。

### 重要定级说明
这是**有意的设计权衡**，不是疏漏。当前主要装载内置/可信扩展，restricted host 还有 Node 权限模型兜底。因此定 **P1 纵深防御**，而非 P0 漏洞。

### 落地步骤
- 在 **main 端 `IFileService`**（已有同步 fs 能力）对扩展/agent 发起的访问，解析 `fs.realpath` 后**再过一次 policy**（拒绝 realpath 落在敏感前缀或逃出 workspace 的请求）。这把"文本防线"升级为"文本 + 真实路径双防线"，且不破坏 renderer 无同步 fs 的约束。
- 打开 workspace 时扫描根目录下指向敏感位置的 symlink，给一次性告警。

### 验证
单测：workspace 内 symlink → `~/.ssh` 的读请求被 main 端 realpath 校验拒绝；正常软链（指向 workspace 内）放行。

---

## P1 · API 版本兼容策略缺失

### 问题
`extension-api` 以包版本（`0.1.0`）作为 API 版本，但**无向后兼容承诺、无弃用机制、无版本协商语义**。扫描器只做 semver 满足性检查，API 移除后旧扩展仍被加载，激活时才 "undefined is not a function"。

### 证据
- `packages/extension-api/src/index.ts` 顶部注释"package version is the API version"，但无 CHANGELOG/兼容矩阵。
- `extensionScanner.ts` 的 `satisfies(hostApiVersion, manifest.engines.universe)` 检查不处理主版本破坏语义。

### 影响
0.x 频繁破坏更新时扩展生态无法追赶；也偏离 VSCode 的稳定 API 策略，影响生态复用。

### 落地步骤
- 写 `packages/extension-api/COMPATIBILITY.md`：定义 patch/minor/major 的 API 表面承诺，以及 1.0 冻结时间线。
- 关键接口加 `@deprecated since x.y` JSDoc，运行时对调用 deprecated API 打一次 warn。
- 长期：API 表面快照测试（见下条），任何破坏性改动需显式更新快照 + bump major。

### 验证
快照测试存在并通过；故意删一个 API → 快照 diff 报警。

---

## P1 · extension-api 零测试

### 问题
`packages/extension-api/`（720 行公共 API 表面）**无任何测试**，API 改动无回归检测。

### 证据
`packages/extension-api/` 下无 `__tests__`。

### 落地步骤
- 加 `__tests__/index.test.ts` 契约测试：断言各 namespace（commands/window/workspace/languages/scm/ai）关键方法存在且类型正确；version 符合 semver。
- 作为 P1 版本策略的执行抓手——这份测试就是"API 表面快照"。

### 验证
`pnpm --filter @universe-editor/extension-api test`（需先给该包配 vitest，若尚无）。

---

## P1 · extensionService.ts 职责过载（959 行）

### 问题
单类耦合 5 类职责：命令注册/执行、SCM 模型、文本编辑器快照、语言 provider 注册/路由、诊断/输出/状态栏/装饰。6 个并行 `Map` 字段各是一个"迷你服务"。

### 证据
`packages/extension-host/src/extensionService.ts:360-959`，含 `_commands`/`_providers`/`_sourceControls`/`_documents` 等 Map，`_doActivate` 混模块加载 + 生命周期 + 错误处理。

### 影响
单测须 mock 全部 MainThread* 接口；改一处要理解全文件。

### 落地步骤（保持对外 RPC 入口不变）
- 拆为：`ExtensionActivationService`（加载 + 生命周期）、`LanguageProviderRegistry`（provider 注册/路由）、`ExtensionCommandRegistry`（命令）。`ExtensionService` 作 facade 编排。
- 各小类独立单测，只 mock 自身依赖。

### 验证
`pnpm --filter @universe-editor/extension-host test` + 扩展相关 e2e（git/typescript/markdown）。

---

## P2 · git 扩展 repository.ts 过大（1177 行）

### 问题
单文件含：磁盘 watcher + refresh 状态机、git 状态解析 + 文件装饰、worktree 管理、SCM 输入框状态，8 个接口定义混在一起。

### 证据
`extensions/git/src/repository.ts` 1177 行。

### 落地步骤
按领域拆：`repository.ts`（核心）/ `repositoryWatcher.ts` / `repositoryDecoration.ts` / `repositoryWorktrees.ts` / `repositoryTypes.ts`。git 扩展已有较好测试基础，拆分后补对应单测。

### 验证
`pnpm --filter <git-ext> test` + SCM e2e。

---

## P2 · activation events 缺常量与文档

### 问题
`activationEvents: string[]` 手写字符串，拼错则永不激活，无 lint 兜底，无事件清单文档。

### 落地步骤
- 提供 `ActivationEvents` 常量/构造器（`onCommand(id)` / `onLanguage(lang)` / `onView(id)`…）。
- manifest schema 加 activation event 模式校验。
- 文档化支持的事件清单。

---

## 任务依赖与建议顺序

```
P1 extension-api 契约测试 ──► P1 API 兼容策略（测试是策略的抓手）
P1 fs 网关 realpath 纵深防御（独立、安全加固）
P1 extensionService 拆分（测试先行）
P2 git repository 拆分 / activation 常量（机会型）
```

扩展系统当前以内置扩展为主、不紧急；但 **API 兼容策略 + 契约测试**越早定越省事（决定未来生态复用成本），建议优先。
