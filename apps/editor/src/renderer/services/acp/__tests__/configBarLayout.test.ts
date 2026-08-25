/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/configBarLayout.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { SessionConfigOption, SessionConfigOptionCategory } from '@agentclientprotocol/sdk'
import {
  MCP_ENTRY_KEY,
  SUBAGENT_ENTRY_KEY,
  buildConfigBarEntries,
  compareByCategory,
  splitConfigBarOverflow,
} from '../configBarLayout.js'

function makeOption(
  id: string,
  category?: SessionConfigOptionCategory | null,
): SessionConfigOption {
  const base: SessionConfigOption = {
    id,
    name: id,
    type: 'select',
    currentValue: 'a',
    options: [{ value: 'a', name: 'A' }],
  }
  return category == null ? base : { ...base, category }
}

const model = makeOption('modelId', 'model')
const modelB = makeOption('modelB', 'model')
const mode = makeOption('modeId', 'mode')
const thought = makeOption('thoughtId', 'thought_level')
const custom = makeOption('customId')

const boolOption: SessionConfigOption = {
  id: 'verbose',
  name: 'Verbose',
  type: 'boolean',
  currentValue: false,
}

describe('buildConfigBarEntries', () => {
  it('orders model… → subagent → mode → thought_level → custom… → mcp', () => {
    const entries = buildConfigBarEntries([custom, mode, thought, model], {
      includeSubagent: true,
      includeMcp: true,
    })
    expect(entries.map((e) => e.key)).toEqual([
      'modelId',
      '__subagent__',
      'modeId',
      'thoughtId',
      'customId',
      '__mcp__',
    ])
    expect(entries[0]).toEqual({ kind: 'option', key: 'modelId', option: model })
    expect(entries[5]).toEqual({ kind: 'mcp', key: MCP_ENTRY_KEY })
  })

  it('puts the subagent first when there is no model option', () => {
    const entries = buildConfigBarEntries([custom, mode], {
      includeSubagent: true,
      includeMcp: false,
    })
    expect(entries.map((e) => e.key)).toEqual(['__subagent__', 'modeId', 'customId'])
    expect(entries[0]).toEqual({ kind: 'subagent', key: SUBAGENT_ENTRY_KEY })
  })

  it('puts the subagent after the LAST model option when there are several', () => {
    const entries = buildConfigBarEntries([modelB, mode, model], {
      includeSubagent: true,
      includeMcp: false,
    })
    expect(entries.map((e) => e.key)).toEqual(['modelB', 'modelId', '__subagent__', 'modeId'])
  })

  it('omits the subagent entry when includeSubagent is false', () => {
    const entries = buildConfigBarEntries([model, mode], {
      includeSubagent: false,
      includeMcp: true,
    })
    expect(entries.some((e) => e.kind === 'subagent')).toBe(false)
  })

  it('omits the mcp entry when includeMcp is false', () => {
    const entries = buildConfigBarEntries([model, mode], {
      includeSubagent: true,
      includeMcp: false,
    })
    expect(entries.some((e) => e.kind === 'mcp')).toBe(false)
  })

  it('drops non-select options (they render no trigger at all)', () => {
    const entries = buildConfigBarEntries([model, boolOption, mode], {
      includeSubagent: true,
      includeMcp: false,
    })
    expect(entries.map((e) => e.key)).toEqual(['modelId', '__subagent__', 'modeId'])
  })

  it('glues the subagent after the last select model option despite non-select noise', () => {
    const boolModel: SessionConfigOption = {
      id: 'modelToggle',
      name: 'Model toggle',
      type: 'boolean',
      category: 'model',
      currentValue: true,
    }
    const entries = buildConfigBarEntries([model, boolModel, mode], {
      includeSubagent: true,
      includeMcp: false,
    })
    expect(entries.map((e) => e.key)).toEqual(['modelId', '__subagent__', 'modeId'])
  })

  it('yields just the pickers when the bag is empty', () => {
    expect(
      buildConfigBarEntries([], { includeSubagent: true, includeMcp: true }).map((e) => e.key),
    ).toEqual(['__subagent__', '__mcp__'])
    expect(
      buildConfigBarEntries([], { includeSubagent: false, includeMcp: false }).map((e) => e.key),
    ).toEqual([])
  })

  it('does not reorder the input array', () => {
    const input = [custom, mode, thought, model]
    buildConfigBarEntries(input, { includeSubagent: true, includeMcp: true })
    expect(input.map((o) => o.id)).toEqual(['customId', 'modeId', 'thoughtId', 'modelId'])
  })
})

