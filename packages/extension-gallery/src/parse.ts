/**
 * Parses a raw `/extensionquery` response into the client domain model. Pure — no
 * IO. Tolerant of missing fields: an extension whose latest version lacks a VSIX
 * asset is dropped (it can't be installed), everything else degrades gracefully.
 */
import {
  AssetType,
  ENGINE_PROPERTY_KEYS,
  type IGalleryExtension,
  type IGalleryQueryResult,
  type IRawGalleryExtension,
  type IRawGalleryFile,
  type IRawGalleryQueryResult,
  type IRawGalleryVersion,
} from './protocol.js'

/** The URL of a version's asset by type, or undefined if absent. */
export function pickAsset(version: IRawGalleryVersion, assetType: string): string | undefined {
  const file = version.files?.find((f: IRawGalleryFile) => f.assetType === assetType)
  return file?.source
}

/** The VSIX download URL for a version, or undefined if the package asset is absent. */
export function pickVsixAsset(version: IRawGalleryVersion): string | undefined {
  return pickAsset(version, AssetType.Vsix)
}

/** The `engines` constraint from a version's properties (VSCode or our key). */
export function readEngineConstraint(version: IRawGalleryVersion): string | undefined {
  for (const key of ENGINE_PROPERTY_KEYS) {
    const prop = version.properties?.find((p) => p.key === key)
    if (prop && prop.value) return prop.value
  }
  return undefined
}

function statistic(raw: IRawGalleryExtension, name: string): number | undefined {
  const stat = raw.statistics?.find((s) => s.statisticName === name)
  return stat?.value
}

/** Map one raw extension (using its first/latest version) to the domain model. */
function toGalleryExtension(raw: IRawGalleryExtension): IGalleryExtension | undefined {
  const version = raw.versions?.[0]
  if (!version) return undefined
  const vsixUrl = pickVsixAsset(version)
  if (!vsixUrl) return undefined // not installable — skip

  const publisher = raw.publisher.publisherName
  const name = raw.extensionName
  const identifier = `${publisher}.${name}`

  const iconUrl = pickAsset(version, AssetType.Icon)
  const readmeUrl = pickAsset(version, AssetType.Details)
  const changelogUrl = pickAsset(version, AssetType.Changelog)
  const engineConstraint = readEngineConstraint(version)
  const installCount = statistic(raw, 'install')
  const rating = statistic(raw, 'averagerating')
  const ratingCount = statistic(raw, 'ratingcount')

  return {
    identifier,
    name,
    publisher,
    displayName: raw.displayName ?? name,
    description: raw.shortDescription ?? '',
    version: version.version,
    vsixUrl,
    ...(raw.extensionId ? { uuid: raw.extensionId } : {}),
    ...(raw.publisher.displayName ? { publisherDisplayName: raw.publisher.displayName } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(readmeUrl ? { readmeUrl } : {}),
    ...(changelogUrl ? { changelogUrl } : {}),
    ...(engineConstraint ? { engineConstraint } : {}),
    ...(installCount !== undefined ? { installCount } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(ratingCount !== undefined ? { ratingCount } : {}),
    ...(version.lastUpdated ? { lastUpdated: version.lastUpdated } : {}),
    ...(raw.categories ? { categories: raw.categories } : {}),
  }
}

/** Parse a `/extensionquery` response into extensions + total count. */
export function parseQueryResult(raw: IRawGalleryQueryResult): IGalleryQueryResult {
  const result = raw.results?.[0]
  const extensions = (result?.extensions ?? [])
    .map(toGalleryExtension)
    .filter((e): e is IGalleryExtension => e !== undefined)

  const totalItem = result?.resultMetadata
    ?.find((m) => m.metadataType === 'ResultCount')
    ?.metadataItems.find((i) => i.name === 'TotalCount')
  const total = totalItem?.count ?? extensions.length

  return { extensions, total }
}
