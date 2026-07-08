import { describe, expect, it } from 'vitest'
import {
  buildQuery,
  parseQueryResult,
  pickVsixAsset,
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
})
