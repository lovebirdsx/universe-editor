/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/actions/findWordActions.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  INotificationService,
  InstantiationService,
  KeybindingsRegistry,
  Severity,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { FindWordAtCursorNextAction, FindWordAtCursorPreviousAction } from '../findWordActions.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'

class FakeTextModel {
  private readonly _lines: string[]
  constructor(text: string) {
    this._lines = text.split('\n')
  }
  getOffsetAt(position: { lineNumber: number; column: number }): number {
    let offset = 0
    for (let i = 0; i < position.lineNumber - 1; i++) offset += this._lines[i]!.length + 1
    return offset + position.column - 1
  }
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    let rest = offset
    for (let i = 0; i < this._lines.length; i++) {
      const len = this._lines[i]!.length
      if (rest <= len) return { lineNumber: i + 1, column: rest + 1 }
      rest -= len + 1
    }
    const last = this._lines.length
    return { lineNumber: last, column: this._lines[last - 1]!.length + 1 }
  }
  getWordAtPosition(position: { lineNumber: number; column: number }) {
    const line = this._lines[position.lineNumber - 1] ?? ''
    const re = /\w+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      const startColumn = m.index + 1
      const endColumn = startColumn + m[0].length
      if (position.column >= startColumn && position.column <= endColumn) {
        return { word: m[0], startColumn, endColumn }
      }
    }
    return null
  }
  getValueInRange(range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }): string {
    return this._lines[range.startLineNumber - 1]!.slice(range.startColumn - 1, range.endColumn - 1)
  }
  findMatches(
    searchString: string,
    _scope: unknown,
    _isRegex: boolean,
    matchCase: boolean,
    _wordSeparators: unknown,
    _captureMatches: boolean,
    _limit: number,
  ) {
    const text = this._lines.join('\n')
    const haystack = matchCase ? text : text.toLowerCase()
    const needle = matchCase ? searchString : searchString.toLowerCase()
    const results: Array<{ range: unknown }> = []
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      const start = this.getPositionAt(index)
      const end = this.getPositionAt(index + searchString.length)
      results.push({
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
          getStartPosition: () => ({ lineNumber: start.lineNumber, column: start.column }),
        },
      })
      index = haystack.indexOf(needle, index + 1)
    }
    return results
  }
}

function fakeSelection(startLine: number, startColumn: number, endLine: number, endColumn: number) {
  return {
    startLineNumber: startLine,
    startColumn,
    endLineNumber: endLine,
    endColumn,
    isEmpty: () => startLine === endLine && startColumn === endColumn,
    getPosition: () => ({ lineNumber: endLine, column: endColumn }),
    getStartPosition: () => ({ lineNumber: startLine, column: startColumn }),
  }
}

