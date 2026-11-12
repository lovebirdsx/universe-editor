/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Turns the structured refs a phone sends with `sendPrompt` into the desktop
 *  `PlacedRef[]` the ACP session already understands. The phone only echoed back
 *  suggestions this window produced, so every field is re-validated here: file
 *  paths are rebuilt from the session-scope root (never trusted as a URI),
 *  workspace refs must stay inside that root, and docs must point into a real
 *  docs directory. A failed check rejects the whole prompt instead of silently
 *  dropping a ref the user believes they attached.
 *--------------------------------------------------------------------------------------------*/

import { URI, type IUriIdentityService } from '@universe-editor/platform'
import {
  isValidCommitHash,
  promptRefPrefix,
  type MobilePromptRef,
} from '@universe-editor/mobile-protocol'
import type { ContextSuggestionItem } from '../acp/contextSuggestions.js'
import { commitRefFromParts } from '../acp/commitRef.js'
import {
  chatContextItemToRef,
  mentionEntryToRef,
  suggestionItemToRef,
  type PlacedRef,
  type PromptRef,
} from '../acp/promptRef.js'

export interface MobilePromptRefContext {
  readonly mentionRoot: URI
  readonly uriIdentity: IUriIdentityService
  /** Native fs paths of the built-in docs roots (`user` / `extensionDev`). */
  readonly docsRoots: readonly string[]
  /** Workspace URIs of the open Git repos a `commit` ref may point at. */
  readonly commitRoots: readonly URI[]
}

export type MobilePromptRefResult =
  | { readonly ok: true; readonly value: readonly PlacedRef[] }
  | { readonly ok: false; readonly message: string }

function invalid(message: string): MobilePromptRefResult {
  return { ok: false, message }
}

function isSafeRelativePath(label: string): boolean {
  if (label.length === 0 || label.startsWith('/') || label.includes('\\')) return false
  if (/^[A-Za-z]:/.test(label)) return false
  return !label.split('/').some((segment) => segment === '..')
}

function sameSchemeAndAuthority(a: URI, b: URI): boolean {
  return a.scheme === b.scheme && a.authority === b.authority
}

function parseUri(value: string): URI | undefined {
  try {
    const uri = URI.parse(value)
    return uri.scheme ? uri : undefined
  } catch {
    return undefined
  }
}

function toContextItem(ref: MobilePromptRef): ContextSuggestionItem | undefined {
  const base = {
    label: ref.label,
    uri: ref.uri,
    description: ref.description ?? '',
    iconId: '',
  }
  switch (ref.kind) {
    case 'symbol':
      return {
        ...base,
        kind: 'symbol',
        description: ref.description ?? ref.uri,
        meta: {
          ...(ref.line !== undefined ? { line: ref.line } : {}),
          ...(ref.column !== undefined ? { column: ref.column } : {}),
          ...(ref.symbolKind !== undefined ? { symbolKind: ref.symbolKind } : {}),
        },
      }
    case 'scmChange':
      return {
        ...base,
        kind: 'scmChange',
        description: ref.scmStatus ?? ref.description ?? '',
        ...(ref.scmStatus !== undefined ? { meta: { scmStatus: ref.scmStatus } } : {}),
      }
    case 'openEditor':
      return { ...base, kind: 'openEditor' }
    default:
      return undefined
  }
}

