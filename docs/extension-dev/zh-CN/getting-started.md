# 快速上手

> 从一个空目录开始，走完「创建 → 调试 → 打包 → 安装自测 → 发布」的完整流程。全程不需要接触 Universe Editor 的源码仓库。

> 💡 也可以让编辑器里的 AI 替你走这套流程：在 Agent 会话输入框敲 `/`，选择内置技能 `new-extension`（从零创建）或 `port-vscode-extension`（移植 VSCode 插件），Agent 会按本套文档确认需求、搭骨架、写实现、配 e2e 测试。

## 前置条件

- **Node.js 22+** 与 npm（脚手架产物用 npm 安装依赖，不要求 pnpm）
- 已安装 **Universe Editor**（开发调试要拉起它；`uex dev` 会自动定位安装位置）
- 可选：VSCode，用于 attach 断点调试（也可以用任何支持 DAP attach 的工具）

## ① 创建项目

```bash
npm create @universe-editor/extension my-extension
```

脚手架会交互式地问四件事：

- **name**：扩展 id 的下半部分（npm 小写名规则，如 `my-extension`）
- **publisher**：发布者名（如你的团队名；完整扩展 id = `<publisher>.<name>`）
- **displayName / description**：市场里展示的名字与简介（可留空，displayName 默认等于 name）
- **template**：`basic`（一个 Hello World 命令）或 `webview`（只读自定义编辑器预览）

全部参数也可以用命令行旗标一次给齐（CI 场景）：

```bash
npm create @universe-editor/extension my-extension -- \
  --name my-extension --publisher acme --template basic
```

## ② 认识项目结构

```
my-extension/
  package.json          # 扩展清单：id、engines.universe、activationEvents、contributes
  src/extension.ts      # 入口：activate / deactivate
  esbuild.config.mjs    # 打包：src → dist/extension.js（ESM，inline sourcemap）
  tsconfig.json         # strict 全套
  .vscode/
    launch.json         # "Attach to Extension Host"，attach 127.0.0.1:9229
    tasks.json          # 后台 watch 任务
  icon.png              # 市场图标
```

`package.json` 里三个字段值得立刻看一眼：

- `"engines": { "universe": ">=0.12.0 <1.0.0" }` —— 声明兼容的扩展 API 版本区间。**不是编辑器版本**；语义与推荐写法见 [API 版本与 `engines.universe`](./versioning.md)。
- `"activationEvents": ["onCommand:my-extension.helloWorld"]` —— 扩展什么时候被激活（懒加载，不拖慢启动）。
- `"files": ["dist", "icon.png"]` —— 打包白名单，只有列进去的会进 `.vsix`。

字段全集见 [扩展的结构](./extension-anatomy.md)。

## ③ 安装依赖并启动 watch

```bash
cd my-extension
npm install
npm run watch
```

依赖里的 `@universe-editor/extension-api` 来自公开 npm——它就是宿主 API 的类型定义与版本锚点。esbuild 会把它内联进 `dist/extension.js`，运行时实际调用委托给宿主进程里的实现，所以**扩展产物不需要把 API 包当运行时依赖**。

## ④ 拉起扩展开发宿主

另开一个终端：

```bash
npx uex dev --inspect=9229
```

`uex dev` 会把当前目录作为「开发中扩展」拉起一个 Universe Editor 实例（等价于传 `--extension-development-path=<当前目录> --inspect-extensions=9229`）。这个实例：

- 窗口标题带 **[扩展开发宿主]** 标识；
- 使用独立的用户数据目录（`<用户数据>/Universe Editor - ExtDev`），不会污染你日常使用的编辑器配置；
- 开发中的扩展**豁免 Workspace Trust 门控**，直接激活；
- 与你日常打开的编辑器实例互不干扰（跳过单实例锁）。

在开发宿主里按 `Ctrl+Shift+P` 打开命令面板，运行你的命令（basic 模板是 `Hello World`）——弹出提示框说明整条链路通了。

## ⑤ 断点调试

脚手架生成的 `.vscode/launch.json` 已经备好 attach 配置。在 VSCode 里打开扩展项目目录，按 `F5`（或运行 "Attach to Extension Host"），然后在开发宿主里再次运行命令——断点命中在**扩展宿主进程**里（一个独立的 Node 进程，不是编辑器主进程）。

esbuild 已配置 inline sourcemap，断点直接落在 `src/extension.ts` 的 TypeScript 源码上。更多形态（`--inspect-brk` 激活前断住、重启后重新 attach、日志通道）见 [调试扩展](./debugging.md)。

## ⑥ 迭代循环

```
改 src/extension.ts 并保存 → watch 自动重编 → 开发宿主自动重启扩展宿主 → 再验证
```

开发宿主会监听扩展 `main` 入口产物（`dist/extension.js`）所在目录的变更，产物更新后自动重启扩展宿主、重新加载新代码（防抖约半秒）——保存源码后稍等片刻即可验证，不需要手动操作，也不需要重开编辑器窗口。

自动重启由设置 `extensions.autoRestartOnChange` 控制（默认开启，仅在扩展开发窗口生效）；关掉它或遇到产物分散在多目录等监听覆盖不到的罕见形态时，仍可手动执行「重启扩展宿主」（命令面板搜索 *Restart Extension Host*）兜底——它会停掉扩展宿主进程并重启，从磁盘重新加载产物。

注意：自动重启同样会断开已 attach 的调试器（原进程已退出），需要重新 attach；首次触发自动重启时会弹一次性通知说明这一点。

## ⑦ 打包与安装自测

```bash
npx uex package
```

产出 `acme.my-extension-0.0.1.vsix`。发布前先在真实安装路径里自测一遍：打开你日常使用的编辑器（不是开发宿主），在扩展视图里执行「从 VSIX 安装…」（*Extensions: Install from VSIX…*）选中这个文件，确认命令可用。

## ⑧ 发布

浏览器打开 `<市场地址>/gallery/register` 自助注册 publisher（token 只展示这一次，立即保存；注册是审批制），然后：

```bash
npx uex login acme --registry <市场地址>   # 一次性：粘贴注册页展示的 token，会先调 whoami 验证归属
npx uex whoami          # 查看审批状态；管理员批准后即可发布
npx uex publish         # 自动先 universe:prepublish（build + package）再上传
```

发布后其他用户就能在编辑器的扩展视图里搜到并安装。token 申请与审批细节、版本不可变规则、下架流程见 [发布扩展](./publishing.md)。

## 下一步

- 想往菜单/快捷键/设置里加东西 → [贡献点参考](./contribution-points.md)
- 想知道宿主一共提供哪些 API → [API 概览](./api/README.md)
- 做自定义预览界面 → [自定义编辑器与 Webview](./webview-guide.md)
- 做语言支持 → [语言特性](./language-guide.md)
- 已有 VSCode 扩展 → [从 VSCode 移植](./migration-from-vscode.md)
