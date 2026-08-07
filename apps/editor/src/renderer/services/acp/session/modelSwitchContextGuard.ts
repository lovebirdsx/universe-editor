/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Guard for switching a live claude-code session onto a smaller-context model.
 *
 *  Background (real incident): a side task forked at ~172k tokens ran on
 *  "claude-fable-5[1m]" (1M lane, 300k auto-compact window). The user switched
 *  to the bare "sonnet" row to save cost — a 200k-window model — and the very
 *  next prompt silently triggered an auto-compact that dropped most of the
 *  forked context. The switch itself is legitimate; losing 172k tokens of
 *  context without any warning is not. This guard estimates the target row's
 *  context window from its context-lane spelling and asks for confirmation
 *  when the current usage would immediately overflow it.
 *--------------------------------------------------------------------------------------------*/

import { localize, type IDialogService } from '@universe-editor/platform'
import type { AcpUsage } from './acpSessionModel.js'

/** Agents whose model rows follow the Claude context-lane spelling ("[1m]" / "-1m"). */
const CLAUDE_AGENT_ID = 'claude-code'

/** Context window of a bare (no lane hint) Claude model row. */
const CLAUDE_BARE_CONTEXT_WINDOW = 200_000

/**
 * Fraction of the estimated target window at which the next prompt is
 * considered to trigger an immediate auto-compact. The SDK compacts at
 * roughly window − ~28k reserve (observed: 172224 tokens compacted on a
 * 200k window), so 0.8 warns slightly early rather than exactly at the edge.
 */
const IMMINENT_COMPACT_RATIO = 0.8

// Same two spellings the claude-agent-acp fork canonicalizes: the display
// form "sonnet[1m]" and the SDK id-suffix form "claude-opus-4-6-1m".
const CONTEXT_HINT_BRACKET_PATTERN = /\[(\d+)m\]$/i
const CONTEXT_HINT_SUFFIX_PATTERN = /-(\d+)m$/i

/**
 * Estimate a Claude model row's context window from its id: a context-lane
 * hint ("[1m]" / "-1m") means N million tokens, a bare id means 200k.
 */
export function estimateClaudeModelContextWindow(modelValue: string): number {
  const trimmed = modelValue.trim().toLowerCase()
  const hint =
    trimmed.match(CONTEXT_HINT_BRACKET_PATTERN)?.[1] ??
    trimmed.match(CONTEXT_HINT_SUFFIX_PATTERN)?.[1]
  if (hint !== undefined) return Number(hint) * 1_000_000
  return CLAUDE_BARE_CONTEXT_WINDOW
}

export interface ModelSwitchContextShrink {
  /** Tokens currently in the session's context. */
  readonly usedTokens: number
  /** Estimated context window of the model being switched to. */
  readonly estimatedTargetWindow: number
}

/**
 * Decide whether switching `targetModelValue` onto this session would shrink
 * the context window below what the session already uses — i.e. the next
 * prompt would immediately auto-compact. Returns the shrink facts when a
 * confirmation is warranted, `undefined` when the switch is safe (or the
 * heuristic doesn't apply to this agent).
 */
export function evaluateModelSwitchContextShrink(
  agentId: string,
  usage: AcpUsage | undefined,
  targetModelValue: string,
): ModelSwitchContextShrink | undefined {
  if (agentId !== CLAUDE_AGENT_ID) return undefined
  if (usage === undefined || usage.used <= 0) return undefined
  const estimatedTargetWindow = estimateClaudeModelContextWindow(targetModelValue)
  // Not a shrink: the target window is at least as large as the current
  // effective window, so whatever fits today keeps fitting.
  if (estimatedTargetWindow >= usage.size) return undefined
  if (usage.used < estimatedTargetWindow * IMMINENT_COMPACT_RATIO) return undefined
  return { usedTokens: usage.used, estimatedTargetWindow }
}

function formatKiloTokens(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`
}

/**
 * Ask the user to confirm a context-shrinking model switch. Returns true when
 * the switch should proceed.
 */
export async function confirmModelSwitchContextShrink(
  dialogService: IDialogService,
  shrink: ModelSwitchContextShrink,
  targetModelLabel: string,
): Promise<boolean> {
  console.debug(
    `[acp-model-switch] context shrink: used=${shrink.usedTokens} targetWindow=${shrink.estimatedTargetWindow} target="${targetModelLabel}"`,
  )
  const result = await dialogService.confirm({
    type: 'warning',
    message: localize('acp.modelSwitch.shrink.message', 'Switch to "{model}"?', {
      model: targetModelLabel,
    }),
    detail: localize(
      'acp.modelSwitch.shrink.detail',
      'This session already uses ~{used} tokens of context, but "{model}" only has a ~{window} token window. Switching will compact the conversation on the next message and earlier details may be lost. To keep the full context, pick a variant with a larger window (e.g. "1M context").',
      {
        used: formatKiloTokens(shrink.usedTokens),
        model: targetModelLabel,
        window: formatKiloTokens(shrink.estimatedTargetWindow),
      },
    ),
    primaryButton: localize('acp.modelSwitch.shrink.confirm', 'Switch Anyway'),
  })
  return result.confirmed
}
