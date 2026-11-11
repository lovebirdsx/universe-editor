/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Commit-message generation for session delivery. The message is produced by an
 *  internal, read-only side task forked from the source session, so the agent
 *  already has the task context. Any failure (timeout, empty/oversized reply,
 *  errored turn) aborts the delivery — there is deliberately no template
 *  fallback.
 *--------------------------------------------------------------------------------------------*/

import type { IAcpSession } from '../acp/session/acpSessionModel.js'
import type { DeliveryGitChangeContextData } from './sessionDeliveryGit.js'
import type { SessionDeliveryError } from './sessionDeliveryTypes.js'

export const DELIVERY_MESSAGE_TIMEOUT_MS = 90_000
export const DELIVERY_CONFLICT_TIMEOUT_MS = 180_000
export const MAX_COMMIT_MESSAGE_LENGTH = 4000

export type DeliveryTurnResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: SessionDeliveryError }

export function buildCommitMessagePrompt(context: DeliveryGitChangeContextData): string {
  const fileSections = context.files
    .map((file) => `--- ${file.path} (${file.status}) ---\n${file.diff}`)
    .join('\n\n')
  return [
    'Generate a git commit message for the uncommitted changes below.',
    '',
    'Rules:',
    '- Reply with ONLY the commit message. No preamble, no explanation.',
    '- First line: an imperative subject of at most 72 characters.',
    '- Optionally add a blank line and a short body (wrap at 72 characters).',
    '- Do not modify any files, do not run commands, do not use tools.',
    '- Do not wrap the message in code fences or quotes.',
    '',
    `Status:\n${context.statusText}`,
    '',
    context.truncated ? 'Diffs (truncated):' : 'Diffs:',
    fileSections,
  ].join('\n')
}

export function sanitizeCommitMessage(raw: string): string | undefined {
  let text = raw.trim()
  if (text.length === 0) return undefined
  text = text.replace(/^commit message\s*:\s*/i, '')
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text)
  if (fenced?.[1] !== undefined) text = fenced[1].trim()
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim()
  }
  if (text.length === 0 || text.length > MAX_COMMIT_MESSAGE_LENGTH) return undefined
  return text
}

function lastAgentText(session: IAcpSession): string {
  const messages = session.messages.get()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message !== undefined && message.role === 'agent' && message.text.trim().length > 0) {
      return message.text
    }
  }
  return ''
}

/**
 * Send one prompt and wait for the turn to settle. Times out without leaving an
 * unhandled rejection: the prompt promise's rejection is always observed, even
 * when the timeout wins the race.
 */
export async function runDeliveryTurn(
  session: IAcpSession,
  prompt: string,
  timeoutMs: number,
  failureCode: SessionDeliveryError['code'],
  label: string,
): Promise<DeliveryTurnResult> {
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = session.sendPrompt(prompt).then(
    () => ({ kind: 'ok' as const }),
    (err: unknown) => ({ kind: 'error' as const, err }),
  )
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })
  const outcome = await Promise.race([settled, timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (outcome.kind === 'timeout' || timedOut) {
    void session.cancelTurn().catch(() => undefined)
    return {
      ok: false,
      error: { code: failureCode, message: `${label} timed out after ${timeoutMs / 1000}s.` },
    }
  }
  if (outcome.kind === 'error') {
    return {
      ok: false,
      error: {
        code: failureCode,
        message: `${label} failed.`,
        detail: outcome.err instanceof Error ? outcome.err.message : String(outcome.err),
      },
    }
  }
  if (session.status.get() === 'errored') {
    return {
      ok: false,
      error: { code: failureCode, message: `${label} ended with an agent error.` },
    }
  }
  return { ok: true, text: lastAgentText(session) }
}

export function buildConflictPrompt(input: {
  readonly conflictedCommit: { readonly shortSha: string; readonly subject: string }
  readonly files: readonly string[]
  readonly remainingCommits: number
}): string {
  return [
    'Resolve the cherry-pick conflict in this worktree.',
    '',
    `Conflicted commit: ${input.conflictedCommit.shortSha} ${input.conflictedCommit.subject}`,
    `Conflicted files:\n${input.files.map((file) => `- ${file}`).join('\n')}`,
    '',
    'Rules:',
    '- Edit only files inside this worktree to resolve the conflict markers.',
    '- Preserve the intent of the conflicted commit on top of the current tree.',
    '- Do not run git commands, do not commit, do not push.',
    '- Leave the resolved files on disk; the editor stages and continues the cherry-pick.',
    input.remainingCommits > 0
      ? `- ${input.remainingCommits} more commit(s) will be picked afterwards.`
      : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}