function convertOne(
  ref: MobilePromptRef,
  context: MobilePromptRefContext,
): PromptRef | MobilePromptRefResult {
  if (ref.kind === 'file') {
    if (!isSafeRelativePath(ref.label)) return invalid('invalid file reference path')
    const uri = URI.joinPath(context.mentionRoot, ref.label)
    const claimed = parseUri(ref.uri)
    if (
      claimed === undefined ||
      context.uriIdentity.getComparisonKey(uri) !== context.uriIdentity.getComparisonKey(claimed)
    ) {
      return invalid('file reference does not match the session workspace')
    }
    return mentionEntryToRef({ uri: uri.toString(), relPath: ref.label }, 'file')
  }

  if (ref.kind === 'commit') {
    const commitHash = ref.commitHash
    if (commitHash === undefined || !isValidCommitHash(commitHash)) {
      return invalid('commit reference needs a valid hash')
    }
    const subject = ref.text
    if (subject === undefined || subject.length === 0) {
      return invalid('commit reference needs a subject')
    }
    const uri = parseUri(ref.uri)
    if (uri === undefined) return invalid('commit reference needs a repository uri')
    // The repo root may sit above the session directory (narrowed sessions), so
    // it is checked against the live Git roots instead of `mentionRoot`.
    const key = context.uriIdentity.getComparisonKey(uri)
    const known = context.commitRoots.some(
      (root) => context.uriIdentity.getComparisonKey(root) === key,
    )
    if (!known) return invalid('commit reference does not match an open repository')
    return commitRefFromParts({
      label: ref.label,
      uri: uri.toString(),
      commitHash,
      description: subject,
    })
  }

  if (ref.kind === 'chatContext') {
    if (ref.uri !== '') return invalid('chatContext reference must not name a resource')
    const text = ref.text
    if (text === undefined || text.length === 0) {
      return invalid('chatContext reference needs text')
    }
    return chatContextItemToRef({ label: ref.label, text })
  }

  if (ref.kind === 'docs') {
    const dirPath = ref.dirPath
    if (dirPath === undefined || dirPath.length === 0) return invalid('docs reference needs a path')
    const dirUri = URI.file(dirPath)
    const claimed = parseUri(ref.uri)
    if (
      claimed === undefined ||
      context.uriIdentity.getComparisonKey(dirUri) !== context.uriIdentity.getComparisonKey(claimed)
    ) {
      return invalid('docs reference does not match its directory')
    }
    const insideDocs = context.docsRoots.some((root) =>
      context.uriIdentity.isEqualOrParent(dirUri, URI.file(root)),
    )
    if (!insideDocs) return invalid('docs reference is outside the documentation roots')
    const item: ContextSuggestionItem = {
      kind: 'docs',
      label: ref.label,
      uri: dirUri.toString(),
      description: ref.description ?? '',
      iconId: '',
      meta: { dirPath },
    }
    return suggestionItemToRef(item)
  }

  const uri = parseUri(ref.uri)
  if (uri === undefined || !sameSchemeAndAuthority(uri, context.mentionRoot)) {
    return invalid('context reference is outside the workspace')
  }
  // The desktop `#` sources only offer workspace resources; enforce that here
  // too instead of trusting the echoed URI. `mentionRoot` is the session cwd
  // when the session is narrowed, so this also enforces the narrower scope.
  if (!context.uriIdentity.isEqualOrParent(uri, context.mentionRoot)) {
    return invalid('context reference is outside the session directory')
  }
  const item = toContextItem(ref)
  if (item === undefined) return invalid('unsupported reference kind')
  return suggestionItemToRef(item)
}

/**
 * Validate and convert every ref, then re-check the ranges against `text`.
 * Returns the placed refs sorted by offset so `composePromptBlocksFromRefs`
 * never has to reorder them.
 */
export function toPlacedMobileRefs(
  text: string,
  refs: readonly MobilePromptRef[],
  context: MobilePromptRefContext,
): MobilePromptRefResult {
  const sorted = [...refs].sort((a, b) => a.start - b.start)
  const placed: PlacedRef[] = []
  let previousEnd = 0
  for (const ref of sorted) {
    if (
      !Number.isInteger(ref.start) ||
      !Number.isInteger(ref.end) ||
      ref.start < previousEnd ||
      ref.end <= ref.start ||
      ref.end > text.length
    ) {
      return invalid('reference range is out of bounds')
    }
    if (text.slice(ref.start, ref.end) !== `${promptRefPrefix(ref.kind)}${ref.label}`) {
      return invalid('reference no longer matches the prompt text')
    }
    const converted = convertOne(ref, context)
    if ('ok' in converted) return converted
    placed.push({ ref: converted, start: ref.start, end: ref.end })
    previousEnd = ref.end
  }
  return { ok: true, value: placed }
}
