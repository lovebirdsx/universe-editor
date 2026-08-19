# esbuild 跨包引源码须声明 workspace 依赖

**现象**：CI 偶发（5/14 job）Build 步骤失败——`remote-server` esbuild 报 `Could not resolve "@universe-editor/extension-api"`（`dist/index.js` 不存在），同 commit 的主 CI 绿、Windows 全绿。日志特征：下游 esbuild 任务先于上游 tsgo 任务启动；被 turbo 取消的 tsgo 表现 `[ELIFECYCLE] Command failed.`（signal）或静默 0 退出。

**根因**：`remote-server/esbuild.config.mjs` 跨包打包 `../extension-host/src/bootstrap.ts`（其引 extension-api 的 dist 产物），但 remote-server 的 package.json 未声明对 extension-host/extension-api 的 workspace 依赖 → turbo 依赖图缺边 → 上游 miss（真实编译需 1-2s）时下游并发启动，esbuild 在 tsgo 写完 dist 前读取。上游 hit 时（缓存 replay 恢复 dist 早于下游启动）无竞态，故只在「改动 extension-api 且 restore 到旧 turbo 缓存」时暴露。

**How to apply**：任何构建脚本（esbuild/vite/tsc）跨包引用其他 workspace 包的 src 或 dist 产物时，必须在 package.json 的 dependencies/devDependencies 声明 `workspace:*` 依赖（devDependencies 也会进 turbo 依赖图）——同时修复调度竞态与 hash 感知（依赖包改动时下游缓存失效）。修后可用 `turbo run build --filter=<包> --dry` 确认依赖边存在。

**Why**：turbo 的 ^build 只认 package.json 声明的直接 workspace 依赖，裸 `../other-pkg/src` 路径引用对它是隐形的；竞态是时序敏感的，本地几乎必赢、CI 并发才暴露。
