---
name: claude-cli-eincludes-usage-crash
description: "ACP 报 \"Internal error: undefined is not an object (evaluating 'e.includes')\" 的根因=claude CLI usage 记账对网关 advisor_message 缺 model 无守卫;编辑器侧已归类 transient 自动续跑"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4369585c-3895-40f8-a51f-0e7406b1d36c
  modified: 2026-08-19T05:07:53.770Z
---

**现象**:claude-code ACP 会话 turn 尾报 `Internal error: undefined is not an object (evaluating 'e.includes')`,几分钟到几十分钟的 turn 被整体作废(2026-08 现场 7 次)。

**根因链**(已 100% 实锤 + 本地复现):claude CLI 二进制(bun/JSC 编译,多个近期版本均未修,上游 issue anthropics/claude-code#74059 stale)的 usage 记账路径:当第三方网关(acme `ai-gateway.example.com`)返回的 advisor_message 条目**缺 `model` 字段**时,记账处对 `model` 字段做 `includes` 判定抛 TypeError(CLI 无 undefined 守卫)。崩溃点在 message_stop 记账时,**turn 的工作已全部落盘**,CLI catch 后以 is_error result 结束 turn,fork 原样转发为 internalError(errorKind='unknown' 或缺失)。主链正常响应带 `iterations: []`(空数组安全),只有网关偶发塞非空+缺 model 条目才触发。

**Why**:CLI minified 代码无 undefined 守卫;网关数据缺陷+CLI bug 组合,编辑器/fork 都不在数据路径上,改不了传输内容。

**How to apply**:
- 编辑器侧已修(acpErrorClassify.ts 的 `CLI_USAGE_ACCOUNTING_CRASH_TEXT`):按 message 文本识别(JSC/V8 两种措辞、任意 minified 标识符),归类 `transient` + kind `cli_usage_accounting_crash` → _sendWithRecovery 自动发"继续"续跑,不再 fatal。
- 最小复现:mock Anthropic SSE 端点,message_delta.usage 带 `iterations:[{type:"advisor_message",input_tokens:3,...}]`(刻意缺 model),`CLAUDE_CONFIG_DIR=<干净目录> ANTHROPIC_BASE_URL=<mock> claude -p "hi" --output-format stream-json` 即复现一字不差的错误。注意 `--settings '{}'` 屏蔽不了 `~/.claude/settings.json` 的 env,须用 `CLAUDE_CONFIG_DIR`。
- 治本在网关侧:acme 网关应给 advisor_message 条目补 model 或整个剥掉 iterations 字段。
