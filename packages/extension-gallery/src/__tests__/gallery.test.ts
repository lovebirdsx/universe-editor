import { describe, expect, it } from 'vitest'
import {
  buildQuery,
  parseQueryResult,
  pickVsixAsset,
  pickCompatibleVersion,
  readEngineConstraint,
  AssetType,
  GalleryFilterType,
  GallerySortBy,
  UNIVERSE_TARGET,
  type IRawGalleryQueryResult,
  type IRawGalleryVersion,
} from '../index.js'

describe('buildQuery', () => {
  it('always includes the target criterion', () => {
    const q = buildQuery()
    const target = q.filters[0]!.criteria.find((c) => c.filterType === GalleryFilterType.Target)
    expect(target?.value).toBe(UNIVERSE_TARGET)
  })

  it('adds search text and category criteria', () => {
    const q = buildQuery({ text: 'python', category: 'AI', sortBy: GallerySortBy.InstallCount })
    const types = q.filters[0]!.criteria.map((c) => c.filterType)
    expect(types).toContain(GalleryFilterType.SearchText)
    expect(types).toContain(GalleryFilterType.Category)
    expect(q.filters[0]!.sortBy).toBe(GallerySortBy.InstallCount)
  })

  it('adds one ExtensionName criterion per requested id', () => {
    const q = buildQuery({ names: ['a.b', 'c.d'] })
    const names = q.filters[0]!.criteria.filter(
      (c) => c.filterType === GalleryFilterType.ExtensionName,
    )
    expect(names.map((c) => c.value)).toEqual(['a.b', 'c.d'])
  })
})

function rawResult(extensions: unknown[], total?: number): IRawGalleryQueryResult {
  return {
    results: [
      {
        extensions: extensions as never,
        ...(total !== undefined
          ? {
              resultMetadata: [
                {
                  metadataType: 'ResultCount',
                  metadataItems: [{ name: 'TotalCount', count: total }],
                },
              ],
            }
          : {}),
      },
    ],
  }
}

const fullVersion: IRawGalleryVersion = {
  version: '1.2.3',
  lastUpdated: '2024-01-01',
  files: [
    { assetType: AssetType.Vsix, source: 'https://host/pkg.vsix' },
    { assetType: AssetType.Icon, source: 'https://host/icon.png' },
    { assetType: AssetType.Details, source: 'https://host/readme.md' },
  ],
  properties: [{ key: 'Universe.Editor.Engine', value: '^0.1.0' }],
}

