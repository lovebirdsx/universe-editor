/*---------------------------------------------------------------------------------------------
 *  Tests for the timeline display-mode order / validation shared by the
 *  session view-model and the dropdown.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  COLLAPSE_MODE_ORDER,
  DEFAULT_COLLAPSE_MODE,
  isCollapseMode,
  nextCollapseMode,
} from '../acpCollapseMode.js'

describe('acpCollapseMode', () => {
  it('orders the five display modes', () => {
    expect(COLLAPSE_MODE_ORDER).toEqual([
      'default',
      'collapsed',
      'expanded',
      'hideThinking',
      'onlyMessage',
    ])
  })

  it('cycles through all five modes and wraps back to default', () => {
    expect(nextCollapseMode('default')).toBe('collapsed')
    expect(nextCollapseMode('collapsed')).toBe('expanded')
    expect(nextCollapseMode('expanded')).toBe('hideThinking')
    expect(nextCollapseMode('hideThinking')).toBe('onlyMessage')
    expect(nextCollapseMode('onlyMessage')).toBe('default')
  })

  it('recognises only known mode strings', () => {
    for (const mode of COLLAPSE_MODE_ORDER) expect(isCollapseMode(mode)).toBe(true)
    expect(isCollapseMode('hide-thinking')).toBe(false)
    expect(isCollapseMode(undefined)).toBe(false)
    expect(isCollapseMode(1)).toBe(false)
  })

  it('defaults new sessions to onlyMessage', () => {
    expect(DEFAULT_COLLAPSE_MODE).toBe('onlyMessage')
    expect(COLLAPSE_MODE_ORDER).toContain(DEFAULT_COLLAPSE_MODE)
  })
})