describe('compareByCategory', () => {
  it('ranks model < mode < thought_level < uncategorized', () => {
    expect(compareByCategory(model, mode)).toBeLessThan(0)
    expect(compareByCategory(mode, thought)).toBeLessThan(0)
    expect(compareByCategory(thought, custom)).toBeLessThan(0)
    expect(compareByCategory(model, custom)).toBeLessThan(0)
    expect(compareByCategory(custom, model)).toBeGreaterThan(0)
    expect(compareByCategory(custom, custom)).toBe(0)
  })

  it('treats a null category like an unknown one', () => {
    const nullCategory = makeOption('nullCat', null)
    expect(compareByCategory(nullCategory, model)).toBeGreaterThan(0)
    expect(compareByCategory(custom, nullCategory)).toBe(0)
  })
})

describe('splitConfigBarOverflow', () => {
  const widthOf = (key: string): number => (key === 'a' ? 90 : 60)

  it('overflows the first non-fitting entry and everything after it (no skipping)', () => {
    const keys = ['a', 'b', 'c', 'd', 'e']
    // Under the two-pass packing c must also reserve the button's leading
    // gap: a(90)+gap+b(60)+gap+c(60)+gap+button(26) = 248 > 244, so c and the
    // tail overflow (the old one-pass packing left c inline and overflowed
    // only d/e, clipping the button's right edge by the missing gap).
    expect([...splitConfigBarOverflow(keys, widthOf, 244, 26, 4)]).toEqual(['c', 'd', 'e'])
  })

  it('overflows everything when even the first entry cannot fit', () => {
    // a(90) + gap(4) + button(26) = 120 > 80: the first entry cannot sit
    // beside the in-flow button, so the whole bar overflows.
    expect([...splitConfigBarOverflow(['a', 'b'], widthOf, 80, 26, 4)]).toEqual(['a', 'b'])
  })

  it('returns an empty set when everything fits', () => {
    expect(splitConfigBarOverflow(['a', 'b'], widthOf, 200, 26, 4).size).toBe(0)
  })

  it('does not over-reserve the button when nothing overflows', () => {
    // a(90)+gap(4)+b(60) = 154 fills clientWidth exactly with buttonWidth >
    // 0: nothing overflows, so the button leaves the flow and reserves no
    // width. The old one-pass packing pre-subtracted the button and
    // overflowed 'b' here.
    expect(splitConfigBarOverflow(['a', 'b'], widthOf, 154, 26, 4).size).toBe(0)
    // One px less and the tail genuinely cannot fit (a stays: 90+4+26 = 120
    // <= 153).
    expect([...splitConfigBarOverflow(['a', 'b'], widthOf, 153, 26, 4)]).toEqual(['b'])
    // Same for a lone entry: a(90) fits alone in 115 regardless of the button
    // width — the old packing overflowed 'a' in this dead zone.
    expect(splitConfigBarOverflow(['a'], widthOf, 115, 26, 4).size).toBe(0)
  })

  it('reserves the gap before the in-flow button once the bar overflows', () => {
    const keys = ['a', 'b', 'c']
    // Overflow state: the button sits in the flow right after the last
    // visible entry with a gap between them.
    // a(90)+gap(4)+b(60)+gap(4)+button(26) = 184 fills clientWidth exactly →
    // exactly two entries stay visible. (Replaces the old 180/179 boundary,
    // which charged no gap between the last entry and the button.)
    expect([...splitConfigBarOverflow(keys, widthOf, 184, 26, 4)]).toEqual(['c'])
    // One px less and b no longer fits beside the gap + button.
    expect([...splitConfigBarOverflow(keys, widthOf, 183, 26, 4)]).toEqual(['b', 'c'])
  })

  it('k=0 boundary: does not re-admit the first entry when the button stands alone', () => {
    // a(90)+gap(4)+button(26) = 120 > 118: even the first entry cannot sit
    // beside the button, so everything overflows while the button (26 <= 118)
    // fits alone. (Replaces the old single-entry dead zone: the one-pass
    // packing pre-subtracted the gap when nothing preceded the button.)
    expect([...splitConfigBarOverflow(['a', 'b'], widthOf, 118, 26, 4)]).toEqual(['a', 'b'])
    // a(90)+button(26) = 116 would fit exactly WITHOUT the gap, but once an
    // overflow is proven the button is in the flow and the gap before it is
    // real — re-admitting 'a' here would clip it by the 4px gap.
    expect([...splitConfigBarOverflow(['a', 'b'], widthOf, 116, 26, 4)]).toEqual(['a', 'b'])
  })
})