describe('parseQueryResult', () => {
  it('maps a full extension into the domain model', () => {
    const result = parseQueryResult(
      rawResult(
        [
          {
            extensionId: 'uuid-1',
            extensionName: 'demo',
            displayName: 'Demo',
            shortDescription: 'A demo',
            publisher: { publisherName: 'acme', displayName: 'ACME Inc' },
            versions: [fullVersion],
            statistics: [
              { statisticName: 'install', value: 999 },
              { statisticName: 'averagerating', value: 4.5 },
            ],
            categories: ['AI'],
          },
        ],
        42,
      ),
    )
    expect(result.total).toBe(42)
    expect(result.extensions).toHaveLength(1)
    const ext = result.extensions[0]!
    expect(ext.identifier).toBe('acme.demo')
    expect(ext.displayName).toBe('Demo')
    expect(ext.vsixUrl).toBe('https://host/pkg.vsix')
    expect(ext.iconUrl).toBe('https://host/icon.png')
    expect(ext.readmeUrl).toBe('https://host/readme.md')
    expect(ext.engineConstraint).toBe('^0.1.0')
    expect(ext.installCount).toBe(999)
    expect(ext.rating).toBe(4.5)
    expect(ext.publisherDisplayName).toBe('ACME Inc')
    expect(ext.uuid).toBe('uuid-1')
  })

  it('drops an extension whose latest version has no VSIX asset', () => {
    const result = parseQueryResult(
      rawResult([
        {
          extensionName: 'novsix',
          publisher: { publisherName: 'acme' },
          versions: [{ version: '1.0.0', files: [{ assetType: AssetType.Icon, source: 'x' }] }],
        },
      ]),
    )
    expect(result.extensions).toHaveLength(0)
  })

  it('drops an extension with no versions', () => {
    const result = parseQueryResult(
      rawResult([{ extensionName: 'empty', publisher: { publisherName: 'acme' } }]),
    )
    expect(result.extensions).toHaveLength(0)
  })

  it('falls back total to the extension count when metadata is absent', () => {
    const result = parseQueryResult(
      rawResult([
        {
          extensionName: 'demo',
          publisher: { publisherName: 'acme' },
          versions: [fullVersion],
        },
      ]),
    )
    expect(result.total).toBe(1)
  })

  it('tolerates an entirely empty response', () => {
    expect(parseQueryResult({ results: [] })).toEqual({ extensions: [], total: 0 })
  })

  it('reads the VSCode-compatible engine key as a fallback', () => {
    const v: IRawGalleryVersion = {
      version: '1.0.0',
      files: [{ assetType: AssetType.Vsix, source: 'x' }],
      properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.80.0' }],
    }
    expect(readEngineConstraint(v)).toBe('^1.80.0')
    expect(pickVsixAsset(v)).toBe('x')
  })

  it('surfaces marketplace hash + signature when both signature properties are present', () => {
    const v: IRawGalleryVersion = {
      version: '1.0.0',
      files: [{ assetType: AssetType.Vsix, source: 'x' }],
      properties: [
        { key: 'Universe.Editor.VsixHash', value: 'ab12' },
        { key: 'Universe.Editor.VsixSignature', value: 'c2ln' },
        { key: 'Universe.Editor.SignatureKeyId', value: 'market-v1' },
      ],
    }
    const result = parseQueryResult(
      rawResult([{ extensionName: 'demo', publisher: { publisherName: 'acme' }, versions: [v] }]),
    )
    const ext = result.extensions[0]!
    expect(ext.vsixHash).toBe('ab12')
    expect(ext.vsixSignature).toEqual({ algorithm: 'ed25519', keyId: 'market-v1', value: 'c2ln' })
  })

  it('treats a signature without a keyId as unsigned', () => {
    const v: IRawGalleryVersion = {
      version: '1.0.0',
      files: [{ assetType: AssetType.Vsix, source: 'x' }],
      properties: [
        { key: 'Universe.Editor.VsixHash', value: 'ab12' },
        { key: 'Universe.Editor.VsixSignature', value: 'c2ln' },
      ],
    }
    const result = parseQueryResult(
      rawResult([{ extensionName: 'demo', publisher: { publisherName: 'acme' }, versions: [v] }]),
    )
    const ext = result.extensions[0]!
    expect(ext.vsixHash).toBe('ab12')
    expect(ext.vsixSignature).toBeUndefined()
  })
})

