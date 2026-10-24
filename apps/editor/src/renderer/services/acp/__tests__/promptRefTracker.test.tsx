/*---------------------------------------------------------------------------------------------
 *  Tests for PromptRefTracker — by-range reference-pill tracking on a Monaco
 *  model. Runs in the renderer-dom project where `monaco-editor` is aliased to
 *  the test stub (test-stubs/monaco-editor.ts), whose model implements the
 *  decoration migration + applyEdits slice this class relies on.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
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

  // -------------------------------------------------------------------------
  // Undo integration: insertions must enter Monaco's undo stack, undo must not
  // delete text (Monaco already applied the inverse edit), redo must re-mount
  // the pill decoration.
  // -------------------------------------------------------------------------

  it('insert() goes through pushEditOperations and folds the suffix into one edit', () => {
    const { model, tracker } = makeTracker('')
    const pushEdit = vi.spyOn(model, 'pushEditOperations')
    const applyEdits = vi.spyOn(model, 'applyEdits')

    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })

    expect(model.getValue()).toBe('@a.ts ')
    expect(pushEdit).toHaveBeenCalledTimes(1)
    const [, edits] = pushEdit.mock.calls[0]!
    expect(edits).toEqual([expect.objectContaining({ text: '@a.ts ' })])
    // The pill itself must not be written through the non-undoable path.
    expect(applyEdits).not.toHaveBeenCalled()
    const [placed] = tracker.list()
    expect(model.getValue().slice(placed!.start, placed!.end)).toBe('@a.ts')
  })

  it('a standalone insert delimits its undo element', () => {
    const { model, tracker } = makeTracker('')
    const pushStack = vi.spyOn(model, 'pushStackElement')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    // One boundary closes pending typing, the next closes the insertion.
    expect(pushStack).toHaveBeenCalledTimes(2)
  })

  it('a group emits only its two boundaries, however many refs it inserts', () => {
    const { model, tracker } = makeTracker('')
    const pushStack = vi.spyOn(model, 'pushStackElement')
    tracker.beginUndoGroup()
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    tracker.insert(fileRef('2', 'b.ts'), 6, 6, { suffix: ' ' })
    tracker.endUndoGroup()
    expect(model.getValue()).toBe('@a.ts @b.ts ')
    expect(pushStack).toHaveBeenCalledTimes(2)
  })

  it('reconcile(isUndoing) suspends the pill without touching the text', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    // Simulate Monaco's inverse edit: the whole insertion (pill + space) goes.
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(6)),
        text: '',
      },
    ])
    expect(model.getValue()).toBe('')

    const mutated = tracker.reconcile({
      isUndoing: true,
      changes: [{ rangeOffset: 0, text: '@a.ts ' }],
    })
    expect(mutated).toBe(false)
    expect(model.getValue()).toBe('')
    expect(tracker.list()).toHaveLength(0)
  })

  it('reconcile(isRedoing) re-mounts the decoration for the restored text', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(6)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 0, text: '@a.ts ' }] })

    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: '@a.ts ',
      },
    ])
    tracker.reconcile({ isRedoing: true, changes: [{ rangeOffset: 0, text: '@a.ts ' }] })

    const [placed] = tracker.list()
    expect(placed).toBeTruthy()
    expect(model.getValue().slice(placed!.start, placed!.end)).toBe('@a.ts')
  })

  it('one redo event restores several pills (multi-file drop group)', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    tracker.insert(fileRef('2', 'b.ts'), 6, 6, { suffix: ' ' })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(12)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 0, text: '@a.ts @b.ts ' }] })
    expect(tracker.list()).toHaveLength(0)

    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: '@a.ts @b.ts ',
      },
    ])
    // Monaco compresses adjacent edits when it records an undo element
    // (`compressConsecutiveTextChanges`), so the whole drop comes back as ONE
    // change carrying the concatenated text — not one change per pill.
    tracker.reconcile({
      isRedoing: true,
      changes: [{ rangeOffset: 0, text: '@a.ts @b.ts ' }],
    })
    const list = tracker.list()
    expect(list.map((p) => p.ref.label)).toEqual(['a.ts', 'b.ts'])
    expect(model.getValue().slice(list[0]!.start, list[0]!.end)).toBe('@a.ts')
    expect(model.getValue().slice(list[1]!.start, list[1]!.end)).toBe('@b.ts')
  })

  it('redo re-mounts pills from separate changes as well', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    tracker.insert(fileRef('2', 'b.ts'), 6, 6, { suffix: ' ' })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(12)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 0, text: '@a.ts @b.ts ' }] })

    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: '@a.ts @b.ts ',
      },
    ])
    // Real events list changes in descending offset order (Monaco applies
    // edits bottom-to-top), so the higher insertion comes first.
    tracker.reconcile({
      isRedoing: true,
      changes: [
        { rangeOffset: 6, text: '@b.ts ' },
        { rangeOffset: 0, text: '@a.ts ' },
      ],
    })
    const list = tracker.list()
    expect(list.map((p) => p.ref.label)).toEqual(['a.ts', 'b.ts'])
    expect(model.getValue().slice(list[0]!.start, list[0]!.end)).toBe('@a.ts')
    expect(model.getValue().slice(list[1]!.start, list[1]!.end)).toBe('@b.ts')
  })

  it('a longer label is not stolen by a shorter prefix on redo', () => {
    const { model, tracker } = makeTracker('')
    // Insert two independent undo elements: "@main.tsx " then "@main.ts ".
    tracker.insert(fileRef('1', 'main.tsx'), 0, 0, { suffix: ' ' })
    tracker.insert(fileRef('2', 'main.ts'), 10, 10, { suffix: ' ' })
    expect(model.getValue()).toBe('@main.tsx @main.ts ')

    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(10), model.getPositionAt(19)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 10, text: '@main.ts ' }] })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(10)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 0, text: '@main.tsx ' }] })
    expect(tracker.list()).toHaveLength(0)

    // Redo replays oldest-first. `@main.ts` is a prefix of `@main.tsx`, so the
    // longer snapshot must win at the same offset or the wrong ref is painted
    // over the pill and `main.tsx` is lost for later redo steps.
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: '@main.tsx ',
      },
    ])
    tracker.reconcile({ isRedoing: true, changes: [{ rangeOffset: 0, text: '@main.tsx ' }] })
    let list = tracker.list()
    expect(list.map((p) => p.ref.label)).toEqual(['main.tsx'])
    expect(model.getValue().slice(list[0]!.start, list[0]!.end)).toBe('@main.tsx')

    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(10), model.getPositionAt(10)),
        text: '@main.ts ',
      },
    ])
    tracker.reconcile({ isRedoing: true, changes: [{ rangeOffset: 10, text: '@main.ts ' }] })
    list = tracker.list()
    expect(list.map((p) => p.ref.label)).toEqual(['main.tsx', 'main.ts'])
    expect(model.getValue().slice(list[0]!.start, list[0]!.end)).toBe('@main.tsx')
    expect(model.getValue().slice(list[1]!.start, list[1]!.end)).toBe('@main.ts')
  })

  it('keeps a suspended ref when a change offset does not match, for a later step', () => {
    const { model, tracker } = makeTracker('xx')
    tracker.insert(fileRef('1', 'a.ts'), 2, 2, { suffix: ' ' })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(2), model.getPositionAt(8)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 2, text: '@a.ts ' }] })
    expect(tracker.list()).toHaveLength(0)

    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(2), model.getPositionAt(2)),
        text: '@a.ts ',
      },
    ])
    // Wrong offset (model holds "xx" there): the candidate must survive the
    // failed guard instead of being dropped, then mount on the next change.
    tracker.reconcile({ isRedoing: true, changes: [{ rangeOffset: 0, text: '@a.ts ' }] })
    expect(tracker.list()).toHaveLength(0)
    tracker.reconcile({ isRedoing: true, changes: [{ rangeOffset: 2, text: '@a.ts ' }] })
    const [placed] = tracker.list()
    expect(placed).toBeTruthy()
    expect(model.getValue().slice(placed!.start, placed!.end)).toBe('@a.ts')
  })

  it('a new insertion closes the redo branch for suspended refs', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(6)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 0, text: '@a.ts ' }] })

    // A new standalone insert pushes a fresh undo element, discarding redo.
    tracker.insert(fileRef('2', 'b.ts'), 0, 0, { suffix: ' ' })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: '@a.ts ',
      },
    ])
    tracker.reconcile({ isRedoing: true, changes: [{ rangeOffset: 0, text: '@a.ts ' }] })
    const list = tracker.list()
    expect(list.map((p) => p.ref.label)).toEqual(['b.ts'])
  })

  it('inserting at a pill edge does not grow its range into the new pill', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' }) // "@a.ts "
    // Caret sits exactly on the pill's right edge (before its trailing space).
    tracker.insert(fileRef('2', 'b.ts'), 5, 5, { suffix: ' ' })
    expect(model.getValue()).toBe('@a.ts@b.ts  ')
    // forceMoveMarkers here would have stretched pill 1 over pill 2's text and
    // this reconcile would then delete both.
    expect(tracker.reconcile()).toBe(false)
    const list = tracker.list()
    expect(list.map((p) => p.ref.label)).toEqual(['a.ts', 'b.ts'])
    expect(model.getValue().slice(list[0]!.start, list[0]!.end)).toBe('@a.ts')
    expect(model.getValue().slice(list[1]!.start, list[1]!.end)).toBe('@b.ts')
  })

  it('a plain edit after undo discards suspended refs', () => {
    const { model, tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(6)),
        text: '',
      },
    ])
    tracker.reconcile({ isUndoing: true, changes: [{ rangeOffset: 0, text: '@a.ts ' }] })

    // Type something new (redoing the pill is no longer possible).
    model.applyEdits([
      {
        range: ns.Range.fromPositions(model.getPositionAt(0), model.getPositionAt(0)),
        text: 'x',
      },
    ])
    tracker.reconcile()
    expect(tracker.list()).toHaveLength(0)
  })

  it('reconcile(isFlush) forgets every tracked ref', () => {
    const { tracker } = makeTracker('')
    tracker.insert(fileRef('1', 'a.ts'), 0, 0, { suffix: ' ' })
    expect(tracker.reconcile({ isFlush: true })).toBe(false)
    expect(tracker.list()).toHaveLength(0)
  })
})
