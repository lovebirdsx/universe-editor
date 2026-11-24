---
name: publish-sdk-packages
description: 发布 packages/ 下的 SDK 包到 npm（@universe-editor/*）。当用户说发布 SDK / npm 发包 / 发布 extension-api、uex、create-extension，或 ext-packages:publish 出现 preflight、版本耦合、OTP、tag/push 半状态时使用。
disable-model-invocation: true
---

# 发布 SDK 包（npm）

把 `packages/` 下的 SDK 发布集合发到 `https://registry.npmjs.org`。**只发 npm，不打包编辑器**；App 发版走 `pnpm release`（见 [scripts/release/README.md](../../../scripts/release/README.md)），外部扩展发市场走 `pnpm ext:release`。

> 本 skill 只手动调用：npm 版本不可变，且脚本会 commit/tag/push main。用户明确说要发布才执行。

## 发布集合与版本耦合

清单位于 `scripts/lib/sdk-packages.mjs` 的 `SDK_PACKAGE_DIRS`（目录序 = 发布拓扑序）：

| 包 | 版本规则 |
|---|---|
| `primitives` | 独立 semver；**minor/major 必须同发 extension-api** |
| `extension-api` | **版本 = 编辑器 App 版本**；bump 先走 COMPATIBILITY |
| `extension-manifest` / `extension-packaging` / `uex` / `create-extension` / `e2e-contract` | 独立 semver |
| `e2e-harness` | minor 跟随编辑器 minor |

`SDK_VERSION_COUPLINGS`（同文件）规定源包发布时目标包必须同发，否则 preflight 拒绝：

- `extension-api` → `uex`、`create-extension`
- `uex` → `create-extension`
- `e2e-contract` → `create-extension`
- `e2e-harness` → `create-extension`

目标包内嵌源包版本常量（`uex/src/lib/sdkVersion.ts`、`create-extension/src/sdkVersions.ts`），漏发会让用户装到的 CLI/脚手架仍指向旧 API。

## 发布前检查

1. **分支与工作区**：在 `main`、与 upstream 同步；SDK 目录外的未提交改动必须先自行提交（脚本只 commit SDK 目录内的改动）。
2. **版本已 bump**：脚本不 bump。`extension-api` 的 bump 必须已完成契约测试快照 + `packages/extension-api/COMPATIBILITY.md` 变更记录，且 `src/index.ts` 的 `version` 常量一致。
3. **生成物最新**：`pnpm ext-packages:gen`（preflight 也会自动再生成）。不要手改 `sdkVersions.ts` / `sdkVersion.ts`。
4. **确认范围**：dry-run 会列出待发布包；与 npm 已有版本相同的包会被增量跳过。
5. **凭据**：`npm whoami` 能通过。推荐 npm automation token 写入用户级 `~/.npmrc`（`//registry.npmjs.org/:_authToken=...`），避免非交互 OTP；token 不进仓库。

## 标准流程

```bash
# 1. 预检（不写文件、不发布）
pnpm ext-packages:publish -- --dry-run

# 2. 真实发布（直接在终端跑，不要接 | tee | tail 等管道）
pnpm ext-packages:publish
```

脚本按序执行：preflight → `files` 检查 → build + extension-api 契约测试 → pack 内容检查 → 拓扑序 `pnpm publish` → commit `chore(release): publish ...` → 逐包打 tag → push main + tag。

限定包：`pnpm ext-packages:publish -- extension-api uex create-extension`。
其他选项：`--no-push`、`--allow-non-main`、`--registry <url>`、`--gallery-sync`（内网 tarball 同步，默认关；配置在 `.env.<mode>`，用 `--env prod`）。

## 发布后验证

```bash
git status -sb                       # main 与 origin 同步
git ls-remote --tags origin | grep -E 'extension-api@|uex@|create-extension@'
npm view @universe-editor/extension-api@<version> version --registry https://registry.npmjs.org
npm view @universe-editor/extension-api@<version> dependencies --json --registry https://registry.npmjs.org
```

依赖必须已展开：`workspace:*` → 真实版本、`workspace:^` → `^x.y.z`、`catalog:` → 真实区间。`npm` 是唯一对外契约。

## 常见失败

### 版本耦合失败

```
extension-api 将发布 0.25.0，但 uex(0.3.3) 与 npm 已发布版本相同将被跳过
```

修法：bump 目标包（`packages/uex/package.json`、`packages/create-extension/package.json`）→ `pnpm ext-packages:gen` → 重跑。只 bump 目标包，不需要改源码。

### OTP 非交互错误

```
ERR_PNPM_OTP_NON_INTERACTIVE
```

agent/CI 的 shell 不是 TTY。二选一：在普通终端交互式跑；或配置 npm automation token。

### 发布成功但 npm 查不到

npm CDN 传播有延迟（实测 1–2 分钟）。用**具体版本端点**判断，不要看 packument 的 `latest`：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/@universe-editor/uex/<version>
```

200 = 已发布；404 = 还没传播或没发成。`npm view <pkg>@<version>` 也可能命中旧缓存。

### 半状态：部分包已发、tag/push 丢失

典型原因：发布命令接了管道，子进程 stdout 被截断，脚本在 tag 前中断。**不要重发已成功版本**，重跑同一命令即可收敛：已发布的跳过、缺 tag 补打、push 补齐。

若重跑被耦合检查误拦（例如 `extension-api` 已发、`uex` 待发、`create-extension` 已发 → 脚本认为 uex 发布但 create-extension 被跳过），先手动补发缺的那个包：

```bash
cd packages/uex && pnpm publish --no-git-checks --registry https://registry.npmjs.org
```

等 npm 可查后再重跑 `pnpm ext-packages:publish`——所有包都已发布时 `toPublish` 为空，脚本只执行 git 段收敛 tag/push。

## 红线

- **npm 版本不可变**：发布前确认范围与版本；重跑只跳过，不会覆盖。
- **不要用 `pnpm publish-packages`（changeset publish）**：没有 SDK 白名单，会误发 `platform` 等内部包。
- **不要手改生成物**：`create-extension/src/sdkVersions.ts`、`uex/src/lib/sdkVersion.ts` 由 `pnpm ext-packages:gen` 生成。
- **不要把 token 写进仓库**；只放用户级 `~/.npmrc` 或环境变量。
- **脚本会 commit/tag/push main**：可能触发分支保护 bypass 提示，确认这是预期行为。
- 发布物禁止 `dist/__tests__/`；`files` 必须包含 LICENSE / README，bin 入口 `dist/cli.js` 与 templates 必须在列（preflight/pack 检查会拦）。

## 相关文档

- 权威手册：[docs/development/publishing-sdk.md](../../../docs/development/publishing-sdk.md)
- 发布外部扩展（.vsix → 市场）：[docs/development/publishing-extensions.md](../../../docs/development/publishing-extensions.md)
- 实现：[scripts/ext-packages/publish.mjs](../../../scripts/ext-packages/publish.mjs)、[scripts/ext-packages/lib.mjs](../../../scripts/ext-packages/lib.mjs)
- 版本耦合表：[scripts/lib/sdk-packages.mjs](../../../scripts/lib/sdk-packages.mjs)
