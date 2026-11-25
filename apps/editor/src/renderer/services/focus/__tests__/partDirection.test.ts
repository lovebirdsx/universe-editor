import { describe, expect, it } from 'vitest'
import { findPartInDirection, type PartCandidate } from '../partDirection.js'

// Default layout: side bar left, editor top-right, panel below the editor,
// secondary side bar on the far right spanning the full height.
const SIDE = { left: 0, top: 0, right: 200, bottom: 800 }
const EDITOR = { left: 201, top: 0, right: 900, bottom: 500 }
const PANEL = { left: 201, top: 501, right: 900, bottom: 800 }
const AUX = { left: 901, top: 0, right: 1100, bottom: 800 }

const ALL: readonly PartCandidate<string>[] = [
  { id: 'side', rect: SIDE },
  { id: 'editor', rect: EDITOR },
  { id: 'panel', rect: PANEL },
  { id: 'aux', rect: AUX },
]

function others(self: string): PartCandidate<string>[] {
  return ALL.filter((candidate) => candidate.id !== self)
}

describe('findPartInDirection', () => {
  it('walks between the side bar, the editor and the panel', () => {
    expect(findPartInDirection(SIDE, others('side'), 'right')).toBe('editor')
    expect(findPartInDirection(EDITOR, others('editor'), 'left')).toBe('side')
    expect(findPartInDirection(EDITOR, others('editor'), 'down')).toBe('panel')
    expect(findPartInDirection(PANEL, others('panel'), 'up')).toBe('editor')
    expect(findPartInDirection(PANEL, others('panel'), 'left')).toBe('side')
    expect(findPartInDirection(EDITOR, others('editor'), 'right')).toBe('aux')
  })

  it('stops at the workbench edge', () => {
    expect(findPartInDirection(SIDE, others('side'), 'left')).toBeUndefined()
    expect(findPartInDirection(SIDE, others('side'), 'up')).toBeUndefined()
    expect(findPartInDirection(EDITOR, others('editor'), 'up')).toBeUndefined()
  })

  it('follows the geometry of a right-hand side bar', () => {
    const editor = { left: 0, top: 0, right: 800, bottom: 800 }
    const side = { left: 801, top: 0, right: 1000, bottom: 800 }
    expect(findPartInDirection(editor, [{ id: 'side', rect: side }], 'right')).toBe('side')
    expect(findPartInDirection(editor, [{ id: 'side', rect: side }], 'left')).toBeUndefined()
  })

  it('prefers the nearest part, then the one sharing the most span', () => {
    const from = { left: 500, top: 0, right: 600, bottom: 400 }
    const near = { left: 300, top: 0, right: 499, bottom: 100 }
    const far = { left: 0, top: 0, right: 200, bottom: 400 }
    const wide = { left: 300, top: 100, right: 499, bottom: 400 }
    expect(
      findPartInDirection(
        from,
        [
          { id: 'far', rect: far },
          { id: 'near', rect: near },
          { id: 'wide', rect: wide },
        ],
        'left',
      ),
    ).toBe('wide')
  })
})
