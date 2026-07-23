/**
 * Regression: opening a cross-file markdown link with a header fragment
 * (`./foo.md#hello`) routes through Monaco's `extractSelection`, which yields a
 * range with `undefined` end fields. toRevealRange must collapse that into a
 * valid IRange so `setSelection` doesn't throw "Invalid arguments".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DisposableStore, URI, type ITextEditorSelection } from '@universe-editor/platform'
import {
  revealSelectionInInput,
  toRevealRange,
  waitForFileEditor,
} from '../revealEditorPosition.js'
import { FileEditorInput } from '../FileEditorInput.js'
import { FileEditorRegistry } from '../FileEditorRegistry.js'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'

function createEditorStub(): monaco.editor.IStandaloneCodeEditor {
  return {
    setSelection: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    focus: vi.fn(),
  } as unknown as monaco.editor.IStandaloneCodeEditor
}

describe('toRevealRange', () => {
  it('fills end fields from the start when they are undefined (header-fragment link)', () => {
    // Shape a single-position `#L5,1` fragment produces (no `-L..` end part).
    const partial: ITextEditorSelection = { startLineNumber: 5, startColumn: 1 }
    expect(toRevealRange(partial)).toEqual({
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 1,
    })
  })

  it('preserves a fully specified range (`#L5,1-L6,3`)', () => {
    const full: ITextEditorSelection = {
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 6,
      endColumn: 3,
    }
    expect(toRevealRange(full)).toEqual(full)
  })
})

/**
 * Regression: selecting a workspace symbol deep inside a huge file (a 340K-line
 * index.d.ts) opened the file but never jumped — the old implementation polled
 * FileEditorRegistry for one rAF + 50ms and silently gave up long before the
 * model finished building. The wait must be event-driven: however late the
 * editor mounts, the reveal still lands.
 */
describe('waitForFileEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    FileEditorRegistry._resetForTests()
    vi.useRealTimers()
  })

  it('resolves an editor that mounts long after the old polling window expired', async () => {
    const input = new FileEditorInput(URI.file('D:/big/index.d.ts'), {} as never)
    const editor = createEditorStub()
    const pending = waitForFileEditor(input)
    // Far beyond the old rAF + 50ms budget — a huge model is still being built.
    await vi.advanceTimersByTimeAsync(5_000)
    FileEditorRegistry.register(input, editor)
    await expect(pending).resolves.toBe(editor)
  })

  it('resolves immediately when the editor is already mounted', async () => {
    const input = new FileEditorInput(URI.file('D:/a.ts'), {} as never)
    const editor = createEditorStub()
    FileEditorRegistry.register(input, editor)
    await expect(waitForFileEditor(input)).resolves.toBe(editor)
  })

  it('settles undefined when the input is disposed before mounting (tab closed)', async () => {
    const input = new FileEditorInput(URI.file('D:/b.ts'), {} as never)
    const pending = waitForFileEditor(input)
    input.dispose()
    await expect(pending).resolves.toBeUndefined()
  })

  it('settles undefined via the safety timeout when the editor never mounts', async () => {
    const input = new FileEditorInput(URI.file('D:/c.ts'), {} as never)
    const pending = waitForFileEditor(input)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toBeUndefined()
  })

  it('ignores registrations for other inputs', async () => {
    const input = new FileEditorInput(URI.file('D:/d.ts'), {} as never)
    const other = new FileEditorInput(URI.file('D:/e.ts'), {} as never)
    const editor = createEditorStub()
    const pending = waitForFileEditor(input)
    FileEditorRegistry.register(other, createEditorStub())
    await vi.advanceTimersByTimeAsync(1_000)
    FileEditorRegistry.register(input, editor)
    await expect(pending).resolves.toBe(editor)
  })

  it('settles undefined when the owner store is disposed before mounting', async () => {
    const input = new FileEditorInput(URI.file('D:/f.ts'), {} as never)
    const owner = new DisposableStore()
    const pending = waitForFileEditor(input, owner)
    owner.dispose()
    await expect(pending).resolves.toBeUndefined()
  })

  it('leaves nothing in the owner store once the wait settles (no accumulation)', async () => {
    const input = new FileEditorInput(URI.file('D:/g.ts'), {} as never)
    const owner = new DisposableStore()
    const editor = createEditorStub()
    const pending = waitForFileEditor(input, owner)
    FileEditorRegistry.register(input, editor)
    await expect(pending).resolves.toBe(editor)
    // The internal store must have been detached — disposing the owner later
    // must not re-settle or throw.
    owner.dispose()
  })
})

describe('revealSelectionInInput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    FileEditorRegistry._resetForTests()
    vi.useRealTimers()
  })

  it('applies selection + reveal + focus once a late-mounting editor appears', async () => {
    const input = new FileEditorInput(URI.file('D:/big/index.d.ts'), {} as never)
    const editor = createEditorStub()
    const pending = revealSelectionInInput(input, { startLineNumber: 340461, startColumn: 5 })
    await vi.advanceTimersByTimeAsync(5_000)
    FileEditorRegistry.register(input, editor)
    await pending
    const range = {
      startLineNumber: 340461,
      startColumn: 5,
      endLineNumber: 340461,
      endColumn: 5,
    }
    expect(editor.setSelection).toHaveBeenCalledWith(range)
    expect(editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(range)
    expect(editor.focus).toHaveBeenCalled()
  })
})
