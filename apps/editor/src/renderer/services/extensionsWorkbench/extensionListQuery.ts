/*---------------------------------------------------------------------------------------------
 *  扩展列表查询解析（对齐 VSCode extensionsViews.ts 的 filterLocal 语义子集）：
 *  含 `@builtin` 时列出内置扩展（默认列表只含用户安装的扩展），其余文本按
 *  id / displayName / description 过滤本地列表。
 *--------------------------------------------------------------------------------------------*/

import type { IExtensionEntry } from './ExtensionsWorkbenchService.js'

export interface IExtensionListQuery {
  /** `@builtin` 查询：列出内置扩展而非用户安装的扩展。 */
  readonly builtin: boolean
  /** 去掉 `@xxx` 标记后的过滤文本（小写）；空串表示不过滤。 */
  readonly text: string
}

export function parseExtensionListQuery(value: string): IExtensionListQuery {
  const builtin = /@builtin/i.test(value)
  const text = value
    .replaceAll(/@builtin/gi, '')
    .trim()
    .toLowerCase()
  return { builtin, text }
}

export function filterExtensionEntries(
  entries: readonly IExtensionEntry[],
  query: IExtensionListQuery,
): IExtensionEntry[] {
  const pool = entries.filter((e) => (query.builtin ? e.isBuiltin : !e.isBuiltin))
  if (!query.text) return pool
  return pool.filter(
    (e) =>
      e.id.toLowerCase().includes(query.text) ||
      e.displayName.toLowerCase().includes(query.text) ||
      e.description.toLowerCase().includes(query.text),
  )
}
