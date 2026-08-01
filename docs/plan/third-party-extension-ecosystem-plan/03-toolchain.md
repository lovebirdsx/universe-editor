# 03 — 工具链：create-extension 脚手架与 uex CLI

> 实施状态（2026-08-01）：✅ 已完成。`packages/create-extension`（basic/webview 两模板）与 `packages/uex`（package/ls/dev/login/publish/unpublish）落地；模板防腐冒烟 `pnpm test:templates` + CI `extension-templates` job（已进 ci-gate）。`uex publish` 客户端先行，服务端 Phase D 联调。
> 与草图的差异：模板主入口为 `dist/extension.js`（对齐全仓扩展惯例，非草图的 `dist/index.js`）。

> Phase C。目标：`npm create @universe-editor/extension` 起项目、`uex dev` 起开发宿主、`uex package` 出 .vsix、`uex publish` 上市场（服务端 Phase D 联调）——全程不接触本仓库。
> 对标：`yo code`（generator-code）+ `vsce`。命令与参数命名照抄 vsce 惯例，不发明（CLI 接口进第三方 CI 后同样难改）。

## 1. 包的分工与工程形态

```
packages/create-extension/    @universe-editor/create-extension
  bin：npm create @universe-editor/extension [目录]
  职责：交互问询 → 模板落盘 → 变量替换 →（可选 git init + npm install 提示）
packages/uex/                 @universe-editor/uex（bin: uex）
  职责：package / ls / dev / login / publish / unpublish
```

- 两包都是**正常 workspace 成员**（进 `pnpm-workspace.yaml` globs，正常 lint/typecheck/test），只是同时发 npm——与 extension-api 同一种双态。
- `uex` 依赖 `@universe-editor/extension-packaging`（createVsix/readVsixManifest）+ `@universe-editor/extension-manifest`（manifest zod 校验、semver）——**CLI 与宿主共享同一份校验真相**，杜绝"CLI 打包通过、宿主拒载"的漂移（01 §1 的决策在这兑现）。
- **CLI 解析用 `node:util` 的 `parseArgs`，零框架依赖**；交互问询用 `@clack/prompts`（create 包专用，uex 保持非交互友好——CI 里跑 `uex publish` 不能有 TTY 依赖）。

## 2. create-extension 脚手架

### 2.1 问询项（保持 4 问以内，其余给默认）

1. 扩展名（校验 npm name 规则）；2. publisher（校验 id 规则，提示"发布时必须与 token 归属一致"）；3. displayName / description；4. 模板：`basic`（命令 + hello world）或 `webview`（自定义编辑器预览，照 pdf 模式裁剪）。

### 2.2 模板内容（两模板共享骨架）

```
<name>/
  package.json          name/publisher/version 0.0.1
                        engines.universe: ">=<当前API版本> <1.0.0"   ← 创建时动态生成下界
                        main: "./dist/extension.js"
                        activationEvents: ["onCommand:<name>.helloWorld"]（basic）
                        contributes.commands / customEditors（按模板）
                        files: ["dist", "icon.png"]                  ← 白名单，见 §3.2
                        scripts: { build, watch, package: "uex package", universe:prepublish: "npm run build" }
                        devDependencies: extension-api / esbuild / typescript / @universe-editor/uex
  src/extension.ts      activate/deactivate + registerCommand（webview 模板加 provider）
  esbuild.config.mjs    bundle → dist/index.js；platform=node、format=esm
                        sourcemap: true + sourcesContent: true       ← 02 §5 断点约定
                        --watch 分支
  tsconfig.json         strict 全家桶（含 noUncheckedIndexedAccess/exactOptionalPropertyTypes，
                        与宿主同款——作者代码质量从模板起步就对齐）
  .vscode/launch.json   "attach" 到 127.0.0.1:9229 + outFiles: ["${workspaceFolder}/dist/**/*.js"]
  .vscode/tasks.json    npm: watch（后台 problemMatcher）
  .gitignore            node_modules / dist / *.vsix
  README.md             三步上手：npm i && npm run watch → uex dev --inspect=9229 → F5 attach
  icon.png              占位图
```

要点：
- **extension-api 放 devDependencies**：扩展以 vsix 分发不发 npm，API 包只在 esbuild bundle 时需要（运行时经 globalThis bridge delegate，见 extension-api 头注释）。
- 模板引擎不引入：文件树拷贝 + `__name__`/`__publisher__` 字符串替换，模板即真实可构建项目（模板目录本身进 CI 构建，防模板腐烂）。
- vitest 单测样例、多语言 NLS、`--inspect-brk` 复合 F5 配置：登记为模板增强，MVP 不进问询矩阵。

## 3. uex CLI

### 3.1 子命令总览（对齐 vsce）

