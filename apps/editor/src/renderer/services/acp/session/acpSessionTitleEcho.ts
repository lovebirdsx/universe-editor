/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Detects when an agent-reported session title is just an echo of one of our prompts
 *  (the SDK `lastPrompt` summary fallback), so the title overwrite paths can keep local titles.
 *--------------------------------------------------------------------------------------------*/

/** The single normalization every side converges to (and idempotent): claude fork `sanitizeTitle`
 *  (vendor/claude-agent-acp/src/acp-agent.ts:501), codex `normalizeSessionTitle`
 *  (vendor/codex-acp/src/CodexAcpServer.ts:1705) and the SDK firstPrompt extraction are all
 *  equivalent to one `\s+ → ' '` pass + trim. */
export function normalizeTitleForEcho(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** True when the agent-reported title is just one of our prompts echoed back. Conservative:
 *  when in doubt return false and keep the agent's title. */
export function isPromptEchoTitle(title: string, promptTexts: readonly string[]): boolean {
  const t = normalizeTitleForEcho(title)
  if (t.length === 0) return false // an empty title must not match an empty prompt
  for (const promptText of promptTexts) {
    const p = normalizeTitleForEcho(promptText)
    if (t === p) return true
    // Truncation tolerance: covers claude's slice(0,255)+'…' and the SDK's slice(0,200)+'…'
    // without pinning a length; length > 1 keeps a bare '…' from matching every prompt.
    if (t.endsWith('…') && t.length > 1 && p.startsWith(t.slice(0, -1))) return true
  }
  return false
}
