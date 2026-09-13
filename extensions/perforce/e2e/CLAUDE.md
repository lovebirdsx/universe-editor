# extensions/perforce/e2e/CLAUDE.md

Perforce 扩展的端到端测试。本目录的测试**无需真 p4d 服务器**——用 fake p4 顶替。写/改 p4 e2e spec 前必读。

## e2e：fake p4（无需真 p4d）

本机 / CI 有 `p4` client 但**无可达 p4d**，`p4 info` 发现失败 → provider 整体禁用，任何 p4 端到端链路都跑不起来。故有一套 **fake p4**：

- `p4Service._spawn` 认 **`UNIVERSE_P4_PATH`** 覆盖 `spawn('p4')`；`.mjs/.js/.cjs` 结尾则用 `process.execPath <script>` 跑（宿主里是 Electron-as-node，`sanitizeEnv` 会剥 `ELECTRON_RUN_AS_NODE`，`_spawn` 对该情况**重新补回** `=1` 否则起成 GUI Electron）。纯逻辑 `resolveP4Command()` 已导出 + `p4Service.test.ts` 守。
- `extensions/perforce/e2e/fixtures/fake-p4.mjs`：**磁盘状态** fake，depot/have/opened 存一个 JSON（`UNIVERSE_P4_FAKE_STATE`）；`reconcile -n` 真去 walk client root 比对磁盘 vs have-revision，`edit/add/delete/reconcile/revert` 真改 opened 集。依赖零、纯 Node。要覆盖新 p4 子命令就在它的 `switch(command)` 里加一个 case，注意 `-Mj`(默认) 与 `-ztag` 两种输出模式（`emit()` 已分流）。**⚠️ 协议形态必须与真服务器对齐**：`changes` case 现在按 `state.shelved[id]` 非空才 emit 裸键 `shelved: ''`（对齐实测的裸键存在性信号，见 `../docs/pitfalls.md`）——漏了它就会让「无搁置 → 零 describe」的优化在 e2e 里假绿，或让搁置组在真机上永不出现。同理 `changes <spec>#have`（图谱的同步点查询）走 have 列表语义：`#have` 后缀必须在**按 filespec 过滤之前**剥掉，再判该 CL 是否已同步——顺序反了会一个文件都匹配不到，查询永远答「什么都没同步」。**而且 have 判定必须与 scope 判定落在同一个文件上**（`changeInHaveList(state, id, scopes)` 内部先过 `openedInScope`）：`#have` 收窄的是那一条 filespec 本身，所以「CL 碰过 scope 外的某个已同步文件」不算答案。两半拆成两个全局 filter 会**高报**——真机上 scope 外的文件根本不在这条 filespec 里（`perforceGraphHave.spec.ts` 第三条 journey：文件夹 scope 答 4521、整仓库 scope 答 4522，就是钉这条的）。**同一处还要处理 `<spec>@<cl>`、`<spec>#head` 与 `<spec>#<rev>`**：图谱 sync 完之后会回读落点（`p4 changes -s submitted -m 1 <scope>@4522`），fake 不认这个后缀的话，每个刚 pull 完的 scope 都会记下一个错的同步点。四种后缀一律**先剥后过滤**（`#have` `#head` `@<cl>` `#<rev>`），但**剥掉之后的含义分两档**：`#have`/`#head` 只说明「问的是哪个修订」，答案仍由 scope 过滤给出；`@<cl>` 与 `#<rev>` 是**修订范围**——`@` 收窄到 `id <= 该 CL`（再 scope 过滤、最后 `-m 1`），而 `#<rev>` 根本不是范围过滤而是「**产生修订 N 的那个 CL**」（真机上 `p4 changes f#4` 就这一个含义），故它答的是「某条被 scope 命中的文件里 `submitted[id][file].rev === N` 的 CL」，且**没有文件集的种子 CL 直接排除**（无从证明它就是那个 CL）。**`UNIVERSE_P4_FAKE_READBACK_MS`** 把带修订后缀的 `changes`（`@<cl>` / `#head` / `#<rev>`）拖住 N 毫秒：回读的真实成本随 scope 宽度涨到 13–27s，而扩展给快档只有 5s，fake 秒答就永远走不到「迟到落账」那条路（`perforceGraphHave.spec.ts` 最后一条 journey 靠它，`#have` 不受影响）。**`UNIVERSE_P4_FAKE_READBACK_LOG`** 指向一个文件，把每一次这类回读的 argv 追加上去（在 sleep **之前**写，所以断言不必等延迟过完）：它是「**零回读**」唯一能验红的证据——fake 秒答时，「徽章动了」在「问了再无视答案」的实现下同样成立，只有日志为空能区分。三条 journey 靠它、且**两个方向都要**：图谱行 get（未 scoped、地球关）要求日志**为空**，对话框挑窄选区与整仓库列表（地球开）两条要求日志**非空**——后者尤其重要，因为 wholeRepo 那次 get 的徽章两条路都会落在同一个号上，日志是唯一的判别信号（把 `directSyncPoint` 注掉 → 第一条红；去掉 wholeRepo 的拒绝 → 后一条红）。
- `extensions/perforce/e2e/fixtures/perforceApp.ts`：cold-launch fixture（开 workspace 会重启宿主，不能用 shared 实例），`test.use({ p4Seeds:{files:[...]}, openSubdir })` 定制，`perforce` fixture 给 `clientRoot`/`openDir`/`file()`。spec 在 `extensions/perforce/e2e/specs/`（如 `perforceWorkingTreeHint.spec.ts`，改盘上文件 → 断言 Explorer 出 `RM` 徽标 → `perforce.openChange` 打开 diff）。**⚠️ Playwright option fixture 的值不能是裸数组**（会被当 tuple 只取首元素 → `seeds is not iterable`），故种子包一层对象 `P4SeedConfig{files}`。
- 改了扩展 `src/` 后 e2e 用的是 `dist/`：先 `pnpm --filter @universe-editor/perforce build`；改了 app 侧（renderer/main）先 `pnpm --filter @universe-editor/editor build`（e2e 跑 `out/`）。**⚠️ 单跑某个 spec 必须带 `UNIVERSE_E2E_NO_TAG_FILTER=1`**（在 `extensions/perforce` 目录下 `npx playwright test -c e2e/playwright.config.ts perforceWorkingTreeHint`）——默认 pass 的 grepInvert 排除 `@regression`/`@serial` 等 tag，p4 spec 基本全带 `@regression`，不带该 env 会报 "No tests found"（机制见 `packages/e2e-harness/src/playwrightConfig.ts`）。

