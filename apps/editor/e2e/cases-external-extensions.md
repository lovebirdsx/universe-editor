# 本文从 e2e/CLAUDE.md 拆出，范围是外部（marketplace）扩展的 e2e 套路——加载机制、Windows junction 坑、bare-import 解析方案、CI affected 与命令矩阵。

`extensions-external/*`（eslint / pdf / excel-diff）是**独立发布的 marketplace 扩展，不在 pnpm/turbo workspace 内**——不能 `workspace:*` 引用 harness，turbo 也看不见它们。对齐 VSCode `--extensionDevelopmentPath`：**从磁盘目录直接加载 unpacked 扩展跑 e2e，绝不打 vsix、不重启 host**。

## 加载机制

内核认 `UNIVERSE_USER_EXTENSIONS_DIR` env（`apps/editor/src/main/services/extensionHost/userExtensionsDir.ts`）。fixture 建隔离临时目录，把扩展根 junction 进去，启动时经 `scanExtensions` 直接读 `package.json`+`dist/` 激活。用户扩展（`builtin:false`）**不受 allowlist 门控**，始终激活。

- **Windows junction 是 symlink 不是 directory**：`scanExtensions` / `hasUserExtensions` 必须 `stat` 跟随 symlink dir（`entry.isSymbolicLink() && isDir(...)`），否则跳过 junction 进来的扩展——这是内核真修复，也惠及真·dev-link 扩展。
- **解析难题**：外部扩展 bare-import 解析不到 harness / `@playwright/test`（不在 workspace）。解法（`scripts/e2e/run-external-e2e.mjs`）：① config **相对 import** `../../../packages/e2e-harness/dist/index.js`；② 从 `packages/e2e-harness/package.json` 解析出**唯一一份** `@playwright/test/cli` 物理路径来 spawn（两份 playwright 会崩）。
- **tag env seam 复用**：runner 把 `--regression`/`--no-tag-filter` 映射到 `UNIVERSE_E2E_*` 环境变量（同 core，单一事实源仍是 `grepOptions()`）。
- **诊断探针**：`getMarkers(uri, owner)`（读 Monaco marker，eslint owner=`'eslint'`）、`getOutputChannelContent(name)`（读 OutputChannel，诊断扩展内部报错的利器）。
- **flat config 坑**（eslint suite）：ESLint 9 flat config 用 `export default` 须 `eslint.config.mjs`（或 `"type":"module"`）；fixture 源文件若用 ESM `export` 须在 config 给 `languageOptions.sourceType`，否则纯脚本语法即可。

## 命令矩阵

```bash
pnpm e2e:external    # 建 editor 一次 + 串行跑 eslint/pdf/excel-diff（run-external-e2e-all.mjs）
pnpm e2ea:external   # 同上，含 @regression
npm --prefix extensions-external/<ext> run e2e   # 单个外部 suite
```

## CI affected 靠 git path diff

（turbo 看不见外部扩展）`affected-e2e-matrix.mjs` 的 `computeExternalMatrix`——改某 suite 目录只跑它；改共享基建（editor / e2e-harness / e2e-contract / extension-host / extension-api / scripts/e2e）扇出全部。输出 `external` / `has-external`，喂 `e2e-external` matrix job。

Windows spawn `.cmd` 需 `shell: true`（CVE-2024-27980 后 Node 拒绝裸 spawn `npm.cmd`）——见 `run-external-e2e-all.mjs` 的 `runNpm`。
