---
name: e2e-regression-tag
description: e2e 用例级 @regression 分级 tag 约定——把 bug 守护用例从本地主门禁剥离、CI 仍全量并行覆盖
metadata: 
  node_type: memory
  type: project
  originSessionId: 6cb0dbb7-df77-418a-a558-12f8ad89894b
---

引入了 e2e **用例级 `@regression` 分级 tag**,用于把「只为守护某个已修复 bug 的回归用例」从日常本地 `pnpm e2e` 主趟剥离,同时 CI 仍全量并行覆盖阻塞门禁。动机:重 spec(如 `smoke.markdownPreview.spec.ts` 25→6 核心)大量 `test.slow()` 拖慢日常 e2e。

**机制**(靠 Playwright `--grep`/`--grep-invert` 按 "describe title › test title" 完整字符串匹配,与既有 `@serial`/`@flaky` 同理):
- tag 打在**单个 `test('... @regression')` 标题末尾**,不是 `describe`。一个 spec 里核心主路径冒烟留主趟,只把 bug 守护用例打 `@regression`。
- 与 `@p1`(在 describe)可共存:主趟 invert 排除、回归趟 grep 命中,互不冲突。

**判定何时打 `@regression`**:用例只为守护已修复 bug、非「命令主路径/协议/导航入口」的冒烟。信号:注释以 `Regression:` 开头 / 描述 "before the fix"、"used to" / 用例名讲某个具体焦点·滚动·竞态·边界修复。核心冒烟(打开/切换/基本渲染/导航入口各留一个)不打。

**落点(4 处)**:
- `apps/editor/package.json`:主趟 `--grep-invert "@visual|@serial|@flaky|@perf|@regression"`;新增 `e2e:regression` 脚本(`--grep @regression`)本地手动全跑。
- `.github/workflows/ci.yml`:Linux/Windows 主趟同步排除 `@regression`;各新增一趟 `Run E2E regression`(`--grep @regression --shard=x/2`,并行、阻塞门禁,与主趟同机制不加 `--workers=1`/`continue-on-error`)。
- spec 文件:回归用例标题追加 ` @regression`。
- `apps/editor/e2e/RUNBOOK.md`:分类表新增 `@regression` 行 + 打标约定说明。

**验证方式**(纯 tag/编排改动够用,不必实跑):`pnpm exec playwright test -c e2e/playwright.config.ts --grep-invert "...|@regression" --list` 与 `--grep @regression --list` 数用例核对划分,再 eslint 改动 spec。

**通用性**:后续任何重 spec(agents 系列、outline 等)给回归用例加 ` @regression` 即可复用,无需再动脚本/CI/配置。首个落地 = markdown preview(见 [[markdown-preview-vimium-link-hints]] 等相关功能)。分级全景见 RUNBOOK:`@p0`/`@p1`/`@regression`/`@serial`/`@flaky`/`@perf`/`@visual`。
