/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Release-notes link policy — the single source shared by the build-time compiler
 *  (scripts/release/release-notes/, which reads linkPolicy.json with node:fs) and the
 *  renderer guard (ReleaseNotesEditor). Version notes may only link to bundled user
 *  docs (`doc:<docId>`), a small allowlist of side-effect-free navigation commands
 *  (`command:<commandId>`), public http(s) pages, and in-page anchors. Everything
 *  else is rejected — never resolved as a file path, never handed to window.open.
 *--------------------------------------------------------------------------------------------*/

import policyJson from './linkPolicy.json' with { type: 'json' }

export interface IReleaseNotesLinkPolicy {
  readonly schema: number
  /** Public repository base; hard-coded so forks/CI produce byte-identical output. */
  readonly publicRepoBase: string
  readonly docScheme: string
  readonly commandScheme: string
  readonly allowedExternalSchemes: readonly string[]
  readonly docsRoot: string
  readonly docsLocale: string
  /** Path template appended to `publicRepoBase` for out-of-app doc links. */
  readonly docBlobPathTemplate: string
  readonly docIdPattern: string
  readonly maxDocIdLength: number
  readonly allowedCommandIds: readonly string[]
}

export const RELEASE_NOTES_LINK_POLICY: IReleaseNotesLinkPolicy = policyJson

export type ReleaseNoteHrefKind =
  | { readonly kind: 'anchor'; readonly anchor: string }
  | { readonly kind: 'doc'; readonly docId: string }
  | { readonly kind: 'command'; readonly commandId: string }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Schemes the markdown parser must accept for release notes (`doc:` / `command:`). */
export function releaseNoteHrefSchemes(): readonly string[] {
  return [RELEASE_NOTES_LINK_POLICY.docScheme, RELEASE_NOTES_LINK_POLICY.commandScheme]
}

/**
 * docIds are locale-relative paths: no leading/trailing slash, no `.`/`..` segment,
 * no `_`-prefixed file (never a docId), no percent-encoding or backslash escape.
 */
export function isValidReleaseNoteDocId(docId: string): boolean {
  const policy = RELEASE_NOTES_LINK_POLICY
  if (docId.length === 0 || docId.length > policy.maxDocIdLength) return false
  if (!new RegExp(policy.docIdPattern).test(docId)) return false
  if (docId.endsWith('/') || docId.includes('//') || docId.includes('\\')) return false
  return docId
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..' && !segment.startsWith('_'),
    )
}

export function isReleaseNoteCommandAllowed(commandId: string): boolean {
  return RELEASE_NOTES_LINK_POLICY.allowedCommandIds.includes(commandId)
}

/** Public (GitHub blob) URL for a doc that this install does not bundle. */
export function releaseNoteDocUrl(version: string, docId: string): string {
  const policy = RELEASE_NOTES_LINK_POLICY
  const path = policy.docBlobPathTemplate
    .replace('{version}', version)
    .replace('{locale}', policy.docsLocale)
    .replace('{docId}', docId)
  return `${policy.publicRepoBase}${path}`
}

export function classifyReleaseNoteHref(href: string): ReleaseNoteHrefKind {
  const policy = RELEASE_NOTES_LINK_POLICY
  const value = href.trim()
  if (value.length === 0) return { kind: 'invalid', reason: '空链接' }
  if (value.startsWith('#')) {
    return value.length > 1
      ? { kind: 'anchor', anchor: value.slice(1) }
      : { kind: 'invalid', reason: '空锚点' }
  }
  const docPrefix = `${policy.docScheme}:`
  if (value.startsWith(docPrefix)) {
    const docId = value.slice(docPrefix.length)
    return isValidReleaseNoteDocId(docId)
      ? { kind: 'doc', docId }
      : { kind: 'invalid', reason: `非法的文档 id：${docId}` }
  }
  const commandPrefix = `${policy.commandScheme}:`
  if (value.startsWith(commandPrefix)) {
    const commandId = value.slice(commandPrefix.length)
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(commandId)) {
      return { kind: 'invalid', reason: `非法的命令 id：${commandId}` }
    }
    return isReleaseNoteCommandAllowed(commandId)
      ? { kind: 'command', commandId }
      : { kind: 'invalid', reason: `命令不在允许清单内：${commandId}` }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  if (scheme !== undefined) {
    const allowed = policy.allowedExternalSchemes.includes(scheme)
    if (!allowed) return { kind: 'invalid', reason: `不允许的链接协议：${scheme}:` }
    if (!/^https?:\/\/[^\s]+$/i.test(value))
      return { kind: 'invalid', reason: `非法链接：${value}` }
    return { kind: 'external', url: value }
  }
  // Relative/bare paths are not part of the release-notes surface: a doc reference
  // must say so explicitly (`doc:`), so nothing silently resolves to a file.
  return { kind: 'invalid', reason: `相对路径链接不受支持（请用 doc: 指向文档）：${value}` }
}
