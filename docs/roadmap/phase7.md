## 阶段七：工程质量（集成测试 + bench + 主进程 HMR + visual baseline）

### 目标

建工程质量基建，让前 6 阶段成果有可持续保障。

### 关键文件

**新建 `apps/editor/integration/`**（与 `e2e/` 平级；独立 vitest project，node 环境，import 真实 platform + 真实 main services，**禁止 spawn Electron**，CLAUDE.md 明令）：
- `apps/editor/integration/vitest.config.ts`
- `apps/editor/integration/fixtures/createTestWorkbench.ts` —— 组合 InstantiationService + 所有 services + ContributionService 的工厂；返回 `{ services, dispose() }`
- `apps/editor/integration/fixtures/mockElectron.ts` —— 手写 mock `app.getPath` / `dialog.show*` / `BrowserWindow` / `ipcMain`（依赖最少，不引 vitest-mock-extended）
- `apps/editor/integration/scenarios/workspace.openClose.test.ts` —— IWorkspaceService → IUserDataFilesService → ConfigurationService → ExplorerTreeService 串通
- `apps/editor/integration/scenarios/settings.userToWorkspaceLayering.test.ts` —— 三层配置合并跨 service 验证
- `apps/editor/integration/scenarios/editor.openCloseRestore.test.ts` —— EditorGroupsService + EditorRegistry + storage restore 串通
- `apps/editor/integration/scenarios/notification.errorChain.test.ts` —— onUnexpectedError → INotificationService → status badge 串通
- `apps/editor/integration/scenarios/editorResolver.routing.test.ts` —— Explorer.openFile → EditorResolverService → EditorGroupsService 串通

**新建 `apps/editor/bench/`**：
- `apps/editor/bench/vitest.bench.config.ts`
- `apps/editor/bench/largeFile.bench.ts` —— 1MB / 10MB / 50MB 文本文件 readFileText + monaco model 加载
- `apps/editor/bench/largeDirectory.bench.ts` —— 1k / 10k 节点 ExplorerTreeService 展开 + VirtualList 渲染
- `apps/editor/bench/editorGroups.bench.ts` —— split 到 6 group、各 5 editor 的 layout 计算
- `apps/editor/bench/commandExecution.bench.ts` —— commandService.executeCommand 单次开销（含 telemetry）
- `apps/editor/bench/baselines/<commit>.json` —— 基准数字

**新建 visual regression**：
- `apps/editor/e2e/specs/visual.workbench.spec.ts` —— 6 个稳定状态截屏（空 workspace / 打开 welcome / 打开文件 / settings editor / quickInput 展开 / 命令面板展开）
- `apps/editor/e2e/baselines/` —— 基准 PNG（**仅 Linux CI** 跑，字体渲染 OS 差异会大量误报）
- `apps/editor/scripts/visual-regression/diff.ts` —— pixelmatch 对比脚本

**修改**：
- `apps/editor/electron.vite.config.ts` —— 开 main HMR：`build.watch: true` + 自定义 plugin 在 main 重建时 `app.relaunch() + app.quit()`；preload 改动 `webContents.reload()`（复用 IHostService）
- `apps/editor/package.json` —— scripts 加 `test:integration` / `bench` / `test:visual` / `visual:update`
- `.github/workflows/ci.yml` —— integration 在 unit 后跑（同 matrix）；visual regression 在 e2e 后跑（仅 linux，artifact 存 diff）；bench 不阻塞，记录数字到 PR comment
- 根 `CLAUDE.md` 的"常用命令"段加 `pnpm test:integration` / `pnpm bench`

### 设计要点

1. **集成测试位置 `apps/editor/integration/`** —— 不进 `src/**/__tests__/`。原因：integration 用真实 main services（需 mock electron 的 app / dialog / BrowserWindow），跟 unit 隔离配置更清。**禁止 spawn Electron**（CLAUDE.md 套路 F 明令）；只 import 真实 service class。和 e2e 区分：e2e 跑构建产物 + 真 BrowserWindow，integration 跑 ts 源 + mock electron。
2. **Bench 用 vitest 内置 `bench()`** 而非 benchmark.js，CI 可顺便跑（不阻塞）。结果 commit 到 `apps/editor/bench/baselines/<commit>.json`，PR diff 显示回归 / 提升。
3. **Visual regression 用 Playwright screenshot + pixelmatch**：不引第三方服务（Percy / Chromatic）。基准图 commit 到仓库，diff 在 PR artifact 看。**仅 Linux CI** 跑，字体渲染跨 OS 误报。
4. **Renderer→Main HMR**：electron-vite 5 支持 main watch，但 main 改动还是要重启 BrowserWindow（不能真 HMR）。加自定义 plugin 在 main 重建时 `app.relaunch() + app.quit()` 即可。preload 改动 `webContents.reload()`。
5. **集成测试 mock electron 手写**：依赖最少。需 mock 的接口面很小（app.getPath / dialog.show* / BrowserWindow / ipcMain）。
6. **不引入 Storybook** —— visual regression 已覆盖组件视觉回归；Storybook 维护成本高，留给将来组件库化时。

### 验收

- 集成 scenarios：≥10 个
- Bench baseline：4 个 bench 文件 baseline 提交到仓库
- Visual baseline：6 个 stable state 提交
- HMR：本地 `pnpm dev` 改 main service 1 行代码到窗口恢复 < 2s（验收脚本：watch + touch + 计时）
- CI 时间增量：integration < 30s、bench < 60s、visual < 90s；整体 CI 增量 < 3 分钟

### 工作量

**L（2 周）**。可拆 2 PR：(a) integration + main HMR（M, 4 天）→ (b) bench + visual（M+, 6 天）

---
