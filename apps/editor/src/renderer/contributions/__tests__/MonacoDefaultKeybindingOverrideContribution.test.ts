import { describe, expect, it } from 'vitest'
import {
  desiredMonacoRules,
  diffMonacoDisabled,
} from '../MonacoDefaultKeybindingOverrideContribution.js'

describe('diffMonacoDisabled', () => {
  const ruleA = { command: 'a', keybinding: 0 }
  const ruleB = { command: 'b', keybinding: 0 }

  it('adds newly desired rules not yet applied', () => {
    const desired = new Map([
      ['a 0', ruleA],
      ['b 0', ruleB],
    ])
    const { toAdd, toRemove } = diffMonacoDisabled(desired, new Set(['a 0']))
    expect(toAdd).toEqual([ruleB])
    expect(toRemove).toEqual([])
  })

  it('removes applied rules no longer desired', () => {
    const desired = new Map([['a 0', ruleA]])
    const { toAdd, toRemove } = diffMonacoDisabled(desired, new Set(['a 0', 'b 0']))
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual(['b 0'])
  })

  it('is a no-op when desired equals applied', () => {
    const desired = new Map([
      ['a 0', ruleA],
      ['b 0', ruleB],
    ])
    const { toAdd, toRemove } = diffMonacoDisabled(desired, new Set(['b 0', 'a 0']))
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual([])
  })
})

describe('desiredMonacoRules', () => {
  it('skips commands with no Monaco default keybinding', () => {
    // 'no.such.command' is not a bridged Monaco default → filtered out.
    const rules = desiredMonacoRules([{ command: 'no.such.command', key: 'f3' }])
    expect(rules.size).toBe(0)
  })
})
