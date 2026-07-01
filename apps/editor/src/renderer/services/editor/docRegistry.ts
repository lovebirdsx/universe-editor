/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  docRegistry — loads the user-facing guide documents from docs/user/<locale>/ via
 *  Vite's import.meta.glob (eager, ?raw). No runtime disk read; all content is
 *  bundled at build time. DocId is the locale-relative path without the .md suffix
 *  (e.g. "getting-started/editor-guide", "index").
 *--------------------------------------------------------------------------------------------*/

import type { SupportedLocale } from '../../../shared/i18n/availableLocales.js'
import { getCurrentLocale } from '../../../shared/i18n/availableLocales.js'

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

const ZH_REGISTRY = buildRegistry(zhRaw, 'zh-CN')
const EN_REGISTRY = buildRegistry(enRaw, 'en-US')

/** Get the raw markdown content for a docId in the current locale (fallback: zh-CN). */
export function getDocContent(docId: string): string | undefined {
  const locale = getCurrentLocale()
  return (locale === 'zh-CN' ? ZH_REGISTRY : EN_REGISTRY).get(docId) ?? ZH_REGISTRY.get(docId)
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