| 命令 | 行为 | 依赖 |
|---|---|---|
| `uex package` | 校验 → `universe:prepublish` script（存在则跑，对齐 vsce `vscode:prepublish`）→ createVsix → `<publisher>.<name>-<version>.vsix` | extension-packaging |
| `uex ls` | 打印将进包的文件清单（打包前自查，vsce 同名） | 同上 |
| `uex dev [--inspect=<port>] [--user-data-dir=<dir>]` | 定位已装编辑器 → 以 `--extension-development-path=<cwd>` 拉起（02 的参数） | 编辑器定位逻辑（§3.3） |
| `uex login <publisher>` | 交互输 token → 存本地配置 → 调 `whoami` 验证归属 | Phase D 服务端 |
| `uex publish [--packagePath <vsix>]` | 无 packagePath 则先 package → POST publish API | Phase D 服务端 |
| `uex unpublish <id>[@<version>]` | 下架（限本 publisher） | Phase D 服务端 |

### 3.2 package 的文件收集：白名单制（与 vsce 的关键分歧，故意的）

vsce 用 `.vscodeignore` 黑名单（默认全包、逐条排除）——历史上无数扩展把 `.env`/密钥/node_modules 打进 vsix 就是这么来的。我们反过来：**`files` 白名单必填**（`package.json` 的 `files` 数组 + 恒定附带 `package.json`/`README.md`/`CHANGELOG.md`/`LICENSE`/manifest 声明的 icon），无 `files` 字段直接报错拒绝打包，错误信息给出修复示例。`extensions-external/*` 现有打包已是这个模式（`files: ["dist","assets","icon.png"]`），生态从第一天就干净。

### 3.3 `uex dev` 的编辑器定位

优先级：`--editor-path` flag > `UNIVERSE_EDITOR_PATH` env > 平台默认探测（win：注册表 App Paths / `%LOCALAPPDATA%/Programs/<产品>` 常规安装位；darwin：`/Applications/*.app`；linux：`PATH` 查找）。探测失败给出三选一的明确提示（装编辑器 / 设 env / 传 flag）。**探测逻辑独立成纯函数可单测**（mock fs/registry），平台矩阵是这个命令唯一的复杂度来源。

### 3.4 registry 地址与凭据

- 市场地址：`--registry` flag > `UNIVERSE_GALLERY_URL` env > `~/.uex/config.json`。**无默认值**（对齐编辑器侧 GALLERY_URL 的 OSS 语义：未配置即报错并提示）。
- token：`UNIVERSE_MARKET_TOKEN` env（CI 场景）> `~/.uex/config.json`（`uex login` 写入，**明文存储 + 文档警示**，对齐 vsce 的 `~/.vsce` 现实；OS keychain 集成登记 Phase F）。config 按 registry 地址分桶存多组凭据。

## 4. 与仓库内既有工具的关系

- `extensions-external/*/scripts/pack.mjs`（createVsix 薄封装 + createRequire 借依赖 hack）**保留不动**——它们是 e2e 被测物与 `ext:release` 流程的一环。待 uex 稳定后再评估把 `ext:release` 切到 `uex package` 吃 dogfood（登记为后续收敛项，非本计划范围）。
- skill `create-extension`（仓库内 AI 脚手架）与本脚手架服务不同人群（仓库内内置扩展 vs 仓库外第三方），**不合并**；skill 文档加一行互指引。

## 5. 测试与验证

- 单测：模板落盘 + 变量替换快照；`files` 白名单收集（含"无 files 报错"）；`universe:prepublish` 触发；编辑器定位纯函数（mock 三平台）；publish 的 HTTP 客户端（mock server，联调留 Phase D）。
- **Phase C 完成标准（全程仓库外）**：`npm create @universe-editor/extension` → `npm i && npm run watch` → `uex dev --inspect=9229` 起开发宿主、F5 attach 断点命中 → `uex package` 出 .vsix → 编辑器"从 VSIX 安装"成功且命令可用。
- 模板防腐：CI 里对两个模板目录跑"替换变量 → npm i（用 npm pack 的本地包）→ build → uex package"（与 Phase E 外部消费者冒烟合并成一个 job）。

## 6. 坑与注意

- **create 的目录安全**：目标目录非空时拒绝（除非 `--force`），绝不静默覆盖。
- **vsix 文件名与 id 规则**：`<publisher>.<name>-<version>.vsix` 与市场安装侧的解析约定一致（`extensionManagementService` 落盘目录名同构）；publisher 缺失时 `uex package` 直接报错（市场装强制 publisher 是既定决策，工具链在源头拦住，别让作者到 publish 才发现）。
- **Windows 路径**：`uex dev` 拼编辑器 argv 时路径含空格（`Program Files`）——spawn 数组传参不过 shell（仓库既有红线 [[cli-stdin-hang-on-prompt]] 同源教训）。
- **uex 的错误输出面向外部作者**：报错不能是仓库内行话（"重启 host 重扫"），要给动作指引；这是第一个"外部人读我们报错"的表面，文案过一遍 review。
