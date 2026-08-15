/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/opener/OpenerService.ts
 *
 *  Focus on the two pieces that carry real risk: parseTarget (string → URI, with
 *  the `:line:col` suffix folded into a selection fragment) and CommandOpener's
 *  trust gate (untrusted callers must never run a command).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  URI,
  extractSelection,
  withSelection,
  type ICommandService,
  type IEditorGroupsService,
  type IEditorResolverService,
  type IFileService,
  type IInstantiationService,
  type IUriIdentityService,
  type IWindowsService,
} from '@universe-editor/platform'
import { CommandOpener, FileOpener, parseTarget } from '../OpenerService.js'

// The selection branch walks the editor stack (groups / FileEditorRegistry / Monaco
// mount) that renderer-node lacks; stub its two module seams to test the gate alone.
vi.mock('../../editor/openInLockAwareGroup.js', () => ({
  openInLockAwareGroup: vi.fn(),
}))

vi.mock('../../editor/revealEditorPosition.js', () => ({
  findExistingFileEditor: vi.fn(() => undefined),
  revealSelectionInInput: vi.fn(),
}))

describe('parseTarget', () => {
  it('parses an http URL as-is', () => {
    expect(parseTarget('https://example.com/x').scheme).toBe('https')
  })

  it('parses a command URI as-is', () => {
    const uri = parseTarget('command:foo.bar?%5B1%5D')
    expect(uri.scheme).toBe('command')
    expect(uri.path).toBe('foo.bar')
  })

  it('treats a Windows drive path as a file, not a scheme', () => {
    const uri = parseTarget('D:/repo/src/a.ts')
    expect(uri.scheme).toBe('file')
    expect(uri.fsPath.replace(/\\/g, '/').toLowerCase()).toBe('d:/repo/src/a.ts')
  })

  it('folds a :line:col suffix into a selection fragment', () => {
    const { selection, uri } = extractSelection(parseTarget('/repo/a.ts:10:5'))
    expect(uri.scheme).toBe('file')
    expect(selection).toEqual({ startLineNumber: 10, startColumn: 5 })
  })

  it('folds a line-only suffix into a fragment', () => {
    expect(extractSelection(parseTarget('/repo/a.ts:42')).selection).toEqual({
      startLineNumber: 42,
      startColumn: 1,
    })
  })

  it('leaves a bare path without a selection', () => {
    expect(extractSelection(parseTarget('/repo/a.ts')).selection).toBeUndefined()
  })

  it('expands a leading ~ to home when homeDir is provided', () => {
    const uri = parseTarget('~/foo.md', 'C:/Users/u')
    expect(uri.scheme).toBe('file')
    expect(uri.fsPath).toBe('C:/Users/u/foo.md')
  })

  it('keeps ~ verbatim when homeDir is not provided', () => {
    const uri = parseTarget('~/foo.md')
    expect(uri.scheme).toBe('file')
    // URI.file treats `~` as a relative segment and prefixes `/` — the key is
    // that `~` is NOT expanded to home.
    expect(uri.fsPath).toBe('/~/foo.md')
  })

  it('expands ~ while preserving a :line:col selection', () => {
    const { selection, uri } = extractSelection(parseTarget('~/foo.md:10:5', 'C:/Users/u'))
    expect(uri.fsPath).toBe('C:/Users/u/foo.md')
    expect(selection).toEqual({ startLineNumber: 10, startColumn: 5 })
  })
})

describe('CommandOpener trust gate', () => {
  function make(): { opener: CommandOpener; execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn().mockResolvedValue(undefined)
    const commands = { executeCommand: execute } as unknown as ICommandService
    return { opener: new CommandOpener(commands), execute }
  }

  it('ignores non-command URIs', async () => {
    const { opener, execute } = make()
    expect(await opener.open(parseTarget('https://example.com'))).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks commands by default (no allowCommands)', async () => {
    const { opener, execute } = make()
    expect(await opener.open(parseTarget('command:evil'))).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('runs a command when allowCommands is true', async () => {
    const { opener, execute } = make()
    await opener.open(parseTarget('command:foo'), { allowCommands: true })
    expect(execute).toHaveBeenCalledWith('foo')
  })

  it('honors a whitelist array', async () => {
    const { opener, execute } = make()
    await opener.open(parseTarget('command:blocked'), { allowCommands: ['allowed'] })
    expect(execute).not.toHaveBeenCalled()
    await opener.open(parseTarget('command:allowed'), { allowCommands: ['allowed'] })
    expect(execute).toHaveBeenCalledWith('allowed')
  })

  it('decodes JSON array args into positional arguments', async () => {
    const { opener, execute } = make()
    const query = encodeURIComponent(JSON.stringify([1, 'two', { a: 3 }]))
    await opener.open(parseTarget(`command:foo?${query}`), { allowCommands: true })
    expect(execute).toHaveBeenCalledWith('foo', 1, 'two', { a: 3 })
  })

  it('wraps a non-array JSON arg into a single argument', async () => {
    const { opener, execute } = make()
    const query = encodeURIComponent(JSON.stringify({ a: 1 }))
    await opener.open(parseTarget(`command:foo?${query}`), { allowCommands: true })
    expect(execute).toHaveBeenCalledWith('foo', { a: 1 })
  })
})

describe('FileOpener scheme gate', () => {
  function makeFileOpener(): {
    opener: FileOpener
    openEditor: ReturnType<typeof vi.fn>
  } {
    const openEditor = vi.fn()
    const groups = { groups: [] }
    const uriIdentity = { isEqual: vi.fn(() => false) }
    const instantiation = {
      createInstance: vi.fn(() => ({ isDisposed: false, onWillDispose: vi.fn() })),
    }
    const opener = new FileOpener(
      groups as unknown as IEditorGroupsService,
      uriIdentity as unknown as IUriIdentityService,
      instantiation as unknown as IInstantiationService,
      { stat: vi.fn().mockResolvedValue({ isDirectory: false }) } as unknown as IFileService,
      { openWindow: vi.fn() } as unknown as IWindowsService,
      { openEditor } as unknown as IEditorResolverService,
    )
    return { opener, openEditor }
  }

  it('opens a remote-ssh URI through the resolver', async () => {
    const { opener, openEditor } = makeFileOpener()
    const uri = URI.parse('remote-ssh://myhost/home/u/a.ts')
    expect(await opener.open(uri)).toBe(true)
    expect(openEditor).toHaveBeenCalledWith(uri, { pinned: true })
  })

  it('opens a remote-ssh URI with a selection', async () => {
    const { opener } = makeFileOpener()
    const uri = withSelection(URI.parse('remote-ssh://myhost/home/u/a.ts'), {
      startLineNumber: 5,
      startColumn: 3,
    })
    expect(await opener.open(uri)).toBe(true)
  })

  it('rejects a virtual scheme', async () => {
    const { opener, openEditor } = makeFileOpener()
    expect(await opener.open(URI.parse('universe://x/y'))).toBe(false)
    expect(openEditor).not.toHaveBeenCalled()
  })

  it('still opens a local file URI through the resolver', async () => {
    const { opener, openEditor } = makeFileOpener()
    const uri = URI.file('/repo/a.ts')
    expect(await opener.open(uri)).toBe(true)
    expect(openEditor).toHaveBeenCalledWith(uri, { pinned: true })
  })
})
