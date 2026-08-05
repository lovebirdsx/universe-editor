/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitHub issue reporter: pre-fills the issue body via the `body` query param.
 *  Mirrors VSCode's degradation — when the pre-filled URL would exceed the safe
 *  length cap, the body is dropped and the user pastes from the clipboard
 *  instead. Attachments are not supported (no upload endpoint on the new-issue
 *  page), the diagnostics zip stays a manual export.
 *--------------------------------------------------------------------------------------------*/

import {
  ISSUE_URL_MAX_LENGTH,
  type IIssueReporterProvider,
  type IssueReportPayload,
} from '@universe-editor/platform'

export const GITHUB_ISSUE_URL_BASE = 'https://github.com/lovebirdsx/universe-editor/issues/new'

export class GitHubIssueReporterProvider implements IIssueReporterProvider {
  readonly id = 'github'
  readonly label = 'GitHub'
  readonly supportsAttachments = false

  buildIssueUrl(payload: IssueReportPayload): Promise<string> {
    const full = `${GITHUB_ISSUE_URL_BASE}?body=${encodeURIComponent(payload.markdown)}`
    if (full.length <= ISSUE_URL_MAX_LENGTH) return Promise.resolve(full)
    return Promise.resolve(`${GITHUB_ISSUE_URL_BASE}?body=${encodeURIComponent(payload.pasteHint)}`)
  }
}