## 必踩坑

1. **e2e 跑 `out/main/index.js` 预构建产物**：改 renderer 后必须 `pnpm --filter @universe-editor/editor build`，改扩展后 `pnpm --filter @universe-editor/perforce build`，否则 e2e 用旧产物。
2. **`getByText('Perforce Graph')` 子串匹配**会同时命中标题 span 和 "Perforce Graph is unavailable…" 错误文案 → strict-mode violation。断言标题用 `{ exact: true }`。
3. **后段断言别钉只在前段成立的时序前提**：`perforceSyncIoRate.spec.ts` 靠 `UNIVERSE_P4_FAKE_SYNC_START_MS` 造静默窗口，若后段断言写成 `Syncing 0 · <非零速率>`（`done` 必须仍是 0），慢机器一旦把前面几步拖过窗口，p4 开始打印 → 正则**永不可能**命中，失败信息还指向错误的方向。后段只断言它真正要守的性质（这里＝速率非零），静默窗口留足预算（`setTimeout` ≥ 各步超时之和）。
4. **「瞬时状态」断言之后立刻点击 = 在跟一次在飞的 load 抢时序**：`perforceGraphHave.spec.ts` 里切 scope 后 `toHaveText('#? (click to query)')` 会在**新 scope 的 list 还没落地时**就成立，紧接着的点击就撞上了那次 load 的收尾工作（`load()` 落地后自己也要读一次同步点）。这类「先断言中间态、再点击」的写法要么改成断言一个**稳态**信号（列出行、或用例真正关心且此时已定的东西），要么就得接受它其实是在测那条竞态。（上面这次撞出来的确实是产品 bug——renderer 会丢掉用户按下的查询答案——但发现它的成本是「三次 e2e 重跑 + 一轮误判」。）
5. **同步账本按 userData 隔离**：`GraphSyncLedger` 落在 `<globalStoragePath>/graphSyncLedger.json`，而 fixture 每个用例 `mkTempDir` 一个新 userData，所以**跨 journey 不会串账**（每个用例都从「未知名」开始）。写新用例时不必手工清账本；反过来，**同一个用例内**连续两次 get 会累积两条记录，断言前先想清楚哪条该赢（按 `at` 最新，见 `../docs/graph.md`）。

## 验证

```bash
## 改了扩展后先重建（pnpm dev 下 watcher 自动，e2e 跑 dist/out 产物）
pnpm --filter @universe-editor/perforce build
pnpm --filter @universe-editor/editor build   # e2e 前必做

# 单跑某 spec（须带 NO_TAG_FILTER）
cd extensions/perforce && UNIVERSE_E2E_NO_TAG_FILTER=1 npx playwright test -c e2e/playwright.config.ts <spec名>
```
