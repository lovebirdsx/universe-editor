# 本文从 apps/editor/CLAUDE.md 拆出，范围是用户数据目录与启动期配置机制——模式判定表、CLI/env 收口、--help 生成、构建期注入出厂默认值。

## 模式判定（applyProductIdentity）

main 入口（`src/main/index.ts`）在所有 service 实例化前调 `applyProductIdentity()`（`src/main/productPaths.ts`）切换 `app.setName` / `setPath('userData', ...)` / `setAppUserModelId`：

| 模式 | 判定 | userData（Win） | AppUserModelId |
|---|---|---|---|
| 发布版 | `import.meta.env.DEV === false` 且无环境变量 | `%APPDATA%/Universe Editor` | `io.universe.editor` |
| dev | `import.meta.env.DEV === true` | `%APPDATA%/Universe Editor - Dev` | `io.universe.editor.dev` |
| E2E | `UNIVERSE_E2E=1` | `%APPDATA%/Universe Editor - E2E` | `io.universe.editor.e2e` |
| 扩展开发宿主 | 存在 `--extension-development-path`（优先级低于 E2E） | `%APPDATA%/Universe Editor - ExtDev` | `io.universe.editor.extdev` |

任何模式都可用 `UNIVERSE_USER_DATA_DIR=<absolute>` 或 Electron 原生 `--user-data-dir=<absolute>` CLI 参数覆盖 userData 目录（**CLI 优先**；productName 仍按 dev/e2e 决定）。E2E fixture 给每个 Playwright worker 分配 tmp 目录即依赖此机制。darwin/linux 走平台标准目录（`~/Library/Application Support` 或 `XDG_CONFIG_HOME || ~/.config`）。所有 `app.getPath('userData')` 调用点自动跟随，不需要单独传路径。

## CLI/env/文件收口（EnvironmentMainService）

CLI 参数 / 环境变量 / 部署配置文件的读取统一收口到 `EnvironmentMainService`（`src/main/environment/`），它在 `index.ts` 最顶部构造（早于任何 `app.getPath('userData')`），基于 platform 的 `ConfigResolver` + cli/env/file 可插拔来源（机制见 `packages/platform/src/configuration/sources/`），优先级 `cli > env > file > default`。声明表在 `environment/configItems.ts`。新增"既能命令行又能环境变量配"的启动期配置时加一条声明项，不要再散落 `process.env[...]`。

## `--help` / `--version`

在 `index.ts` 构造完 `environmentService` 后、任何初始化（console 拦截器、单实例锁）之前命中即 `app.exit(0)`，输出走真实 stdout（GUI 打包版双击启动无控制台时不可见，dev/重定向场景可见）。`--help` 文本由 `environment/configItems.ts` 的 `CLI_OPTIONS` 自动生成；让某个 flag 出现在帮助里，给它的 `ConfigItem` 补 `description`（可选 `cliAlias` 短选项、`args` 值占位符）即可，无需改渲染代码。

## 自动更新服务器（发布版可配置）

feed url 打包默认在 `electron-builder.yml` 的 `publish.url`；发布版（`app.isPackaged`）可在运行时覆盖而不必重新打包——`--update-url=<url>` / `UNIVERSE_UPDATE_URL` / `<userData>/update-config.json` 的 `updateUrl` 字段（仅覆盖 url，channel 仍打包默认）。dev/E2E 不应用 override，仍走 `dev-app-update.yml`。

## 构建期注入 settings 默认值（configurationDefaults）

内网服务地址（Swarm、问题上报）不进仓库，但打包版要开箱可用——机制是 `product.json` 的 `configurationDefaults`（一个 `{ "<settings key>": <value> }` 扁平对象），它作为**出厂默认值**参与配置合并：优先级高于配置项自己的 `schema.default`，**低于所有可写层**（VSCodeUser / User / Project / Memory），所以用户 settings.json 照常覆盖、Reset 回落到注入值。

链路（四跳，契约在 `src/shared/productDefaults.ts`）：`.env` → 打包 stage 写进 `resources/product.json` → `EnvironmentMainService.configurationDefaults`（env `UNIVERSE_CONFIGURATION_DEFAULTS` 优先于 product.json）→ 窗口 argv `--ue-configuration-defaults=<base64 json>`（base64 而非裸 JSON：这是唯一一个值会含 `"` 与空格的 argv 旗标，由 Chromium 写、Node 读，base64 绕开两边的引号规则；顺带让注入的内网地址不出现在系统进程列表里） → preload `window.ipc.configurationDefaults` → renderer `main.tsx` 在 `new ConfigurationService()` **之前** `ConfigurationRegistry.registerDefaultOverrides(...)`。注册在 registry 而非直接写 Default 层，因为扩展的 `contributes.configuration` 异步注册会全量重算该层。扩展宿主侧无需改动：`workspace.getConfiguration` 经 RPC 读的就是含 Default 层的合并值。

加一个可注入的 key = 两步：① `scripts/lib/productDefaults.mjs` 的 `CONFIGURATION_DEFAULTS_ENV_MAP` 加一行 `{ env, setting }`；② `.env.example` 加一行注释掉的说明。dev/`dev:run` 由启动脚本读 `.env` 透传同一个 env 变量，无需另配。`build/product.json` **刻意不放占位值**——假地址会让功能「看起来已配置」然后诡异失败。
