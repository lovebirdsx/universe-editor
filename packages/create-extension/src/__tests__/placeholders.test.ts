import { describe, it, expect } from 'vitest'
import { buildPlaceholders } from '../placeholders.js'
import { SDK_VERSIONS } from '../sdkVersions.js'

const answers = {
  name: 'demo',
  publisher: 'acme',
  displayName: 'Demo',
  description: 'a demo',
  template: 'basic' as const,
}

describe('buildPlaceholders', () => {
  it('maps every answer and version field', () => {
    const map = buildPlaceholders(answers, SDK_VERSIONS)
    expect(map.__name__).toBe('demo')
    expect(map.__publisher__).toBe('acme')
    expect(map.__apiVersion__).toBe(SDK_VERSIONS.extensionApi)
    expect(map.__uexVersion__).toBe(SDK_VERSIONS.uex)
  })

  it('engines.universe range uses the only host-supported form', () => {
    const range = buildPlaceholders(answers, SDK_VERSIONS).__enginesUniverse__!
    // The host's satisfies() fail-closes on ^, || and hyphen ranges — lock the
    // generated range against all three.
    expect(range).toBe(`>=${SDK_VERSIONS.extensionApi} <1.0.0`)
    expect(range.startsWith('^')).toBe(false)
    expect(range).not.toContain('||')
    expect(range).not.toMatch(/\d\s+-\s+\d/)
  })
})
