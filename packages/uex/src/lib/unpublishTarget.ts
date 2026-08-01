/**
 * Parses `uex unpublish` targets: `publisher.name[@version]`. The id must be
 * fully qualified (`publisher.name`) so an accidental bare name can never
 * nuke the wrong extension.
 */
import { UexError } from '../errors.js'

export interface UnpublishTarget {
  readonly id: string
  /** null = remove the whole extension (all versions). */
  readonly version: string | null
}

export function parseUnpublishTarget(raw: string): UnpublishTarget {
  const at = raw.lastIndexOf('@')
  if (at === 0 || at === raw.length - 1) {
    throw new UexError(`invalid unpublish target "${raw}"`, [
      'use <publisher>.<name> for the whole extension, or <publisher>.<name>@<version> for one version',
    ])
  }
  const id = at === -1 ? raw : raw.slice(0, at)
  const version = at === -1 ? null : raw.slice(at + 1)
  if (!id.includes('.')) {
    throw new UexError(`extension id "${id}" is not fully qualified`, [
      'use the <publisher>.<name> form (e.g. acme.my-ext@1.0.0)',
    ])
  }
  return { id, version }
}
