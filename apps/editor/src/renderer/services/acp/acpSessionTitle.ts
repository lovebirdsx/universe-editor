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

/** history.title 优先于 live.title（后者构造时锁定，rename 后不更新）；两者皆无则 undefined。 */
export function resolveLiveSessionTitle(
  history: IAcpSessionHistoryService,
  sessions: IAcpSessionService,
  sessionId: string,
): string | undefined {
  return history.get(sessionId)?.title ?? sessions.getById(sessionId)?.title
}

/** 纯函数，便于单测。symbol+sessionTitle 同时存在 → 带 Session 段；否则回退到「name - parent」。 */
export function formatWindowTitle(args: {
  appName: string
  workspaceName?: string
  parent?: string
  symbol?: string | undefined
  sessionTitle?: string | undefined
}): string {
  const { appName, workspaceName, parent, symbol, sessionTitle } = args
  if (workspaceName === undefined) return appName
  if (symbol && sessionTitle) return `${workspaceName} — ${symbol} ${sessionTitle}`
  return parent ? `${workspaceName} - ${parent}` : workspaceName
}
