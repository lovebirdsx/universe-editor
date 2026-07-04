/*---------------------------------------------------------------------------------------------
 *  Tests for PromptRefTracker — by-range reference-pill tracking on a Monaco
 *  model. Runs in the renderer-dom project where `monaco-editor` is aliased to
 *  the test stub (test-stubs/monaco-editor.ts), whose model implements the
 *  decoration migration + applyEdits slice this class relies on.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import * as monaco from 'monaco-editor'
import { PromptRefTracker } from '../promptRefTracker.js'
import type { PromptRef } from '../promptRef.js'

const ns =
  monaco as unknown as typeof import('../../../workbench/editor/monaco/MonacoLoader.js').monaco

function makeTracker(initial: string) {
  const model = ns.editor.createModel(initial, 'plaintext', undefined)
  const tracker = new PromptRefTracker(model, ns, 'pill')
  return { model, tracker }
}

const fileRef = (id: string, label: string): PromptRef => ({
  id,
  kind: 'file',
  label,
  uri: `file:///${label}`,
})

describe('PromptRefTracker', () => {
  it('inserts a pill display and tracks its range', () => {
    const { model, tracker } = makeTracker('see  here')
    // Insert at offset 4 (the empty gap between the two spaces).
    tracker.insert(fileRef('1', 'a.ts'), 4, 4)
    expect(model.getValue()).toBe('see @a.ts here')
    const list = tracker.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.ref.label).toBe('a.ts')
    expect(model.getValue().slice(list[0]!.start, list[0]!.end)).toBe('@a.ts')
  })

  it('tracks a label containing spaces by range (the core fix)', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert({ id: '1', kind: 'docs', label: 'Editor User Guide', uri: 'file:///d' }, 0, 0)
    expect(model.getValue()).toBe('#Editor User Guide')
    const [placed] = tracker.list()
    expect(model.getValue().slice(placed!.start, placed!.end)).toBe('#Editor User Guide')
  })

  it('shifts the range when text is inserted before the pill', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0)
    // Prepend text ahead of the pill.
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: 'hi ',
      },
    ])
    const [placed] = tracker.list()
    expect(model.getValue().slice(placed!.start, placed!.end)).toBe('@a.ts')
  })

  it('reconcile() drops a pill whose inner text was edited', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0)
    // Corrupt the pill: replace one interior char.
    const range = ns.Range.fromPositions(model.getPositionAt(2), model.getPositionAt(3))
    model.applyEdits([{ range, text: 'X' }])
    const mutated = tracker.reconcile()
    expect(mutated).toBe(true)
    expect(tracker.list()).toHaveLength(0)
    // The leftover partial pill text is removed too.
    expect(model.getValue()).not.toContain('@')
  })

  it('reconcile() keeps a pill that only moved (surrounding edits)', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0)
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: 'hi ',
      },
    ])
    expect(tracker.reconcile()).toBe(false)
    expect(tracker.list()).toHaveLength(1)
  })

  it('reconcile() keeps a pill after a trailing space is appended right after it', () => {
    // Regression: insertRef adds a trailing space after the pill. If that edit
    // uses forceMoveMarkers it pulls the space into the tracked range, so the
    // range text drifts from the snapshot and reconcile() wrongly deletes the
    // whole pill on the next keystroke. The space must land OUTSIDE the range.
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'test.md'), 0, 0) // → "@test.md"
    const caret = model.getValue().length
    // Append the trailing space at the pill's right edge WITHOUT forceMoveMarkers,
    // exactly as insertRef does.
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(caret), model.getPositionAt(caret)),
        text: ' ',
      },
    ])
    expect(model.getValue()).toBe('@test.md ')
    expect(tracker.reconcile()).toBe(false)
    const [placed] = tracker.list()
    expect(placed).toBeTruthy()
    // The tracked range must still cover only the pill token, not the space.
    expect(model.getValue().slice(placed!.start, placed!.end)).toBe('@test.md')
  })

  it('list() orders refs by start offset', () => {
    const { tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0) // → "@a.ts "
    // Insert a second pill at the end of the current buffer.
    tracker.insert(fileRef('2', 'b.ts'), 6, 6)
    const list = tracker.list()
    expect(list.map((p) => p.ref.label)).toEqual(['a.ts', 'b.ts'])
    expect(list[0]!.start).toBeLessThan(list[1]!.start)
  })

  it('restore() rebuilds pills over already-present display text', () => {
    const { model, tracker } = makeTracker('see @a.ts here')
    tracker.restore([{ ref: fileRef('1', 'a.ts'), start: 4, end: 9 }])
    const [placed] = tracker.list()
    expect(model.getValue().slice(placed!.start, placed!.end)).toBe('@a.ts')
  })

  it('clear() removes all pills + tracking', () => {
    const { tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0)
    tracker.clear()
    expect(tracker.list()).toHaveLength(0)
  })
})
