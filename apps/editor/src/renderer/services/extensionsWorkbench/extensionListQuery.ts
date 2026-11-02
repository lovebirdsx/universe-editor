/*---------------------------------------------------------------------------------------------
 *  扩展列表查询解析（对齐 VSCode extensionsViews.ts 的 filterLocal 语义子集）：
 *  含 `@builtin` 时列出内置扩展（默认列表只含用户安装的扩展），含 `@updates`
 *  （别名 `@outdated`）时只列出有更新可用的已装扩展，其余文本按 id /
 *  displayName / description 过滤本地列表。
 *--------------------------------------------------------------------------------------------*/

import type { IExtensionEntry } from './ExtensionsWorkbenchService.js'

export interface IExtensionListQuery {
  /** `@builtin` 查询：列出内置扩展而非用户安装的扩展。 */
  readonly builtin: boolean
  /** `@updates` 查询：只列出有更新可用的已装扩展。 */
  readonly outdated: boolean
  /** 去掉 `@xxx` 标记后的过滤文本（小写）；空串表示不过滤。 */
  readonly text: string
}

export type ExtensionListFilter = 'builtin' | 'updates'

const BUILTIN_TOKEN = /@builtin/i
// VSCode's user-facing filter is `@updates`; `@outdated` is accepted as an alias.
const UPDATES_TOKEN = /@(updates|outdated)\b/i

export function parseExtensionListQuery(value: string): IExtensionListQuery {
  const builtin = BUILTIN_TOKEN.test(value)
  const outdated = UPDATES_TOKEN.test(value)
  const text = value
    .replaceAll(/@builtin/gi, '')
    .replaceAll(/@(updates|outdated)\b/gi, '')
    .trim()
    .toLowerCase()
  return { builtin, outdated, text }
}

/**
 * Toggle one filter token while keeping the query the single source of truth.
 * Tokens are re-emitted first in a fixed order so the search box stays readable
 * when the menu toggles them; the user's remaining text is preserved.
 */
export function toggleExtensionListFilter(value: string, filter: ExtensionListFilter): string {
  const parsed = parseExtensionListQuery(value)
  const builtin = filter === 'builtin' ? !parsed.builtin : parsed.builtin
  const outdated = filter === 'updates' ? !parsed.outdated : parsed.outdated
  const text = value
    .replaceAll(/@builtin/gi, ' ')
    .replaceAll(/@(updates|outdated)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [builtin ? '@builtin' : '', outdated ? '@updates' : '', text].filter(Boolean).join(' ')
}

export function filterExtensionEntries(
  entries: readonly IExtensionEntry[],
  query: IExtensionListQuery,
): IExtensionEntry[] {
  let pool = entries.filter((e) => (query.builtin ? e.isBuiltin : !e.isBuiltin))
  if (query.outdated) pool = pool.filter((e) => e.installed && e.outdated)
  if (!query.text) return pool
  return pool.filter(
    (e) =>
      e.id.toLowerCase().includes(query.text) ||
      e.displayName.toLowerCase().includes(query.text) ||
      e.description.toLowerCase().includes(query.text),
  )
}
