/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ZH_CN_MESSAGES } from '../../../../../shared/i18n/messages/zh-CN.js'
import {
  collectVimKeyHelpRows,
  getVimEditorKeyHelp,
  keyHelpSlug,
  listVimKeyHelpDescriptions,
} from '../vimKeyHelp.js'

describe('getVimEditorKeyHelp', () => {
  const rows = getVimEditorKeyHelp()
  const has = (keys: string) => rows.some((row) => row.keys === keys)

  it('derives rows from every registry', () => {
    for (const keys of [
      'h',
      'f{char}',
      'd{motion}',
      'gU{motion}',
      'gg',
      'Ctrl+F / PageDown',
      '.',
      'v',
      'zc',
      'Ctrl+R',
    ]) {
      expect(has(keys), keys).toBe(true)
    }
  })

  it('has no empty fields and no duplicate (group, keys) rows', () => {
    const seen = new Set<string>()
    for (const row of rows) {
      expect(row.group).not.toBe('')
      expect(row.keys).not.toBe('')
      expect(row.description).not.toBe('')
      const id = `${row.group}|${row.keys}`
      expect(seen.has(id), id).toBe(false)
      seen.add(id)
    }
  })

  it('the raw registry rows hold no duplicate (group, keys): a clash means two sources claim a key', () => {
    const seen = new Set<string>()
    const clashes: string[] = []
    for (const row of collectVimKeyHelpRows()) {
      const id = `${row.group}|${row.keys}`
      if (seen.has(id)) clashes.push(id)
      seen.add(id)
    }
    expect(clashes).toEqual([])
  })

  it('lists scrolling and gv exactly once, and the numbered registers', () => {
    for (const keys of ['Ctrl+E', 'Ctrl+Y', 'gv']) {
      expect(
        rows.filter((row) => row.keys === keys),
        keys,
      ).toHaveLength(1)
    }
    expect(rows.some((row) => row.keys.includes('"1'))).toBe(true)
  })

  it('has a zh-CN translation for every description and group', () => {
    const missing = listVimKeyHelpDescriptions().filter(
      (description) => !(`vim.keyHelp.${keyHelpSlug(description)}` in ZH_CN_MESSAGES),
    )
    expect(missing).toEqual([])
    for (const group of ['motions', 'operators', 'textObjects', 'editing', 'visual', 'registers']) {
      expect(`vim.keyHelp.group.${group}` in ZH_CN_MESSAGES).toBe(true)
    }
  })
})