describe('multi-version parsing + pickCompatibleVersion', () => {
  const oldCompat: IRawGalleryVersion = {
    version: '1.0.0',
    files: [{ assetType: AssetType.Vsix, source: 'https://host/pkg-1.0.0.vsix' }],
    properties: [{ key: 'Universe.Editor.Engine', value: '>=0.13.0 <1.0.0' }],
  }
  const newIncompat: IRawGalleryVersion = {
    version: '2.0.0',
    files: [{ assetType: AssetType.Vsix, source: 'https://host/pkg-2.0.0.vsix' }],
    properties: [{ key: 'Universe.Editor.Engine', value: '>=99.0.0' }],
  }
  const noEngine: IRawGalleryVersion = {
    version: '0.5.0',
    files: [{ assetType: AssetType.Vsix, source: 'https://host/pkg-0.5.0.vsix' }],
  }

  function parsed(versions: IRawGalleryVersion[]) {
    const result = parseQueryResult(
      rawResult([{ extensionName: 'demo', publisher: { publisherName: 'acme' }, versions }]),
    )
    return result.extensions[0]!
  }

  it('parses every installable version and fills top-level fields from the newest', () => {
    const ext = parsed([newIncompat, oldCompat])
    expect(ext.version).toBe('2.0.0')
    expect(ext.vsixUrl).toBe('https://host/pkg-2.0.0.vsix')
    expect(ext.versions.map((v) => v.version)).toEqual(['2.0.0', '1.0.0'])
    expect(ext.versions[0]?.engineConstraint).toBe('>=99.0.0')
    expect(ext.versions[1]?.engineConstraint).toBe('>=0.13.0 <1.0.0')
  })

  it('drops a version without a VSIX asset but keeps the rest', () => {
    const noVsix: IRawGalleryVersion = {
      version: '3.0.0',
      files: [{ assetType: AssetType.Icon, source: 'https://host/icon.png' }],
    }
    const ext = parsed([noVsix, newIncompat, oldCompat])
    expect(ext.versions.map((v) => v.version)).toEqual(['2.0.0', '1.0.0'])
    expect(ext.version).toBe('2.0.0')
  })

  it('takes display assets from the newest installable version, not a dropped one', () => {
    const noVsix: IRawGalleryVersion = {
      version: '3.0.0',
      lastUpdated: '2026-03-01',
      files: [
        { assetType: AssetType.Icon, source: 'https://host/icon-3.0.0.png' },
        { assetType: AssetType.Details, source: 'https://host/readme-3.0.0.md' },
      ],
    }
    const installable: IRawGalleryVersion = {
      version: '2.0.0',
      lastUpdated: '2026-01-01',
      files: [
        { assetType: AssetType.Vsix, source: 'https://host/pkg-2.0.0.vsix' },
        { assetType: AssetType.Icon, source: 'https://host/icon-2.0.0.png' },
        { assetType: AssetType.Details, source: 'https://host/readme-2.0.0.md' },
      ],
    }
    const ext = parsed([noVsix, installable])
    expect(ext.version).toBe('2.0.0')
    expect(ext.iconUrl).toBe('https://host/icon-2.0.0.png')
    expect(ext.readmeUrl).toBe('https://host/readme-2.0.0.md')
    expect(ext.lastUpdated).toBe('2026-01-01')
  })

  it('carries per-version hash + signature into the versions array', () => {
    const signed: IRawGalleryVersion = {
      version: '1.0.0',
      files: [{ assetType: AssetType.Vsix, source: 'x' }],
      properties: [
        { key: 'Universe.Editor.VsixHash', value: 'ab12' },
        { key: 'Universe.Editor.VsixSignature', value: 'c2ln' },
        { key: 'Universe.Editor.SignatureKeyId', value: 'market-v1' },
      ],
    }
    const ext = parsed([signed])
    expect(ext.versions[0]?.vsixHash).toBe('ab12')
    expect(ext.versions[0]?.vsixSignature).toEqual({
      algorithm: 'ed25519',
      keyId: 'market-v1',
      value: 'c2ln',
    })
    expect(ext.vsixHash).toBe('ab12')
    expect(ext.vsixSignature?.keyId).toBe('market-v1')
  })

  describe('pickCompatibleVersion', () => {
    it('returns the newest version when it is itself compatible', () => {
      const compat: IRawGalleryVersion = {
        version: '2.0.0',
        files: [{ assetType: AssetType.Vsix, source: 'x' }],
        properties: [{ key: 'Universe.Editor.Engine', value: '^0.13.0' }],
      }
      expect(pickCompatibleVersion(parsed([compat, oldCompat]), '0.13.0')?.version).toBe('2.0.0')
    })

    it('falls back to an older compatible version when the newest is incompatible', () => {
      expect(pickCompatibleVersion(parsed([newIncompat, oldCompat]), '0.13.0')?.version).toBe(
        '1.0.0',
      )
    })

    it('treats a version without an engine constraint as compatible (fail-open)', () => {
      expect(pickCompatibleVersion(parsed([newIncompat, noEngine]), '0.13.0')?.version).toBe(
        '0.5.0',
      )
    })

    it('returns undefined when no version is compatible', () => {
      expect(pickCompatibleVersion(parsed([newIncompat]), '0.13.0')).toBeUndefined()
    })
  })
})