describe('findWordAtCursor actions', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose()
    }
    FileEditorRegistry._resetForTests()
    MonacoModelRegistry._resetForTests()
  })

  function stubFs() {
    return {
      _serviceBrand: undefined,
      async readFile() {
        return new Uint8Array()
      },
      async readFileText() {
        return ''
      },
      async writeFile() {},
      async exists() {
        return false
      },
      async stat() {
        throw new Error('not used')
      },
      async list() {
        return []
      },
      async createDirectory() {},
      async delete() {},
      async rename() {},
    }
  }

  function setup(opts: { text: string; selection: ReturnType<typeof fakeSelection> }) {
    const services = new ServiceCollection()
    services.set(IFileService, stubFs() as never)
    const notify = vi.fn()
    services.set(INotificationService, { _serviceBrand: undefined, notify } as never)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)

    const collection = { set: vi.fn(), clear: vi.fn() }
    const editor = {
      getModel: () => new FakeTextModel(opts.text),
      getSelection: () => opts.selection,
      setPosition: vi.fn(),
      setSelection: vi.fn(),
      revealPositionInCenterIfOutsideViewport: vi.fn(),
      revealRangeInCenterIfOutsideViewport: vi.fn(),
      createDecorationsCollection: () => collection,
      onDidChangeCursorSelection: () => ({ dispose: () => undefined }),
    }
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.ts'))
    FileEditorRegistry.register(input, editor as never)
    disposables.push({ dispose: () => input.dispose() })
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: input },
    } as never)
    return { inst, editor, collection, notify }
  }

  function run(inst: InstantiationService, commandId: string) {
    return inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(commandId)!.handler(accessor)
    })
  }

  it('registers commands and Alt+Down/Alt+Up keybindings', () => {
    disposables.push(registerAction2(FindWordAtCursorNextAction))
    disposables.push(registerAction2(FindWordAtCursorPreviousAction))
    expect(CommandsRegistry.getCommand(FindWordAtCursorNextAction.ID)).toBeDefined()
    expect(CommandsRegistry.getCommand(FindWordAtCursorPreviousAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('alt+down')).toBe(FindWordAtCursorNextAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('alt+up')).toBe(FindWordAtCursorPreviousAction.ID)
  })

  it('strict next jumps to the next whole-word match keeping the cursor delta', async () => {
    disposables.push(registerAction2(FindWordAtCursorNextAction))
    // "foo" at line1 col1, line1 col9, line2 col5; cursor at line1 col10 (delta 1).
    const { inst, editor } = setup({
      text: 'foo bar foo\nbaz foo qux',
      selection: fakeSelection(1, 10, 1, 10),
    })
    await run(inst, FindWordAtCursorNextAction.ID)
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 6 })
    expect(editor.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledWith({
      lineNumber: 2,
      column: 6,
    })
    expect(editor.setSelection).not.toHaveBeenCalled()
  })

  it('strict next wraps around to the first match', async () => {
    disposables.push(registerAction2(FindWordAtCursorNextAction))
    const { inst, editor } = setup({
      text: 'foo bar foo\nbaz foo qux',
      selection: fakeSelection(2, 5, 2, 5),
    })
    await run(inst, FindWordAtCursorNextAction.ID)
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 1, column: 1 })
  })

  it('strict previous ignores substring hits like foobar', async () => {
    disposables.push(registerAction2(FindWordAtCursorPreviousAction))
    // cursor on the last "foo" (line2 col5); "foobar" at line1 col1 must not match.
    const { inst, editor } = setup({
      text: 'foobar foo\nbar foo',
      selection: fakeSelection(2, 5, 2, 5),
    })
    await run(inst, FindWordAtCursorPreviousAction.ID)
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 1, column: 8 })
  })

  it('loose next selects the match (case insensitive) and paints the highlight', async () => {
    disposables.push(registerAction2(FindWordAtCursorNextAction))
    // select "alpha" at col4..9; next case-insensitive substring hit is "ALPHA" at col13.
    const { inst, editor, collection } = setup({
      text: 'xx alpha yy ALPHA zz alpha',
      selection: fakeSelection(1, 4, 1, 9),
    })
    await run(inst, FindWordAtCursorNextAction.ID)
    const target = {
      startLineNumber: 1,
      startColumn: 13,
      endLineNumber: 1,
      endColumn: 18,
    }
    expect(editor.setSelection).toHaveBeenCalledWith(target)
    expect(editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(target)
    expect(collection.set).toHaveBeenCalledTimes(1)
    expect(collection.set).toHaveBeenCalledWith([
      { range: target, options: { className: 'findWordAtCursorMatch' } },
    ])
    expect(editor.setPosition).not.toHaveBeenCalled()
  })

  it('sole occurrence notifies "No more matches." and does not move', async () => {
    disposables.push(registerAction2(FindWordAtCursorNextAction))
    const { inst, editor, notify } = setup({
      text: 'unique word here',
      selection: fakeSelection(1, 2, 1, 2),
    })
    await run(inst, FindWordAtCursorNextAction.ID)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Info }))
    expect(editor.setPosition).not.toHaveBeenCalled()
    expect(editor.setSelection).not.toHaveBeenCalled()
  })

  it('multi-line selection → silent no-op', async () => {
    disposables.push(registerAction2(FindWordAtCursorNextAction))
    const { inst, editor, notify } = setup({
      text: 'ab\ncd',
      selection: fakeSelection(1, 1, 2, 2),
    })
    await run(inst, FindWordAtCursorNextAction.ID)
    expect(editor.setPosition).not.toHaveBeenCalled()
    expect(editor.setSelection).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('no active editor → silent no-op', async () => {
    disposables.push(registerAction2(FindWordAtCursorNextAction))
    const services = new ServiceCollection()
    services.set(IFileService, stubFs() as never)
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: null },
    } as never)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)
    await expect(Promise.resolve(run(inst, FindWordAtCursorNextAction.ID))).resolves.not.toThrow()
  })
})
