/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  deriveToolCallDisplay — normalizes a tool call into a user-facing title plus
 *  an optional secondary detail line.
 *
 *  The agent forks map most tools to a friendly title already (`Edit foo.ts`,
 *  `Fetch <url>`, a Task's description, …). The exception is command-style
 *  tools whose title *is* the raw command line (`execute`) or a raw argument
 *  fragment (`search`). For those we promote the human-readable intent to the
 *  title and demote the raw command to a subtitle rendered as a muted code line.
 *
 *  Pure function over {@link AcpToolCall} so it can be unit-tested without React.
 *--------------------------------------------------------------------------------------------*/

import type { AcpToolCall } from '../../services/acp/session/acpSessionService.js'
import { localize } from '@universe-editor/platform'

export interface ToolCallDisplay {
  /** Human-readable title shown as the card header. */
  readonly title: string
  /** Optional raw detail (command line / argument) demoted below the title. */
  readonly subtitle?: string
}

function readStringField(raw: unknown, key: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * `execute` tools (Bash / codex command) title-ify to the raw command line in
 * the fork. Prefer the agent-provided `description` as the title and keep the
 * command as a subtitle; fall back to the command as the title when no
 * description exists (e.g. codex), avoiding a redundant subtitle.
 */
function deriveExecuteDisplay(call: AcpToolCall): ToolCallDisplay {
  const description = readStringField(call.rawInput, 'description')
  const command = readStringField(call.rawInput, 'command')
  if (description) {
    return command ? { title: description, subtitle: command } : { title: description }
  }
  return { title: call.title }
}

/**
 * `search` tools (Grep) title-ify to a shell-like fragment. Surface the pattern
 * as a friendly title and keep the fork's full fragment as a subtitle.
 */
function deriveSearchDisplay(call: AcpToolCall): ToolCallDisplay {
  const pattern = readStringField(call.rawInput, 'pattern')
  if (pattern && pattern !== call.title) {
    return {
      title: localize('acp.toolCall.searchTitle', 'Search “{pattern}”', { pattern }),
      subtitle: call.title,
    }
  }
  return { title: call.title }
}

/**
 * Humanize an MCP tool segment (`mcp__<server>__<tool>`'s `<tool>`) into a
 * friendly Title Case label: `ue_create_session` → `Create Session`,
 * `read_object` → `Read Object`. Server attribution is shown separately as a
 * badge, so it is not repeated here.
 *
 * The leading `ue_`-style vendor prefix (a short lowercase token followed by an
 * underscore) is dropped as noise; we keep it if stripping would empty the
 * label.
 */
export function humanizeMcpTool(tool: string): string {
  const withoutPrefix = tool.replace(/^[a-z]{1,3}_(?=[a-z])/, '')
  const base = withoutPrefix.length > 0 ? withoutPrefix : tool
  const words = base
    .split(/[_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.length > 0 ? words.join(' ') : tool
}

/**
 * MCP tools arrive with the raw tool name as their title (e.g.
 * `mcp_universe-editor_ue_create_session`). Humanize the parsed `mcpTool`
 * segment into a friendly Title Case title; the server is surfaced as a badge.
 */
function deriveMcpDisplay(call: AcpToolCall): ToolCallDisplay {
  if (call.mcpTool && call.mcpTool.length > 0) {
    return { title: humanizeMcpTool(call.mcpTool) }
  }
  return { title: call.title }
}

/**
 * Detect and pretty-print a JSON payload so the UI can syntax-highlight it.
 * Only trigger on text that clearly *is* a JSON object/array (starts with `{`
 * or `[` and parses cleanly) so plain-text / markdown output stays on its
 * original rendering path.
 */
export function tryPrettyJson(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return undefined
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return undefined
  }
}

/**
 * ExitPlanMode（`switch_mode`）被拒不是错误，而是用户选择「继续规划」——无论点
 * "No, keep planning" 还是在 steering 输入框写下意见，fork 端都返回 deny，SDK 把它
 * 映射成 `status: 'failed'` 且 body 为 deny message。这句是给模型看的内部文案，
 * 展示给用户会误以为出错，故识别出来降级为中性提示。
 */
export function isKeepPlanning(call: AcpToolCall): boolean {
  return call.kind === 'switch_mode' && call.status === 'failed'
}

/**
 * fork 在用户未填写 steering 意见时的默认 deny 文案（见 vendor/claude-agent-acp）。
 * 正常情况下 fork 已把它过滤为空 content，此处仅作为兼容旧产物的兜底判定。
 */
export const DEFAULT_KEEP_PLANNING_MESSAGE = 'User rejected request to exit plan mode.'

/** 去掉 fork 对错误内容添加的 ```\n…\n``` 代码围栏，还原纯文本。 */
function stripErrorFence(text: string): string {
  const m = /^```(?:\w*)?\n([\s\S]*?)\n```$/.exec(text.trim())
  return (m?.[1] ?? text).trim()
}

/**
 * 上游中断（CLI 合成的假「用户拒绝」）：claude CLI 在 abort 工具执行队列时,只要
 * abort 原因不是 interrupt/end_conversation 就一律合成一条 user-rejected 的
 * tool_result——它不是真人拒绝,fork 端从未回答过 `behavior: deny`。fork 给这条
 * 终态 update 打上 `_meta.claudeCode.syntheticDenial`,识别出来以「上游中断、需要
 * 重发」呈现,并抑制那句给模型看的误导性拒绝文案。
 */
export function isSyntheticDenial(call: AcpToolCall): boolean {
  return call.syntheticDenial === true
}

/**
 * 从「继续规划」工具调用里提取用户填写的 steering 意见；无意见（默认文案或空）时
 * 返回 undefined。用户意见走 deny message 通道落盘，故回放与实时同源，均从此读取。
 */
export function keepPlanningFeedback(call: AcpToolCall): string | undefined {
  if (!isKeepPlanning(call)) return undefined
  const text = stripErrorFence(call.text)
  if (text.length === 0 || text === DEFAULT_KEEP_PLANNING_MESSAGE) return undefined
  return text
}

/**
 * 「整文件写入」卡（claude 的 Write / codex 的 add file，ACP 无 write kind，二者都
 * 映射成 `kind: 'edit'`）的目标路径；不是这类卡则返回 undefined。子 agent 的调查结果
 * 文档是它的一个子集。
 *
 * 它是一份新文档而非一次待审改动，所以默认折叠、并在卡头给出阅读入口——折叠与卡头
 * 两个消费方共用这一次判定，故返回路径而非布尔。
 *
 * `oldText` 为空是唯一可用的「新建」信号（wire 上的 `null` 由 splitToolCallContent
 * 归一为 `''`），但 trimToolCall 也会把所有 diff 的 oldText 清空以释放内存——所以必须
 * 先排除 memoryTrimmed，否则每张被裁剪的卡都会被误判成新建。
 */
export function createdFilePath(call: AcpToolCall): string | undefined {
  if (call.kind !== 'edit' || call.memoryTrimmed) return undefined
  const [diff, ...rest] = call.diffs
  if (diff === undefined || rest.length > 0) return undefined
  return diff.oldText.length === 0 ? diff.path : undefined
}

function deriveSwitchModeDisplay(call: AcpToolCall): ToolCallDisplay {
  if (isKeepPlanning(call)) {
    return { title: localize('acp.switchMode.keepPlanning', 'Continued planning') }
  }
  return { title: call.title }
}

export function deriveToolCallDisplay(call: AcpToolCall): ToolCallDisplay {
  if (call.mcpServer !== undefined) return deriveMcpDisplay(call)
  switch (call.kind) {
    case 'execute':
      return deriveExecuteDisplay(call)
    case 'search':
      return deriveSearchDisplay(call)
    case 'switch_mode':
      return deriveSwitchModeDisplay(call)
    default:
      return { title: call.title }
  }
}
