/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  streamMapping — pure helpers for the cross-stream half of "Apply to Local":
 *  normalize a p4 stream spec, rewrite a depot path from the review stream to
 *  the current client stream, and classify a failed `p4 unshelve -S` so the
 *  caller knows whether a per-file retry or the print fallback is the right
 *  next step. No p4 I/O here.
 *--------------------------------------------------------------------------------------------*/

/** Normalize a p4 stream spec to `//depot/...`. Returns undefined for an
 *  empty/invalid spec — a guessed stream prefix must never reach p4. */
export function normalizeStreamSpec(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let spec = raw.trim()
  if (!spec) return undefined
  if (!spec.startsWith('//')) spec = `//${spec}`
  spec = spec.replace(/\/+$/, '')
  // Depot paths can contain spaces; only revision/change/wildcard specifiers
  // would turn a stream name into something p4 could interpret differently.
  if (!/^\/\/[^@#%*]+$/.test(spec)) return undefined
  const segments = spec.slice(2).split('/')
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '...')
  ) {
    return undefined
  }
  return spec
}

/**
 * Rewrite a review-stream depot path to the same relative path under the
 * client's stream. Undefined means "no safe mapping": the file is not under the
 * review stream, the streams are equal, or either spec is unusable. Callers must
 * still verify the result with `p4 where` before writing anything.
 */
export function mapDepotAcrossStreams(
  depotFile: string,
  reviewStream: string,
  clientStream: string,
): string | undefined {
  const review = normalizeStreamSpec(reviewStream)
  const client = normalizeStreamSpec(clientStream)
  if (!review || !client || review === client) return undefined
  const prefix = `${review}/`
  if (!depotFile.startsWith(prefix)) return undefined
  const relative = depotFile.slice(prefix.length)
  return relative ? `${client}/${relative}` : undefined
}

export type UnshelveFailureKind = 'committed' | 'stream-unsupported' | 'stream-relation' | 'other'

/** Classify a failed cross-stream `p4 unshelve`. `committed` and
 *  `stream-unsupported` fail identically for every file, so the group can go
 *  straight to the print fallback; everything else (including a refused stream
 *  relationship) may be per-file after a partial batch, so the caller retries
 *  individually and falls back only for the files that still fail. */
export function classifyUnshelveFailure(stderr: string): UnshelveFailureKind {
  const text = stderr.toLowerCase()
  if (text.includes('already committed')) return 'committed'
  if (
    text.includes('unknown option') ||
    text.includes('not a stream client') ||
    text.includes('requires a stream') ||
    text.includes('streams are not enabled') ||
    text.includes('invalid stream') ||
    text.includes('no such stream')
  ) {
    return 'stream-unsupported'
  }
  if (text.includes('not in client view') || text.includes('not under client')) {
    return 'stream-relation'
  }
  return 'other'
}
