import { afterEach, describe, expect, it } from 'vitest'
import { JSONContributionRegistry, URI } from '@universe-editor/platform'
import { matchSchemasForUri } from '../schemaMatch.js'

const disposables: { dispose(): void }[] = []
afterEach(() => {
  for (const d of disposables.splice(0)) d.dispose()
})

function register(uri: string, fileMatch: string[]): void {
  disposables.push(
    JSONContributionRegistry.registerSchema({ uri, fileMatch, schema: { type: 'object' } }),
  )
}

describe('matchSchemasForUri', () => {
  it('matches a **/ glob against a nested file (Monaco wrap semantics)', () => {
    register('test://claude', ['**/.claude/settings.json'])
    const hit = matchSchemasForUri(URI.file('C:/Users/me/.claude/settings.json'))
    expect(hit.map((c) => c.uri)).toEqual(['test://claude'])
  })

  it('wraps a bare pattern with **/ so it matches anywhere in the path', () => {
    register('test://entity', ['*.entity.json'])
    const hit = matchSchemasForUri(URI.file('D:/proj/data/hero.entity.json'))
    expect(hit.map((c) => c.uri)).toEqual(['test://entity'])
  })

  it('matches a lower-cased Windows drive path', () => {
    register('test://drive', ['**/settings.json'])
    const hit = matchSchemasForUri(URI.file('D:/App/settings.json'))
    expect(hit.map((c) => c.uri)).toEqual(['test://drive'])
  })

  it('returns nothing when no fileMatch covers the uri', () => {
    register('test://other', ['**/*.foo.json'])
    expect(matchSchemasForUri(URI.file('C:/x/bar.json'))).toEqual([])
  })

  it('returns every matching schema', () => {
    register('test://a', ['**/settings.json'])
    register('test://b', ['**/.claude/settings.json'])
    const hit = matchSchemasForUri(URI.file('C:/u/.claude/settings.json'))
    expect(hit.map((c) => c.uri).sort()).toEqual(['test://a', 'test://b'])
  })
})
