/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/issueReporter/providers/githubProvider.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { GITHUB_ISSUE_URL_BASE, GitHubIssueReporterProvider } from '../providers/githubProvider.js'

const PASTE_HINT = '（please paste from clipboard）'

describe('GitHubIssueReporterProvider', () => {
  const provider = new GitHubIssueReporterProvider()

  it('declares no attachment support', () => {
    expect(provider.id).toBe('github')
    expect(provider.supportsAttachments).toBe(false)
  })

  it('builds the issues/new url with the encoded body', async () => {
    const url = await provider.buildIssueUrl({
      markdown: '## 版本\n- 应用版本: 1.0.0',
      pasteHint: PASTE_HINT,
      attachDiagnostics: false,
    })
    expect(url.startsWith(`${GITHUB_ISSUE_URL_BASE}?body=`)).toBe(true)
    expect(decodeURIComponent(url.slice(url.indexOf('body=') + 5))).toBe(
      '## 版本\n- 应用版本: 1.0.0',
    )
  })

  it('degrades to the paste hint when the pre-filled url would exceed the cap', async () => {
    const url = await provider.buildIssueUrl({
      markdown: 'x'.repeat(8000),
      pasteHint: PASTE_HINT,
      attachDiagnostics: false,
    })
    expect(decodeURIComponent(url.slice(url.indexOf('body=') + 5))).toBe(PASTE_HINT)
  })
})
