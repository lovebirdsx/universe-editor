/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared session-title helpers. The cascade (history.title ?? live.title) and
 *  the 24-char truncation are reused by both the session editor tab
 *  (AcpSessionEditorInput) and the native window title (WindowTitleContribution)
 *  so Alt+Tab shows the same label as the tab.
 *--------------------------------------------------------------------------------------------*/

import type { IAcpSessionService } from './acpSessionService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'

export const MAX_SESSION_TITLE_LEN = 24

export function truncateSessionTitle(s: string): string {
  if (s.length <= MAX_SESSION_TITLE_LEN) return s
  return `${s.slice(0, MAX_SESSION_TITLE_LEN - 1)}…`
}

/**
 * history.title 优先于 live.title（后者构造时锁定，rename / AI 改名后不更新）；两者皆无则 undefined。
 *
 * history 条目按 agent 颁发的 `sessionIdOnAgent` 建 key，而 tab/window 传入的 `sessionId`
 * 可能是本地 uuid（创建即渲染、握手前还没有 agent id）。所以先用 live session 把本地 id
 * 解析成 `sessionIdOnAgent` 再查 history，否则本地 uuid 永远 miss，只能回落到锁死的 live.title。
 */
export function resolveLiveSessionTitle(
  history: IAcpSessionHistoryService,
  sessions: IAcpSessionService,
  sessionId: string,
): string | undefined {
  const live = sessions.getById(sessionId)
  const historyId = live?.sessionIdOnAgent.get() ?? sessionId
  return history.get(historyId)?.title ?? live?.title
}

/**
 * 纯函数，便于单测。symbol+sessionTitle 同时存在 → 带 Session 段；否则回退到「name - parent」。
 * remoteBadge（调用方已包好方括号，如 "[WSL: ubuntu-24.04]"）与 devHostBadge（如
 * "[Extension Development Host]"）依次拼在尾部，且在每个分支都生效（含无 workspace）。
 */
export function formatWindowTitle(args: {
  appName: string
  workspaceName?: string
  parent?: string
  symbol?: string | undefined
  sessionTitle?: string | undefined
  /** Remote badge appended before the dev-host badge, e.g. "[WSL: ubuntu-24.04]". */
  remoteBadge?: string | undefined
  /** Mode badge appended at the very end, e.g. "[Extension Development Host]". */
  devHostBadge?: string | undefined
}): string {
  const { appName, workspaceName, parent, symbol, sessionTitle, remoteBadge, devHostBadge } = args
  const badge = [remoteBadge, devHostBadge]
    .filter((b): b is string => b !== undefined)
    .map((b) => ` ${b}`)
    .join('')
  if (workspaceName === undefined) return `${appName}${badge}`
  if (symbol && sessionTitle) return `${workspaceName} — ${symbol} ${sessionTitle}${badge}`
  return `${parent ? `${workspaceName} - ${parent}` : workspaceName}${badge}`
}
