/**
 * `/extensionquery` protocol types + our internal gallery domain model. Split
 * from the codec (`query.ts` / `parse.ts`) so consumers import just the shapes.
 *
 * The wire types mirror the VSCode Marketplace / open-vsx `3.0-preview.1` schema.
 * We keep only the fields the client actually reads.
 */

/** How to sort query results (mirrors VSCode's SortBy). */
export enum GallerySortBy {
  Relevance = 0,
  InstallCount = 4,
  Rating = 6,
  Updated = 10,
}

export enum GallerySortOrder {
  Default = 0,
  Ascending = 1,
  Descending = 2,
}

/** Criteria filter types (subset we send/understand). */
export enum GalleryFilterType {
  ExtensionName = 7,
  Target = 8,
  SearchText = 10,
  ExcludeWithFlags = 12,
  Category = 5,
}

/** Response-enrichment flags, OR'd together into the query `flags` field. */
export enum GalleryFlags {
  IncludeVersions = 0x1,
  IncludeFiles = 0x2,
  IncludeVersionProperties = 0x10,
  IncludeStatistics = 0x100,
  IncludeLatestVersionOnly = 0x200,
}

/** Target product identifier we send (backend should also accept VSCode's). */
export const UNIVERSE_TARGET = 'Universe.Editor'

/** Asset types on a version's `files[]` (VSCode-compatible names + our aliases). */
export const AssetType = {
  Vsix: 'Microsoft.VisualStudio.Services.VSIXPackage',
  Icon: 'Microsoft.VisualStudio.Services.Icons.Default',
  Details: 'Microsoft.VisualStudio.Services.Content.Details',
  Changelog: 'Microsoft.VisualStudio.Services.Content.Changelog',
} as const

/** Engine-constraint property keys we read (VSCode's + ours). */
export const ENGINE_PROPERTY_KEYS = [
  'Universe.Editor.Engine',
  'Microsoft.VisualStudio.Code.Engine',
] as const

// --- Wire request ---------------------------------------------------------

export interface IRawGalleryQueryCriterion {
  filterType: number
  value: string
}

export interface IRawGalleryQueryFilter {
  criteria: IRawGalleryQueryCriterion[]
  pageNumber: number
  pageSize: number
  sortBy: number
  sortOrder: number
}

export interface IRawGalleryQuery {
  filters: IRawGalleryQueryFilter[]
  flags: number
}

// --- Wire response --------------------------------------------------------

export interface IRawGalleryFile {
  assetType: string
  source: string
}

export interface IRawGalleryProperty {
  key: string
  value: string
}

export interface IRawGalleryVersion {
  version: string
  lastUpdated?: string
  assetUri?: string
  fallbackAssetUri?: string
  files?: IRawGalleryFile[]
  properties?: IRawGalleryProperty[]
}

export interface IRawGalleryPublisher {
  publisherName: string
  displayName?: string
}

export interface IRawGalleryStatistic {
  statisticName: string
  value: number
}

export interface IRawGalleryExtension {
  extensionId?: string
  extensionName: string
  displayName?: string
  shortDescription?: string
  publisher: IRawGalleryPublisher
  versions?: IRawGalleryVersion[]
  statistics?: IRawGalleryStatistic[]
  categories?: string[]
}

export interface IRawGalleryResultMetadataItem {
  name: string
  count: number
}

export interface IRawGalleryResultMetadata {
  metadataType: string
  metadataItems: IRawGalleryResultMetadataItem[]
}

export interface IRawGalleryQueryResult {
  results: {
    extensions?: IRawGalleryExtension[]
    resultMetadata?: IRawGalleryResultMetadata[]
  }[]
}

// --- Internal domain model ------------------------------------------------

/** A gallery extension in the client's own shape (protocol details resolved). */
export interface IGalleryExtension {
  readonly identifier: string
  readonly uuid?: string
  readonly name: string
  readonly displayName: string
  readonly publisher: string
  readonly publisherDisplayName?: string
  readonly version: string
  readonly description: string
  readonly vsixUrl: string
  readonly iconUrl?: string
  readonly readmeUrl?: string
  readonly changelogUrl?: string
  readonly engineConstraint?: string
  readonly installCount?: number
  readonly rating?: number
  readonly ratingCount?: number
  readonly lastUpdated?: string
  readonly categories?: string[]
}

/** Parsed `/extensionquery` result: extensions + total count for pagination. */
export interface IGalleryQueryResult {
  readonly extensions: IGalleryExtension[]
  readonly total: number
}

/** Options accepted by {@link buildQuery}. */
export interface IQueryOptions {
  /** Free-text search term. Omit to list (e.g. by category) without a term. */
  readonly text?: string
  /** Exact `publisher.name` ids to fetch (install / update-check path). */
  readonly names?: string[]
  /** Category filter. */
  readonly category?: string
  readonly pageNumber?: number
  readonly pageSize?: number
  readonly sortBy?: GallerySortBy
  readonly sortOrder?: GallerySortOrder
}
