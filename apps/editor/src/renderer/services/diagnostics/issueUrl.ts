/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitHub issue URL construction for the Report Issue flow. Mirrors VSCode's
 *  degradation: when the pre-filled body would push the URL past ~7500 chars
 *  the body is dropped and the user pastes from the clipboard instead.
 *--------------------------------------------------------------------------------------------*/

export const ISSUE_URL_BASE = 'https://github.com/lovebirdsx/universe-editor/issues/new'

/** Above this the URL itself risks truncation in browsers / shells (VSCode uses the same cap). */
const MAX_URL_LENGTH = 7500

export function buildIssueUrl(markdownBody: string, pasteHint: string): string {
  const full = `${ISSUE_URL_BASE}?body=${encodeURIComponent(markdownBody)}`
  if (full.length <= MAX_URL_LENGTH) return full
  return `${ISSUE_URL_BASE}?body=${encodeURIComponent(pasteHint)}`
}
