# 调试扩展

> 开发宿主、断点、日志与迭代循环的完整说明。以扩展 API 0.7.1 / uex 0.1.0 为准；基础流程（脚手架 → watch → `uex dev`）见 [快速上手](./getting-started.md)，本篇展开调试细节。

## 开发宿主是什么

`uex dev` 拉起的 Universe Editor 实例称为**扩展开发宿主**（Extension Development Host）。它与日常实例的区别：

- 窗口标题带 **[扩展开发宿主]** 前缀，状态栏显示加载了几个开发中的扩展；
- 使用独立的用户数据目录（`<用户数据>/Universe Editor - ExtDev`），设置、已装扩展、密钥都与日常实例隔离，不会互相污染；`--user-data-dir=<dir>` 可覆盖；
- **跳过单实例锁**，可以和你日常打开的编辑器并存；
- 从源码目录加载的开发中扩展**豁免 Workspace Trust 门控**，在工作区未授信时也会直接激活（也豁免禁用态）。

`uex dev` 等价于手写：

```bash
universe-editor --extension-development-path=<当前目录> --inspect-extensions=<port>
```

`--extension-development-path` 的每个值是**一个扩展的根目录**（含 `package.json` 的那一层），不是装多个扩展的容器目录。对应环境变量为 `UNIVERSE_EXTENSION_DEV_PATH`（多个根用系统的 `path.delimiter` 拼接）与 `UNIVERSE_INSPECT_EXTENSIONS`。

## 断点调试主流程

断点命中在**扩展宿主进程**里——一个独立的 Node 进程，既不是编辑器主进程，也不是渲染进程。三步：

**① 保持 watch 运行**（在扩展根目录）：

```bash
npm run watch
```

**② 带调试端口拉起开发宿主**（另开一个终端，同样在扩展根目录）：

```bash
npx uex dev --inspect=9229
```

`uex dev` 要求当前目录含 `package.json`；传了 `--inspect` 时它会在输出里打印 `attach your debugger to 127.0.0.1:9229`。调试端口只绑定回环地址（127.0.0.1），合法范围 1–65535。编辑器定位失败时用 `--editor-path=<exe>` 或 `UNIVERSE_EDITOR_PATH` 指定安装位置。

**③ 在 VSCode 里 attach**：脚手架生成的 `.vscode/launch.json` 已备好配置，打开扩展项目目录按 `F5` 即可：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Attach to Extension Host",
      "type": "node", // Node 调试器（扩展宿主是普通 Node 进程）
      "request": "attach", // 附加到已运行的进程，不是新启动
      "address": "127.0.0.1",
      "port": 9229, // 与 uex dev --inspect=<port> 一致
      "outFiles": ["${workspaceFolder}/dist/**/*.js"], // 编译产物位置，sourcemap 解析依据
      "sourceMaps": true,
      "skipFiles": ["<node_internals>/**"], // 单步时跳过 Node 内部实现
    },
  ]
}
```

然后在开发宿主里触发你的扩展（运行命令 / 打开对应文件，取决于 `activationEvents`），断点直接落在 `src/extension.ts` 的 TypeScript 源码上。

**sourcemap 要求**：脚手架的 esbuild 模板已配置 inline sourcemap 并内嵌 `sourcesContent`，断点映射不需要额外文件。如果你自配构建链，必须保留这两条——缺了 `sourcesContent` 时调试器无法显示 TS 源码，断点会变灰。

## 激活前断住

普通 `--inspect` 要等 attach 之后才会停，来不及断在 `activate()` 早期。要在任何用户代码执行前断住，用 brk 变体。`uex dev` 暂不支持 brk 旗标，需手写 CLI：

```bash
universe-editor --extension-development-path=<dir> --inspect-brk-extensions=9229
```

扩展宿主进程启动后会立刻停在入口，等你 attach（VSCode 用同一个 launch 配置即可）并继续。`--inspect-brk-extensions` 与 `--inspect-extensions` 同时给时 **brk 胜出**（等价环境变量：`UNIVERSE_INSPECT_BRK_EXTENSIONS`）。

## 多扩展同调

`--extension-development-path` 可重复传入多个扩展根，一次同调多个扩展：

```bash
universe-editor --extension-development-path=<ext-a> --extension-development-path=<ext-b> --inspect-extensions=9229
```

`uex dev` 一次只加载当前目录这一个扩展；多扩展场景走手写 CLI（或把 `UNIVERSE_EXTENSION_DEV_PATH` 用 `path.delimiter` 拼接）。

## 迭代循环

```
改 src/extension.ts → watch 自动重编 → 命令面板「重启扩展宿主」→ 重新验证
```

「重启扩展宿主」（命令面板搜索 *Restart Extension Host*，命令 id `workbench.action.restartExtensionHost`）会停掉扩展宿主进程并重启，从磁盘重新加载新产物——不需要重开编辑器窗口。

注意：**重启后调试器会断开**（原进程已退出），需要重新 attach。用 brk 调激活路径时，重启后同样要等新进程起来再 attach。

## 日志

- **扩展里用 `createOutputChannel` 写 Output 通道**（推荐）：用户在「输出」面板里能看到，也是给用户排障的正式途径。
- `console.*` 走扩展宿主进程的日志，不进 Output 面板；用户不可见，适合临时排查。
- 激活失败只记日志、不拖垮宿主：一个扩展抛异常不影响其他扩展。扩展「没反应」时**先翻日志**，多半能在宿主日志里找到激活失败的堆栈。

## 常见问题

**断点是灰的（未验证）**
sourcemap 缺失或产物过期。确认 `npm run watch` 在跑、`dist/extension.js` 是新的；自配构建链检查是否保留了 inline sourcemap 与 `sourcesContent`。

**attach 连不上**
端口被占或开发宿主根本没起来。`uex dev` 启动时会打印 `attach your debugger to 127.0.0.1:<port>`，先确认这行输出与 launch.json 的 `port` 一致；端口被占就换一个（`--inspect=<新端口>` 与 launch.json 同步改）。

**改了代码不生效**
忘了重启扩展宿主。watch 只负责重编产物，宿主进程里跑的还是旧代码——命令面板执行「重启扩展宿主」再验证。

**扩展没激活**
两类典型原因：`activationEvents` 没触发（懒加载——先做出触发动作，如运行声明的命令）；或 `engines.universe` 区间不满足当前宿主的 API 版本被扫描阶段拒载。两者都只看日志即可分辨，宿主扫描被拒的扩展会记日志且不影响其他扩展。

## 相关阅读

- [快速上手](./getting-started.md) — 从脚手架到发布的完整流程，本篇的第①②步在那里有上下文
- [扩展的结构](./extension-anatomy.md) — `package.json` 字段全集（`activationEvents` / `engines.universe` / `files`）
