import { describe, expect, it } from 'vitest'
import { PromptImageUndo } from '../promptImageUndo.js'
import type { PromptImage } from '../promptImage.js'

function image(id: string): PromptImage {
  return { id, mimeType: 'image/png', dataBase64: 'AA==', byteSize: 1 }
}

const ids = (images: readonly PromptImage[]): string[] => images.map((i) => i.id)

describe('PromptImageUndo', () => {
  it('records an attach and only offers undo at its alternative version', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], 7)

    expect(undo.canUndo([a], 7)).toBe(true)
    expect(undo.canUndo([a], 8)).toBe(false)
    expect(undo.undo([a], 8)).toBeNull()
    expect(ids(undo.undo([a], 7) ?? [])).toEqual([])
  })

  it('is never available when the version is unknown (editor not mounted)', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], undefined)
    expect(undo.canUndo([a], undefined)).toBe(false)
    expect(undo.canUndo([a], 1)).toBe(false)
    expect(undo.undo([a], undefined)).toBeNull()
  })

  it('does not record an attach that lands after the history was reset', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    const generation = undo.generation
    undo.reset()
    undo.recordAttach([a], 1, generation)
    // A stale entry would sit on top of the stack with a version that can
    // never come back, blocking every older entry.
    expect(undo.canUndo([a], 1)).toBe(false)
  })

  it('records an attach from the current generation', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], 1, undo.generation)
    expect(undo.canUndo([a], 1)).toBe(true)
  })

  it('an attach without a version still drops the redo branch', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], 1)
    undo.undo([a], 1)
    undo.recordAttach([image('b')], undefined)
    expect(undo.canRedo([], 1)).toBe(false)
  })

  it('undoes a whole attach batch and redoes it in one step', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    const b = image('b')
    undo.recordAttach([a, b], 3)

    const afterUndo = undo.undo([a, b], 3)
    expect(afterUndo).toEqual([])
    expect(undo.canRedo(afterUndo ?? [], 3)).toBe(true)
    expect(ids(undo.redo(afterUndo ?? [], 3) ?? [])).toEqual(['a', 'b'])
  })

  it('undoes newest-first across batches', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    const b = image('b')
    undo.recordAttach([a], 1)
    undo.recordAttach([b], 2)
    expect(ids(undo.undo([a, b], 2) ?? [])).toEqual(['a'])
    expect(ids(undo.undo([a], 1) ?? [])).toEqual([])
    // Redo replays oldest-first.
    expect(ids(undo.redo([], 1) ?? [])).toEqual(['a'])
    expect(ids(undo.redo([a], 2) ?? [])).toEqual(['a', 'b'])
  })

  it('a fresh attach clears the redo branch', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    const b = image('b')
    undo.recordAttach([a], 1)
    undo.undo([a], 1)
    undo.recordAttach([b], 1)
    expect(undo.canRedo([b], 1)).toBe(false)
  })

  it('invalidateRedo drops only the redo half', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    const b = image('b')
    undo.recordAttach([a], 1)
    undo.recordAttach([b], 1)
    undo.undo([a, b], 1)
    undo.invalidateRedo()
    expect(undo.canRedo([a], 1)).toBe(false)
    expect(undo.canUndo([a], 1)).toBe(true)
  })

  it('dropEntriesFor removes the entry from both stacks so a hand-removed chip never returns', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], 1)
    undo.dropEntriesFor(['a'])
    expect(undo.canUndo([a], 1)).toBe(false)

    const b = image('b')
    undo.recordAttach([b], 1)
    undo.undo([b], 1)
    undo.dropEntriesFor(['b'])
    expect(undo.canRedo([], 1)).toBe(false)
  })

  it('does not offer undo when the recorded image is no longer attached', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], 1)
    expect(undo.canUndo([], 1)).toBe(false)
  })

  it('caps the undo depth', () => {
    const undo = new PromptImageUndo()
    for (let i = 0; i < 60; i++) undo.recordAttach([image(`i${i}`)], i)
    let count = 0
    for (let i = 59; i >= 0; i--) {
      if (!undo.canUndo([image(`i${i}`)], i)) continue
      undo.undo([image(`i${i}`)], i)
      count++
    }
    // 60 recorded, the oldest 10 were evicted.
    expect(count).toBe(50)
  })

  it('reset clears both stacks', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], 1)
    undo.undo([a], 1)
    undo.reset()
    expect(undo.canUndo([a], 1)).toBe(false)
    expect(undo.canRedo([], 1)).toBe(false)
  })

  it('state reports both flags for the current version', () => {
    const undo = new PromptImageUndo()
    const a = image('a')
    undo.recordAttach([a], 1)
    expect(undo.state([a], 1)).toEqual({ canUndo: true, canRedo: false })
    undo.undo([a], 1)
    expect(undo.state([], 1)).toEqual({ canUndo: false, canRedo: true })
  })
})
