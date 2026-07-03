/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/opener/OpenerService.ts
 *
 *  Focus on the two pieces that carry real risk: parseTarget (string → URI, with
 *  the `:line:col` suffix folded into a selection fragment) and CommandOpener's
 *  trust gate (untrusted callers must never run a command).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { extractSelection, type ICommandService } from '@universe-editor/platform'
import { CommandOpener, parseTarget } from '../OpenerService.js'

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
