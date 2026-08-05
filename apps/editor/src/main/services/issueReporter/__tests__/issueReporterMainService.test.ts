/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/issueReporter/issueReporterMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { IssueReporterMainService } from '../issueReporterMainService.js'

function makeService() {
  return new IssueReporterMainService({
    createDiagnosticsZip: () => Promise.resolve('/nonexistent/diag.zip'),
  })
}

describe('IssueReporterMainService', () => {
  it('lists the built-in providers', async () => {
    const service = makeService()
    expect(await service.listProviders()).toEqual([
      { id: 'github', label: 'GitHub', supportsAttachments: false },
      { id: 'iloop', label: 'iLoop', supportsAttachments: true },
    ])
    service.dispose()
  })

  it('dispatches buildIssueUrl to the matching provider', async () => {
    const service = makeService()
    const url = await service.buildIssueUrl('github', {
      markdown: 'hello',
      pasteHint: 'hint',
      attachDiagnostics: false,
    })
    expect(url).toContain('https://github.com/lovebirdsx/universe-editor/issues/new?body=')
    service.dispose()
  })

  it('throws on unknown provider id', async () => {
    const service = makeService()
    await expect(
      service.buildIssueUrl('nope', { markdown: '', pasteHint: '', attachDiagnostics: false }),
    ).rejects.toThrow("Unknown issue reporter provider 'nope'")
    service.dispose()
  })

  it('rejects attachments for providers without support', async () => {
    const service = makeService()
    await expect(
      service.buildIssueUrl('github', { markdown: '', pasteHint: '', attachDiagnostics: true }),
    ).rejects.toThrow('does not support attachments')
    service.dispose()
  })
})
