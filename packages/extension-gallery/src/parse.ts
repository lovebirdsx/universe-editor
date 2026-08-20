/**
 * Parses a raw `/extensionquery` response into the client domain model. Pure — no
 * IO. Tolerant of missing fields: an extension whose latest version lacks a VSIX
 * asset is dropped (it can't be installed), everything else degrades gracefully.
 */
import { satisfies } from '@universe-editor/extensions-common'
import {
  AssetType,
  ENGINE_PROPERTY_KEYS,
  VSIX_HASH_PROPERTY_KEY,
  VSIX_SIGNATURE_KEY_ID_PROPERTY_KEY,
  VSIX_SIGNATURE_PROPERTY_KEY,
  type IGalleryExtension,
  type IGalleryExtensionVersion,
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

function readProperty(version: IRawGalleryVersion, key: string): string | undefined {
  const prop = version.properties?.find((p) => p.key === key)
  return prop && prop.value ? prop.value : undefined
}

function statistic(raw: IRawGalleryExtension, name: string): number | undefined {
  const stat = raw.statistics?.find((s) => s.statisticName === name)
  return stat?.value
}

/** Map one raw version to the version model, dropping it when it has no VSIX asset. */
function toGalleryVersion(version: IRawGalleryVersion): IGalleryExtensionVersion | undefined {
  const vsixUrl = pickVsixAsset(version)
  if (!vsixUrl) return undefined // not installable — skip

  const engineConstraint = readEngineConstraint(version)
  const vsixHash = readProperty(version, VSIX_HASH_PROPERTY_KEY)
  const signatureValue = readProperty(version, VSIX_SIGNATURE_PROPERTY_KEY)
  const signatureKeyId = readProperty(version, VSIX_SIGNATURE_KEY_ID_PROPERTY_KEY)
  // Only a complete signature pair is usable — a partial one is treated as unsigned.
  const vsixSignature =
    signatureValue && signatureKeyId
      ? { algorithm: 'ed25519', keyId: signatureKeyId, value: signatureValue }
      : undefined

  return {
    version: version.version,
    vsixUrl,
    ...(engineConstraint ? { engineConstraint } : {}),
    ...(vsixHash ? { vsixHash } : {}),
    ...(vsixSignature ? { vsixSignature } : {}),
  }
}

/** Map one raw extension to the domain model; the newest installable version drives the top-level fields. */
function toGalleryExtension(raw: IRawGalleryExtension): IGalleryExtension | undefined {
  // Pair each raw version with its parsed model so `latestRaw` (asset lookups)
  // stays aligned with `latest` when the newest raw version lacks a VSIX.
  const pairs = (raw.versions ?? [])
    .map((rawVersion) => ({ rawVersion, version: toGalleryVersion(rawVersion) }))
    .filter(
      (p): p is { rawVersion: IRawGalleryVersion; version: IGalleryExtensionVersion } =>
        p.version !== undefined,
    )
  if (pairs.length === 0) return undefined // not installable — skip

  const versions = pairs.map((p) => p.version)
  const latest = pairs[0]!.version
  const latestRaw = pairs[0]!.rawVersion

  const publisher = raw.publisher.publisherName
  const name = raw.extensionName
  const identifier = `${publisher}.${name}`

  const iconUrl = pickAsset(latestRaw, AssetType.Icon)
  const readmeUrl = pickAsset(latestRaw, AssetType.Details)
  const changelogUrl = pickAsset(latestRaw, AssetType.Changelog)
  const installCount = statistic(raw, 'install')
  const rating = statistic(raw, 'averagerating')
  const ratingCount = statistic(raw, 'ratingcount')

  return {
    identifier,
    name,
    publisher,
    displayName: raw.displayName ?? name,
    description: raw.shortDescription ?? '',
    versions,
    version: latest.version,
    vsixUrl: latest.vsixUrl,
    ...(raw.extensionId ? { uuid: raw.extensionId } : {}),
    ...(raw.publisher.displayName ? { publisherDisplayName: raw.publisher.displayName } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(readmeUrl ? { readmeUrl } : {}),
    ...(changelogUrl ? { changelogUrl } : {}),
    ...(latest.engineConstraint ? { engineConstraint: latest.engineConstraint } : {}),
    ...(latest.vsixHash ? { vsixHash: latest.vsixHash } : {}),
    ...(latest.vsixSignature ? { vsixSignature: latest.vsixSignature } : {}),
    ...(installCount !== undefined ? { installCount } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(ratingCount !== undefined ? { ratingCount } : {}),
    ...(latestRaw.lastUpdated ? { lastUpdated: latestRaw.lastUpdated } : {}),
    ...(raw.categories ? { categories: raw.categories } : {}),
  }
}

/**
 * Pick the newest version whose `engineConstraint` the host satisfies (versions
 * are newest-first). A version without an engine constraint is treated as
 * compatible — fail-open, matching how the load-time check reads a missing engine.
 * Returns undefined when no version is compatible.
 */
export function pickCompatibleVersion(
  ext: IGalleryExtension,
  hostVersion: string,
): IGalleryExtensionVersion | undefined {
  for (const version of ext.versions) {
    if (!version.engineConstraint || satisfies(hostVersion, version.engineConstraint)) {
      return version
    }
  }
  return undefined
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
