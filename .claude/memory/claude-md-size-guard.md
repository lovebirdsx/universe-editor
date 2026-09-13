---
name: claude-md-size-guard
description: CLAUDE.md 15KB 硬预算守护已接入 pnpm check；EXEMPT 已清空全仓生效
metadata:
  type: project
---

`scripts/check-claude-md-size.mjs --check`（`pnpm claude-md:check`）强制全仓 CLAUDE.md ≤ 15,000 bytes，已串进 `pnpm check`。子文档 `cases-*.md` 不受限（不进热路径）。

**Why:** CLAUDE.md 膨胀稀释「路由+红线」信号；瘦身手法=拆子文档/删代码自证/去重/删历史编年，红线留一句话结论。

**How to apply:** 写 CLAUDE.md 时自觉控长；`EXEMPT` 集合当前为空（perforce 两份已达标并移出豁免），未来有临时豁免需求时在脚本里加条目并注明原因。

**各文件都贴着上限**：`apps/editor/CLAUDE.md` 常年 14.9KB+（2026-09 实测 14992/15000），nested 文档也多在 14.7–15.0KB。**往这些文件加一行几乎必然先撑破预算**，所以加知识前先想好"这条从哪腾位置"——正解是把它推进该目录的 nested CLAUDE.md（新开一份也行，最小的一份才 1.1KB）+ 父文件留一行指针，而不是删别人写的事实。改完必须跑 `node scripts/check-claude-md-size.mjs --check`（`pnpm check` 里也有，但它在 turbo 前几步，容易被后面的输出淹掉而漏看）。
