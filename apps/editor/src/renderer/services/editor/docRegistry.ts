/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  docRegistry — loads the user-facing guide documents from docs/user/<locale>/ via
 *  Vite's import.meta.glob (eager, ?raw). No runtime disk read; all content is
 *  bundled at build time. DocId is the locale-relative path without the .md suffix
 *  (e.g. "getting-started/interface-tour", "index").
 *--------------------------------------------------------------------------------------------*/

import type { SupportedLocale } from '../../../shared/i18n/availableLocales.js'
import { getCurrentLocale } from '../../../shared/i18n/availableLocales.js'

// The locale whose docs are the source of truth: any doc missing in the active
// locale falls back to this one so the guide is never a dead end while other
// locales are still being translated.
const FALLBACK_LOCALE: SupportedLocale = 'zh-CN'

// Eager glob: bundled at build time. Paths are relative to this module's location.
// This file is at apps/editor/src/renderer/services/editor/, so 6 levels up reaches
// the repository root (universe-editor/), then into docs/user/.
// The _template.md at docs/user/ root is NOT inside zh-CN/ or en-US/, so it's
// never picked up by either glob.
const zhRaw = import.meta.glob('../../../../../../docs/user/zh-CN/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const enRaw = import.meta.glob('../../../../../../docs/user/en-US/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function buildRegistry(raw: Record<string, string>, locale: SupportedLocale): Map<string, string> {
  const marker = `/docs/user/${locale}/`
  const map = new Map<string, string>()
  for (const [key, content] of Object.entries(raw)) {
    const idx = key.indexOf(marker)
    if (idx === -1) continue
    const docId = key.slice(idx + marker.length).replace(/\.md$/, '')
    map.set(docId, content)
  }
  return map
}

const REGISTRIES: Record<SupportedLocale, Map<string, string>> = {
  'zh-CN': buildRegistry(zhRaw, 'zh-CN'),
  'en-US': buildRegistry(enRaw, 'en-US'),
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
