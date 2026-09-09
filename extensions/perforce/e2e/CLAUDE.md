# extensions/perforce/e2e/CLAUDE.md

Perforce 扩展的端到端测试。本目录的测试**无需真 p4d 服务器**——用 fake p4 顶替。写/改 p4 e2e spec 前必读。

## e2e：fake p4（无需真 p4d）

本机 / CI 有 `p4` client 但**无可达 p4d**，`p4 info` 发现失败 → provider 整体禁用，任何 p4 端到端链路都跑不起来。故有一套 **fake p4**：

- `p4Service._spawn` 认 **`UNIVERSE_P4_PATH`** 覆盖 `spawn('p4')`；`.mjs/.js/.cjs` 结尾则用 `process.execPath <script>` 跑（宿主里是 Electron-as-node，`sanitizeEnv` 会剥 `ELECTRON_RUN_AS_NODE`，`_spawn` 对该情况**重新补回** `=1` 否则起成 GUI Electron）。纯逻辑 `resolveP4Command()` 已导出 + `p4Service.test.ts` 守。
- `extensions/perforce/e2e/fixtures/fake-p4.mjs`：**磁盘状态** fake，depot/have/opened 存一个 JSON（`UNIVERSE_P4_FAKE_STATE`）；`reconcile -n` 真去 walk client root 比对磁盘 vs have-revision，`edit/add/delete/reconcile/revert` 真改 opened 集。依赖零、纯 Node。要覆盖新 p4 子命令就在它的 `switch(command)` 里加一个 case，注意 `-Mj`(默认) 与 `-ztag` 两种输出模式（`emit()` 已分流）。**⚠️ 协议形态必须与真服务器对齐**：`changes` case 现在按 `state.shelved[id]` 非空才 emit 裸键 `shelved: ''`（对齐实测的裸键存在性信号，见 `../docs/pitfalls.md`）——漏了它就会让「无搁置 → 零 describe」的优化在 e2e 里假绿，或让搁置组在真机上永不出现。
- `extensions/perforce/e2e/fixtures/perforceApp.ts`：cold-launch fixture（开 workspace 会重启宿主，不能用 shared 实例），`test.use({ p4Seeds:{files:[...]}, openSubdir })` 定制，`perforce` fixture 给 `clientRoot`/`openDir`/`file()`。spec 在 `extensions/perforce/e2e/specs/`（如 `perforceWorkingTreeHint.spec.ts`，改盘上文件 → 断言 Explorer 出 `RM` 徽标 → `perforce.openChange` 打开 diff）。**⚠️ Playwright option fixture 的值不能是裸数组**（会被当 tuple 只取首元素 → `seeds is not iterable`），故种子包一层对象 `P4SeedConfig{files}`。
- 改了扩展 `src/` 后 e2e 用的是 `dist/`：先 `pnpm --filter @universe-editor/perforce build`；改了 app 侧（renderer/main）先 `pnpm --filter @universe-editor/editor build`（e2e 跑 `out/`）。**⚠️ 单跑某个 spec 必须带 `UNIVERSE_E2E_NO_TAG_FILTER=1`**（在 `extensions/perforce` 目录下 `npx playwright test -c e2e/playwright.config.ts perforceWorkingTreeHint`）——默认 pass 的 grepInvert 排除 `@regression`/`@serial` 等 tag，p4 spec 基本全带 `@regression`，不带该 env 会报 "No tests found"（机制见 `packages/e2e-harness/src/playwrightConfig.ts`）。

## 两个必踩坑

1. **e2e 跑 `out/main/index.js` 预构建产物**：改 renderer 后必须 `pnpm --filter @universe-editor/editor build`，改扩展后 `pnpm --filter @universe-editor/perforce build`，否则 e2e 用旧产物。
2. **`getByText('Perforce Graph')` 子串匹配**会同时命中标题 span 和 "Perforce Graph is unavailable…" 错误文案 → strict-mode violation。断言标题用 `{ exact: true }`。

## 验证

```bash
## 改了扩展后先重建（pnpm dev 下 watcher 自动，e2e 跑 dist/out 产物）
pnpm --filter @universe-editor/perforce build
pnpm --filter @universe-editor/editor build   # e2e 前必做

# 单跑某 spec（须带 NO_TAG_FILTER）
cd extensions/perforce && UNIVERSE_E2E_NO_TAG_FILTER=1 npx playwright test -c e2e/playwright.config.ts <spec名>
```
