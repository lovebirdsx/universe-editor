/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/issueReporter/issueReporterRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IIssueReporterProvider } from '../../issueReporter/issueReporterProvider.js'
import { IssueReporterRegistry } from '../../issueReporter/issueReporterRegistry.js'

function fakeProvider(id: string, supportsAttachments = false): IIssueReporterProvider {
  return {
    id,
    label: id.toUpperCase(),
    supportsAttachments,
    buildIssueUrl: () => Promise.resolve(`https://example.com/${id}`),
  }
}

describe('IssueReporterRegistry', () => {
  it('registers, gets and lists providers', () => {
    const registry = new IssueReporterRegistry()
    registry.registerProvider(fakeProvider('github'))
    registry.registerProvider(fakeProvider('iloop', true))

    expect(registry.getProvider('github')?.label).toBe('GITHUB')
    expect(registry.listProviders()).toEqual([
      { id: 'github', label: 'GITHUB', supportsAttachments: false },
      { id: 'iloop', label: 'ILOOP', supportsAttachments: true },
    ])
    registry.dispose()
  })

  it('rejects duplicate ids and unregisters on dispose', () => {
    const registry = new IssueReporterRegistry()
    registry.registerProvider(fakeProvider('github'))
    expect(() => registry.registerProvider(fakeProvider('github'))).toThrow()

    const d = registry.registerProvider(fakeProvider('iloop'))
    d.dispose()
    expect(registry.getProvider('iloop')).toBeUndefined()
    registry.dispose()
  })
})
