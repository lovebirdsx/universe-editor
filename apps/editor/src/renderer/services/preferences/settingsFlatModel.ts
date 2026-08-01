/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Flat render model for the virtualized settings list: registry nodes plus an
 *  optional search ranking collapse into one array of group headers and rows,
 *  which the VirtualList consumes directly. Group counts follow the search
 *  filter (VSCode behavior): with an active query, zero-hit groups vanish.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationNode, IConfigurationPropertySchema } from '@universe-editor/platform'
import { isScalarSchema } from './settingsKeys.js'
import type { RankedSetting } from './settingsSearchModel.js'

export type SettingsFlatItem =
  | { readonly kind: 'header'; readonly id: string; readonly title: string; readonly count: number }
  | {
      readonly kind: 'row'
      readonly key: string
      readonly schema: IConfigurationPropertySchema
      readonly groupId: string
    }

export interface SettingsFlatModel {
  readonly items: readonly SettingsFlatItem[]
  /** Estimated pixel offset of each header item, aligned with `headerIndexes`. */
  readonly headerOffsets: readonly number[]
  /** Index into `items` of each header, in document order. */
  readonly headerIndexes: readonly number[]
}

export const SETTINGS_HEADER_HEIGHT = 36
export const SETTINGS_ROW_HEIGHT_WITH_DESC = 96
export const SETTINGS_ROW_HEIGHT_NO_DESC = 60

export function estimateFlatItemSize(item: SettingsFlatItem): number {
  if (item.kind === 'header') return SETTINGS_HEADER_HEIGHT
  return item.schema.description ? SETTINGS_ROW_HEIGHT_WITH_DESC : SETTINGS_ROW_HEIGHT_NO_DESC
}

/**
 * Build the flat model. `ranked` (from filterAndRankSettings) restricts which
 * keys appear and reorders them within their group by score; when omitted all
 * scalar keys render in registration order.
 */
export function buildFlatModel(
  nodes: readonly IConfigurationNode[],
  ranked?: readonly RankedSetting[],
): SettingsFlatModel {
  const rankByKey = ranked ? new Map(ranked.map((r, i) => [r.key, i] as const)) : undefined

  const items: SettingsFlatItem[] = []
  const headerOffsets: number[] = []
  const headerIndexes: number[] = []
  let offset = 0

  for (const node of nodes) {
    let keys = Object.keys(node.properties).filter((k) => isScalarSchema(node.properties[k]!))
    if (rankByKey) {
      keys = keys
        .filter((k) => rankByKey.has(k))
        .sort((a, b) => rankByKey.get(a)! - rankByKey.get(b)!)
    }
    if (keys.length === 0) continue

    headerIndexes.push(items.length)
    headerOffsets.push(offset)
    const header: SettingsFlatItem = {
      kind: 'header',
      id: node.id,
      title: node.title ?? node.id,
      count: keys.length,
    }
    items.push(header)
    offset += estimateFlatItemSize(header)

    for (const key of keys) {
      const row: SettingsFlatItem = {
        kind: 'row',
        key,
        schema: node.properties[key]!,
        groupId: node.id,
      }
      items.push(row)
      offset += estimateFlatItemSize(row)
    }
  }

  return { items, headerOffsets, headerIndexes }
}

export interface SettingsTocEntry {
  readonly id: string
  readonly title: string
  readonly count: number
  /** Index into the flat items array — navigation target for scrollToIndex. */
  readonly itemIndex: number
}

export function buildTocEntries(model: SettingsFlatModel): SettingsTocEntry[] {
  const entries: SettingsTocEntry[] = []
  for (const itemIndex of model.headerIndexes) {
    const header = model.items[itemIndex]
    if (header?.kind !== 'header') continue
    entries.push({ id: header.id, title: header.title, count: header.count, itemIndex })
  }
  return entries
}
