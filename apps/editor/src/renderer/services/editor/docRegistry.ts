/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  docRegistry — an in-memory cache of the user-facing guide documents from
 *  docs/user/<locale>/. The markdown lives on disk beside the app (shipped as
 *  plain files, not inlined into the bundle); the renderer reads the whole set
 *  once via IDocsService during bootstrap and calls initDocRegistry() to populate
 *  this cache. All lookups below are synchronous reads of that cache, so the
 *  EditorInput contracts (getName / deserialize) stay synchronous. DocId is the
 *  locale-relative path without the .md suffix (e.g. "getting-started/interface-tour",
 *  "index").
 *--------------------------------------------------------------------------------------------*/

import type { SupportedLocale } from '../../../shared/i18n/availableLocales.js'
import { getCurrentLocale, SUPPORTED_LOCALES } from '../../../shared/i18n/availableLocales.js'
import type { DocsByLocale } from '../../../shared/ipc/docsService.js'

// The locale whose docs are the source of truth: any doc missing in the active
// locale falls back to this one so the guide is never a dead end while other
// locales are still being translated.
const FALLBACK_LOCALE: SupportedLocale = 'zh-CN'

const REGISTRIES: Record<SupportedLocale, Map<string, string>> = {
  'zh-CN': new Map(),
  'en-US': new Map(),
}

/**
 * Populate the cache from the disk-loaded document set (fetched via IDocsService
 * at bootstrap). Called once before React mounts, so every synchronous lookup
 * below — including tab deserialization — sees the docs.
 */
export function initDocRegistry(docs: DocsByLocale): void {
  for (const locale of SUPPORTED_LOCALES) {
    const map = REGISTRIES[locale]
    map.clear()
    const entries = docs[locale]
    if (!entries) continue
    for (const [docId, content] of Object.entries(entries)) {
      map.set(docId, content)
    }
  }
}

/**
 * A resolved document: its markdown content plus the locale it actually came
 * from. When `locale` differs from the active display language, the content is
 * a fallback (that locale's version isn't translated yet).
 */
export interface IResolvedDoc {
  readonly content: string
  readonly locale: SupportedLocale
}

/** Resolve a docId to its content and source locale, falling back when needed. */
export function resolveDoc(docId: string): IResolvedDoc | undefined {
  const locale = getCurrentLocale()
  const own = REGISTRIES[locale].get(docId)
  if (own !== undefined) return { content: own, locale }
  if (locale !== FALLBACK_LOCALE) {
    const fallback = REGISTRIES[FALLBACK_LOCALE].get(docId)
    if (fallback !== undefined) return { content: fallback, locale: FALLBACK_LOCALE }
  }
  return undefined
}

/** Get the raw markdown content for a docId in the current locale (fallback: zh-CN). */
export function getDocContent(docId: string): string | undefined {
  return resolveDoc(docId)?.content
}

/** Extract the first H1 heading from a markdown string. */
export function extractH1(content: string): string | undefined {
  const m = /^#[ \t]+(.+)$/m.exec(content)
  return m?.[1]?.trim()
}

/** Return the display title for a docId (H1 of its content, or the docId itself). */
export function getDocTitle(docId: string): string {
  const content = getDocContent(docId)
  return (content && extractH1(content)) ?? docId
}

/** True when the value is a known docId in the current locale (or zh-CN fallback). */
export function isDocId(value: unknown): value is string {
  return typeof value === 'string' && getDocContent(value) !== undefined
}
