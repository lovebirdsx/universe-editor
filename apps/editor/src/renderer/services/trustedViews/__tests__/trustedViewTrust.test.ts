import { describe, expect, it, vi } from 'vitest'
import { ConfigurationTarget, type IConfigurationService } from '@universe-editor/platform'
import {
  TRUSTED_VIEW_EXTENSIONS_SETTING,
  isTrustedViewExtension,
  normalizeTrustedViewIds,
  readTrustedViewExtensions,
  trustedViewIdsSignature,
} from '../trustedViewTrust.js'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'

function ext(overrides: Partial<IExtensionDescriptionDto> = {}): IExtensionDescriptionDto {
  return {
    id: 'acme.ext',
    name: 'ext',
    activationEvents: [],
    contributes: {},
    hasMain: true,
    extensionLocation: { scheme: 'file', path: '/ext' },
    extensionIsBuiltin: false,
    ...overrides,
  }
}

describe('isTrustedViewExtension', () => {
  it('trusts built-in extensions implicitly', () => {
    expect(isTrustedViewExtension(ext({ extensionIsBuiltin: true }), [])).toBe(true)
  })

  it('trusts development extensions implicitly', () => {
    expect(isTrustedViewExtension(ext({ extensionIsUnderDevelopment: true }), [])).toBe(true)
  })

  it('matches a listed id case-insensitively', () => {
    expect(isTrustedViewExtension(ext({ id: 'Acme.Ext' }), ['acme.ext'])).toBe(true)
    expect(isTrustedViewExtension(ext({ id: 'acme.ext' }), ['other.ext'])).toBe(false)
  })
})

describe('trusted view settings helpers', () => {
  it('drops non-string / blank entries', () => {
    expect(normalizeTrustedViewIds(['a', '', '  ', 1, null, 'b'])).toEqual(['a', 'b'])
    expect(normalizeTrustedViewIds('nope')).toEqual([])
    expect(normalizeTrustedViewIds(undefined)).toEqual([])
    expect(normalizeTrustedViewIds([{}])).toEqual([])
  })

  it('keeps the original case (matching lowercases at comparison time)', () => {
    expect(normalizeTrustedViewIds(['Acme.Ext'])).toEqual(['Acme.Ext'])
  })

  it('builds an order- and case-insensitive signature', () => {
    expect(trustedViewIdsSignature(['B', 'a'])).toBe(trustedViewIdsSignature(['A', 'b']))
  })

  it('reads only the User layer, ignoring a workspace-scoped value', () => {
    const configuration = {
      getValue: vi.fn(() => ['acme.ext']),
      getValueForTarget: vi.fn(() => []),
    } as unknown as IConfigurationService
    const trustedIds = readTrustedViewExtensions(configuration)

    expect(configuration.getValueForTarget).toHaveBeenCalledWith(
      TRUSTED_VIEW_EXTENSIONS_SETTING,
      ConfigurationTarget.User,
    )
    expect(trustedIds).toEqual([])
    // The workspace list must not be able to grant renderer code execution.
    expect(isTrustedViewExtension(ext(), trustedIds)).toBe(false)
  })
})
