---
name: e2e-markdown-exthost-fail-locally
description: "本机 pnpm e2e 中 markdownEditing/markdownLsp 类 @p1 因 extension host 报 \"may only execute _workbench.* commands\" 失败，是环境问题非回归"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7c1aa560-b2cb-49a0-abc1-ba9346a1f6e7
---

本机跑 `pnpm e2e` 时，`smoke.markdownEditing` / `smoke.markdownLsp` 这几个 @p1 spec 会失败，典型报错：
`extension host may only execute _workbench.* commands, not "markdown.editing.toggleBold"`（以及 LSP symbol/definition 拿不到）。

**Why:** markdown 已迁为内置插件，其命令走 extension host；本机 out 产物下 exthost 未正常放行 `markdown.editing.*` 命令 / TS LSP 未就绪。已用 git stash 在纯净 main 基线上复现——与 e2e 提速改动无关，是既存的本机/产物环境问题。全部 @p1，不阻塞 CI。

**How to apply:** 评估 e2e 结果时，把这几个 markdown @p1 失败排除在"回归"之外；要验证自己的改动是否引入回归，只看非 markdown spec 或在 stash 基线上对照。与 [[e2e-restore-specs-flaky-locally]] 同属本机环境噪声。
