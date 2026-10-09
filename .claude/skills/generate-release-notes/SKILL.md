---
name: generate-release-notes
description: 为指定版本生成面向用户的发布说明（更新说明）。当用户说生成发布说明 / release notes / 版本更新说明 / 某版本更新了什么 / 整理更新日志时使用。
disable-model-invocation: true
---

# 生成发布说明

把两个 tag 之间的提交整理成**面向使用者**（策划 / 美术等，不是开发者）的更新说明。

> 第一原则：**读者是使用者，不是提交者**。每条都要能回答「用户会看到什么不同」；答不上来的（测试、CI、重构、依赖指针）一律不写。

> 与 `scripts/release/changelog.mjs` 自动生成的 `apps/editor/resources/release-notes.json` 的区别：那份只收带 `!` 的提交、沿用提交原话；本流程产出更全、更口语化。

## 1. 定范围

```bash
git tag --sort=-creatordate | head -5      # 找相邻 tag；未发布版本用 v<latest>..HEAD
git log --oneline v0.14.8..v0.14.9         # 提交清单
```

## 2. 筛选

**强信号：改动了 `docs/user/` 的提交 = 用户可见功能**（仓库硬约定：改用户可见功能必须同步用户文档）：

```bash
git log --no-merges --pretty=format:'%h %s' <range> -- docs/user/
```

- **保留**：feat / fix / perf 中用户能感知的（功能、界面、快捷键、提示文案、崩溃、卡顿）
- **排除**：test / chore / docs / refactor、纯内部机制、开发者环境（WSL / e2e / CI）、依赖指针更新
- 拿不准时读提交 body 或 `git show --stat <hash>` 判断影响面

## 3. 表述

- 按模块分组（AI 助手 / Perforce / 编辑器 / 性能 / 其他），组内分「新功能」「问题修复」
- 每条一行，说清用户看到的变化；**翻译掉内部黑话**（side task → 侧边任务、plan 卡片 → 计划卡片）
- 同一功能的多个提交合并为一条（如侧边任务的三处修复）；量级参考：一个版本 20–30 条以内
- 破坏性行为变化（默认值改了、旧行为不再支持）必须单独点出

## 4. 落点

- 默认在对话中输出，不落盘
- 写进 `apps/editor/resources/release-notes.json`：items 是纯文本字符串（无 markdown），替换目标版本的 `groups`；**须提醒该文件是生成产物**——无参数全量重建会覆盖手写内容，增量发版（`--version X.Y.Z`）不会
