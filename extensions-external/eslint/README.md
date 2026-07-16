# universe-eslint

把 [ESLint](https://eslint.org/) 集成进编辑器的扩展——诊断波浪线、快速修复、一键修复全部、
作为格式化器运行、保存时自动修复。对标 [vscode-eslint](https://github.com/microsoft/vscode-eslint)：
命令 id、配置项名与 VSCode 原生保持一致。

它使用**工作区自己安装的 ESLint**（`node_modules` 里那份）——检查结果与你在命令行跑 `eslint`
完全一致；工作区没装 ESLint 时安静地不工作（不报错）。

这个扩展**不在 pnpm workspace 内**（它以 `.vsix` 形态经市场 / 本地安装链路落地，而非内置扩展），
所以没有本地 `node_modules`：构建 / 测试 / 类型检查所需的 `esbuild` / `vitest` / `tsc` / `eslint`
以及被打进产物的 `vscode-jsonrpc` / `vscode-languageserver-types` / `vscode-uri`，
全部从 workspace 里已装好这些依赖的 `extensions/typescript` 借用解析
（见 `esbuild.config.mjs` 的 `nodePaths`、`tsconfig.json` 的 `paths`、`vitest.config.ts` 的 alias、
以及 `package.json` scripts 里指向 `../../extensions/typescript/node_modules/*` 的工具入口）。

> ⚠️ 这层「借用」依赖 `extensions/typescript` 持续安装这几个包。若它未来删除对应依赖，本扩展的
> 构建 / 测试会连带失败——那时改为借用别的仍装有这些包的 workspace 包，或给本目录补独立 node_modules。

## 架构（双 bundle + 独立 LSP server）

```
extension host (client)  ──自定义协议 over stdio (vscode-jsonrpc)──  eslint server 子进程
   spawn(process.execPath, [dist/server.js], ELECTRON_RUN_AS_NODE=1)      └─ require(工作区/node_modules/eslint) 运行时解析
```

- `src/extension.ts` → `dist/extension.js`：client，跑在扩展宿主内，注册诊断 / code action / 命令 /
  格式化 / 保存钩子，spawn 并管理 server 子进程。
- `src/server.ts` → `dist/server.js`：独立 ESLint 语言 server，宿主经 Electron-as-node spawn，
  运行时从被检查文件所在目录 `require` 工作区的 eslint（故 esbuild 把 `eslint` 标 external，绝不打包）。

## 目录

```
src/extension.ts     client 入口（activate 注册全部能力 + spawn server）
src/server.ts        server 入口（LSP 传输 + 分发 + 按目录缓存 eslint 构造器）
src/eslintRunner.ts  纯逻辑：解析 / lint / code action / fixAll（有单测）
src/textUtils.ts     LineIndex：offset ↔ LSP position 换算（有单测）
src/protocol.ts      client ↔ server 协议（方法名 + DTO，两端共享单一定义）
src/eslintClient.ts  宿主内 spawn / 崩溃重启 / 转发文档事件
esbuild.config.mjs   打包 src → dist/{extension,server}.js（借依赖、eslint external）
scripts/pack.mjs     把 package.json + icon + dist/ + nls + README 压成 extension/** 结构的 .vsix
```

## 构建 & 打包

```bash
# 前置：packages/extension-api 已构建出 dist（pnpm build 会做），extensions/typescript 已装依赖
cd extensions-external/eslint
pnpm build      # → dist/extension.js + dist/server.js
pnpm test       # 纯逻辑单测（textUtils + eslintRunner，用假 ESLint）
pnpm typecheck
pnpm lint
pnpm package    # → universe.universe-eslint-0.1.0.vsix
```

> 本扩展脱离了 pnpm workspace，**不再进 turbo / `pnpm check` 的 CI 流水线**——上述校验需在本目录手动跑。

## 安装

命令面板运行 **扩展: 从 VSIX 安装…**（*Extensions: Install from VSIX…*），选中生成的 `.vsix`。
安装后打开一个装了 eslint 的工作区里的 `.js` / `.ts` 即生效。

## 发布到市场

```bash
# 1) 打包（见上）
cd extensions-external/eslint && pnpm build && pnpm package && cd -

# 2) 发布进本地 stage
pnpm gallery:publish -- --stage ./market-stage \
  extensions-external/eslint/universe.universe-eslint-0.1.0.vsix

# 3) 同步到服务器市场根（assets 先、registry.json 后）
pnpm gallery:upload -- --stage ./market-stage --host <IP> --user deploy \
  --dir /srv/universe-editor/gallery
```

发布运维细节见 [`scripts/gallery/README.md`](../../scripts/gallery/README.md)。
