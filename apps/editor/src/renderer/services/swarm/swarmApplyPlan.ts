/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  planApplyToLocal — pure classification of a review version's files for the
 *  "Apply to Local" command: which mapped depot files to send, which mapped
 *  files get skipped because they live outside the workspace (unless the user
 *  opted in), which files aren't mapped into the client at all, and the union
 *  the forced cross-stream path may attempt. Pure so dialog wording, request
 *  shape and stream resolution are unit-testable without React.
 *--------------------------------------------------------------------------------------------*/

import type { SwarmReviewDetailDto, SwarmReviewFileDto } from '@universe-editor/extensions-common'

export interface ApplyPlan {
  /** Mapped files selected by the `includeOutside` toggle, in input order. */
  readonly mappedFiles: SwarmReviewFileDto[]
  /** Files with `localPath === null` (not mapped in the client view), in input
   *  order — only the forced cross-stream path may attempt them. */
  readonly unmappedFiles: SwarmReviewFileDto[]
  /** `mappedFiles` + `unmappedFiles` in the ORIGINAL input order: the file set
   *  a forced apply sends to the host. */
  readonly forceFiles: SwarmReviewFileDto[]
  /** Depot paths of {@link mappedFiles}. */
  readonly depotFiles: string[]
  /** Display paths of mapped files skipped because they are outside the
   *  workspace and the toggle is off. */
  readonly outsidePaths: string[]
  /** Display paths of {@link unmappedFiles}. */
  readonly unmappedPaths: string[]
}

export function planApplyToLocal(
  files: readonly SwarmReviewFileDto[],
  includeOutside: boolean,
  isInWorkspace: (fsPath: string) => boolean,
): ApplyPlan {
  const mappedFiles: SwarmReviewFileDto[] = []
  const unmappedFiles: SwarmReviewFileDto[] = []
  const outsidePaths: string[] = []
  const selectedDepotFiles = new Set<string>()
  for (const file of files) {
    if (file.localPath === null) {
      unmappedFiles.push(file)
      selectedDepotFiles.add(file.depotFile)
      continue
    }
    if (!includeOutside && !isInWorkspace(file.localPath)) {
      outsidePaths.push(file.path)
      continue
    }
    mappedFiles.push(file)
    selectedDepotFiles.add(file.depotFile)
  }
  return {
    mappedFiles,
    unmappedFiles,
    forceFiles: files.filter((file) => selectedDepotFiles.has(file.depotFile)),
    depotFiles: mappedFiles.map((file) => file.depotFile),
    outsidePaths,
    unmappedPaths: unmappedFiles.map((file) => file.path),
  }
}

/** Normalize a Swarm stream for the apply request: always `//depot/...`.
 *  Mirrors the host's `normalizeStreamSpec` (including the rejection rules) so
 *  a spec the host would refuse never gets advertised as force-applicable. */
export function normalizeSwarmStream(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let stream = raw.trim()
  if (!stream) return undefined
  if (!stream.startsWith('//')) stream = `//${stream}`
  stream = stream.replace(/\/+$/, '')
  if (!/^\/\/[^@#%*]+$/.test(stream)) return undefined
  const segments = stream.slice(2).split('/')
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '...')
  ) {
    return undefined
  }
  return stream
}

/**
 * The stream the selected version targets. `detail.stream` is derived from the
 * LAST version that carries one, so it must not stand in for an older version
 * that has none: only when EVERY version is stream-less is the detail-level
 * value the review's stream.
 */
export function resolveReviewStream(
  detail: Pick<SwarmReviewDetailDto, 'stream' | 'versions'> | null | undefined,
  versionIdx: number | null,
): string | undefined {
  if (!detail || versionIdx === null) return undefined
  const versionStream = normalizeSwarmStream(detail.versions[versionIdx]?.stream)
  if (versionStream) return versionStream
  if (detail.versions.some((version) => normalizeSwarmStream(version.stream) !== undefined)) {
    return undefined
  }
  return normalizeSwarmStream(detail.stream)
}
