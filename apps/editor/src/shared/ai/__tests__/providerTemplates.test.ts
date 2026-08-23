/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  providerTemplates: structural invariants — unique ids, no id/apiKey leakage,
 *  catalog-vendor validity, official-endpoint alignment, protocolMap coherence.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { OFFICIAL_CATALOGS } from '../catalog/modelKnowledge.js'
import { isOfficialEndpoint } from '../officialEndpoints.js'
import { PROVIDER_TEMPLATES } from '../providerTemplates.js'

describe('PROVIDER_TEMPLATES', () => {
  it('has unique template ids', () => {
    const ids = PROVIDER_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never supplies id or apiKey in any template entry', () => {
    for (const template of PROVIDER_TEMPLATES) {
      expect('id' in template.entry, `template '${template.id}' must not supply id`).toBe(false)
      expect('apiKey' in template.entry, `template '${template.id}' must not supply apiKey`).toBe(
        false,
      )
    }
  })

  it('catalog pricingSource vendor must be a key of OFFICIAL_CATALOGS', () => {
    for (const template of PROVIDER_TEMPLATES) {
      const ps = template.entry.pricingSource
      if (ps === undefined || ps.id !== 'catalog') continue
      const vendor = ps.options?.['vendor']
      expect(typeof vendor, `template '${template.id}' catalog vendor must be a string`).toBe(
        'string',
      )
      expect(
        Object.keys(OFFICIAL_CATALOGS),
        `template '${template.id}' vendor '${String(vendor)}' must be in OFFICIAL_CATALOGS`,
      ).toContain(vendor)
    }
  })

  it('official templates have baseUrls that isOfficialEndpoint recognizes', () => {
    const openai = PROVIDER_TEMPLATES.find((t) => t.id === 'openai-official')
    const anthropic = PROVIDER_TEMPLATES.find((t) => t.id === 'anthropic-official')
    expect(openai).toBeDefined()
    expect(anthropic).toBeDefined()
    if (openai?.entry.baseUrl !== undefined && openai.entry.defaultProtocol !== undefined) {
      expect(
        isOfficialEndpoint(openai.entry.defaultProtocol, openai.entry.baseUrl),
        `openai-official baseUrl '${openai.entry.baseUrl}' must be recognized as official`,
      ).toBe(true)
    }
    if (anthropic?.entry.baseUrl !== undefined && anthropic.entry.defaultProtocol !== undefined) {
      expect(
        isOfficialEndpoint(anthropic.entry.defaultProtocol, anthropic.entry.baseUrl),
        `anthropic-official baseUrl '${anthropic.entry.baseUrl}' must be recognized as official`,
      ).toBe(true)
    }
  })

  it('defaultProtocol must be a key of protocolMap when both are declared', () => {
    for (const template of PROVIDER_TEMPLATES) {
      const { defaultProtocol, protocolMap } = template.entry
      if (defaultProtocol === undefined || protocolMap === undefined) continue
      expect(
        Object.keys(protocolMap),
        `template '${template.id}' defaultProtocol '${defaultProtocol}' must be in protocolMap`,
      ).toContain(defaultProtocol)
    }
  })
})
