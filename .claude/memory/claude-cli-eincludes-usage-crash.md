---
name: claude-cli-eincludes-usage-crash
description: "ACP 报 \"Internal error: undefined is not an object (evaluating 'e.includes')\" 的根因=claude CLI usage 记账对上游 usage 条目缺 model 无守卫;编辑器侧已归类 transient 自动续跑"
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-19T05:07:53.770Z
---

**现象**:claude-code ACP 会话 turn 尾报 `Internal error: undefined is not an object (evaluating 'e.includes')`,几分钟到几十分钟的 turn 被整体作废(2026-08 现场多次)。

**根因链**(已 100% 实锤 + 本地复现):claude CLI 二进制(bun/JSC 编译,多个近期版本均未修,上游 issue anthropics/claude-code#74059 stale)的 usage 记账路径:当上游返回的 usage 条目**缺 `model` 字段**时,记账处对 `model` 字段做 `includes` 判定抛 TypeError(CLI 无 undefined 守卫)。崩溃点在 message_stop 记账时,**turn 的工作已全部落盘**,CLI catch 后以 is_error result 结束 turn,fork 原样转发为 internalError(errorKind='unknown' 或缺失)。

**Why**:CLI minified 代码无 undefined 守卫;上游缺 `model` 条目 + CLI bug 组合,编辑器/fork 都不在数据路径上,改不了传输内容。

**How to apply**:
- 编辑器侧已修(acpErrorClassify.ts 的 `CLI_USAGE_ACCOUNTING_CRASH_TEXT`):按 message 文本识别(JSC/V8 两种措辞、任意 minified 标识符),归类 `transient` + kind `cli_usage_accounting_crash` → _sendWithRecovery 自动发"继续"续跑,不再 fatal。
- 最小复现:mock Anthropic SSE 端点(usage 带缺 `model` 的 advisor_message 条目)即复现一字不差的错误;注意须用 `CLAUDE_CONFIG_DIR` 隔离配置,`--settings '{}'` 屏蔽不了 `~/.claude/settings.json` 里的 env。
