/**
 * Builds the `/extensionquery` POST body from high-level options. Pure — no IO.
 */
import {
  GalleryFilterType,
  GalleryFlags,
  GallerySortBy,
  GallerySortOrder,
  UNIVERSE_TARGET,
  type IQueryOptions,
  type IRawGalleryQuery,
  type IRawGalleryQueryCriterion,
} from './protocol.js'

const DEFAULT_PAGE_SIZE = 50

/** Flags requesting everything the client needs to render + install. */
const DEFAULT_FLAGS =
  GalleryFlags.IncludeVersions |
  GalleryFlags.IncludeFiles |
  GalleryFlags.IncludeVersionProperties |
  GalleryFlags.IncludeStatistics |
  GalleryFlags.IncludeLatestVersionOnly

export function buildQuery(options: IQueryOptions = {}): IRawGalleryQuery {
  const criteria: IRawGalleryQueryCriterion[] = [
    { filterType: GalleryFilterType.Target, value: UNIVERSE_TARGET },
  ]

  if (options.text) {
    criteria.push({ filterType: GalleryFilterType.SearchText, value: options.text })
  }
  for (const name of options.names ?? []) {
    criteria.push({ filterType: GalleryFilterType.ExtensionName, value: name })
  }
  if (options.category) {
    criteria.push({ filterType: GalleryFilterType.Category, value: options.category })
  }

  return {
    filters: [
      {
        criteria,
        pageNumber: options.pageNumber ?? 1,
        pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
        sortBy: options.sortBy ?? GallerySortBy.Relevance,
        sortOrder: options.sortOrder ?? GallerySortOrder.Default,
      },
    ],
    flags: DEFAULT_FLAGS,
  }
}
