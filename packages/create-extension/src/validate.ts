/**
 * Id validation for scaffold answers. Rules mirror the marketplace side:
 * the extension id doubles as the vsix filename segment and the command-id
 * prefix, so keep it lowercase-url-safe.
 */

/** npm-name-ish: lowercase alnum start, then alnum/./_/-, ≤64 chars. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Publisher ids: lowercase alnum + dashes, ≤32 chars (marketplace rule). */
const PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Returns null when valid, else a human-readable reason. */
export function validateExtensionName(name: string): string | null {
  if (name === '') return 'name is required'
  if (name.length > 64) return 'name must be at most 64 characters'
  if (!NAME_PATTERN.test(name)) {
    return 'use lowercase letters, digits, dots, underscores and dashes, starting with a letter or digit'
  }
  if (name.includes('..')) return 'name must not contain consecutive dots'
  if (name.endsWith('.') || name.endsWith('-')) return 'name must not end with a dot or dash'
  return null
}

export function validatePublisher(publisher: string): string | null {
  if (publisher === '') return 'publisher is required'
  if (publisher.length > 32) return 'publisher must be at most 32 characters'
  if (!PUBLISHER_PATTERN.test(publisher)) {
    return 'use lowercase letters, digits and dashes, starting with a letter or digit'
  }
  return null
}
