import { describe, expect, it } from 'vitest'
import type { IConfigurationNode } from '@universe-editor/platform'
import {
  SETTINGS_HEADER_HEIGHT,
  SETTINGS_ROW_HEIGHT_NO_DESC,
  SETTINGS_ROW_HEIGHT_WITH_DESC,
  buildFlatModel,
  buildTocEntries,
} from '../settingsFlatModel.js'
import type { RankedSetting } from '../settingsSearchModel.js'

const NODES: IConfigurationNode[] = [
  {
    id: 'editor',
    title: 'Editor',
    properties: {
      'editor.fontSize': { type: 'number', default: 14, description: 'Font size in pixels' },
      'editor.minimap.enabled': { type: 'boolean', default: true },
      // Non-scalar: must be dropped from the flat model.
      'editor.rulers': { type: 'array', default: [] },
    },
  },
  {
    id: 'files',
    title: 'Files',
    properties: {
      'files.autoSave': { type: 'string', default: 'off', enum: ['off', 'afterDelay'] },
    },
  },
  {
    id: 'empty',
    title: 'Empty',
    properties: {
      'empty.map': { type: 'object', default: {} },
    },
  },
]

describe('buildFlatModel', () => {
  it('flattens scalar settings under group headers, skipping non-scalar-only groups', () => {
    const model = buildFlatModel(NODES)
    expect(model.items.map((i) => i.kind)).toEqual(['header', 'row', 'row', 'header', 'row'])

    const [h1, r1, r2, h2, r3] = model.items
    expect(h1).toMatchObject({ kind: 'header', id: 'editor', title: 'Editor', count: 2 })
    expect(r1).toMatchObject({ kind: 'row', key: 'editor.fontSize', groupId: 'editor' })
    expect(r2).toMatchObject({ kind: 'row', key: 'editor.minimap.enabled' })
    expect(h2).toMatchObject({ kind: 'header', id: 'files', count: 1 })
    expect(r3).toMatchObject({ kind: 'row', key: 'files.autoSave' })
  })

  it('records header item indexes and accumulated estimated offsets', () => {
    const model = buildFlatModel(NODES)
    expect(model.headerIndexes).toEqual([0, 3])
    expect(model.headerOffsets).toEqual([
      0,
      SETTINGS_HEADER_HEIGHT + SETTINGS_ROW_HEIGHT_WITH_DESC + SETTINGS_ROW_HEIGHT_NO_DESC,
    ])
  })

  it('restricts and reorders rows by the search ranking, dropping zero-hit groups', () => {
    const ranked: RankedSetting[] = [
      { key: 'files.autoSave', score: 100, order: 2 },
      { key: 'editor.minimap.enabled', score: 50, order: 1 },
      { key: 'editor.fontSize', score: 90, order: 0 },
    ]
    const model = buildFlatModel(NODES, ranked)

    expect(model.items.map((i) => i.kind)).toEqual(['header', 'row', 'row', 'header', 'row'])
    const editorRows = model.items.filter((i) => i.kind === 'row' && i.groupId === 'editor')
    // In-group order follows the ranking (minimap 50 < fontSize 90 by score →
    // ranking array order decides, not the score itself).
    expect(editorRows.map((r) => r.kind === 'row' && r.key)).toEqual([
      'editor.minimap.enabled',
      'editor.fontSize',
    ])
    expect(model.items[0]).toMatchObject({ kind: 'header', count: 2 })
    expect(model.items[3]).toMatchObject({ kind: 'header', id: 'files', count: 1 })
  })

  it('yields an empty model when nothing matches', () => {
    const model = buildFlatModel(NODES, [])
    expect(model.items).toEqual([])
    expect(model.headerIndexes).toEqual([])
  })
})

describe('buildTocEntries', () => {
  it('derives one TOC entry per header with its item index', () => {
    const model = buildFlatModel(NODES)
    expect(buildTocEntries(model)).toEqual([
      { id: 'editor', title: 'Editor', count: 2, itemIndex: 0 },
      { id: 'files', title: 'Files', count: 1, itemIndex: 3 },
    ])
  })
})
