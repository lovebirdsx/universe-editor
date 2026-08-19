/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadEditor.$applyWorkspaceEdit: file create/rename/delete
 *  operations flow through to the FileBulkEditService (no wholesale rejection),
 *  a failing application resolves false, and an empty edit short-circuits true.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  IEditorGroupsService,
  IEditorService,
  IFileService,
  IInstantiationService,
  ILogger,
  IThemeService,
  IUriIdentityService,
} from '@universe-editor/platform'
import type { WorkspaceEdit } from 'vscode-languageserver-types'
import { MainThreadEditor, toCssColor, toOverviewRulerColor } from '../MainThreadEditor.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () =>
      Promise.resolve({ Uri: { parse: (s: string) => ({ toString: () => s }) } }),
    peek: () => undefined,
    get: () => {
      throw new Error('[MonacoLoader] not initialized; call ensureInitialized() first')
    },
  },
}))

vi.mock('../../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: {
    peek: () => undefined,
    acquire: () => ({}),
  },
}))

describe('MainThreadEditor.$applyWorkspaceEdit', () => {
  const bulkApply = vi.fn()
  const logger = { warn: vi.fn() } as unknown as ILogger
  let mt: MainThreadEditor

  beforeEach(() => {
    bulkApply.mockReset()
    vi.mocked(logger.warn).mockClear()
    const instantiation = {
      createInstance: () => ({ apply: bulkApply }),
    } as unknown as IInstantiationService
    mt = new MainThreadEditor(
      {} as IEditorService,
      {} as IUriIdentityService,
      undefined,
      {} as IFileService,
      {} as IEditorGroupsService,
      instantiation,
      logger,
      {} as IThemeService,
    )
  })

  it('forwards file operations instead of rejecting them', async () => {
    bulkApply.mockResolvedValue({ isApplied: true, ariaSummary: '' })
    const edit: WorkspaceEdit = {
      documentChanges: [{ kind: 'create', uri: 'file:///new.ts' }],
    }
    await expect(mt.$applyWorkspaceEdit(edit)).resolves.toBe(true)
    expect(bulkApply).toHaveBeenCalledTimes(1)
    const converted = bulkApply.mock.calls[0]![0] as { edits: unknown[] }
    expect(converted.edits).toHaveLength(1)
    const fileEdit = converted.edits[0] as {
      newResource?: { toString(): string }
    }
    expect(fileEdit.newResource?.toString()).toBe('file:///new.ts')
  })

  it('passes interleaved text and file edits through in documentChanges order', async () => {
    bulkApply.mockResolvedValue({ isApplied: true, ariaSummary: '' })
    const edit: WorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///a.ts', version: null },
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              newText: 'x',
            },
          ],
        },
        { kind: 'delete', uri: 'file:///b.ts', options: { recursive: true } },
      ],
    }
    await expect(mt.$applyWorkspaceEdit(edit)).resolves.toBe(true)
    const converted = bulkApply.mock.calls[0]![0] as {
      edits: Record<string, unknown>[]
    }
    expect(converted.edits).toHaveLength(2)
    expect('textEdit' in converted.edits[0]!).toBe(true)
    expect('oldResource' in converted.edits[1]!).toBe(true)
    expect(converted.edits[1]).toMatchObject({ options: { recursive: true } })
  })

  it('resolves false when the bulk edit throws', async () => {
    bulkApply.mockRejectedValue(new Error('disk full'))
    const edit: WorkspaceEdit = {
      documentChanges: [{ kind: 'create', uri: 'file:///new.ts' }],
    }
    await expect(mt.$applyWorkspaceEdit(edit)).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'))
  })

  it('resolves false when the bulk edit reports not applied', async () => {
    bulkApply.mockResolvedValue({ isApplied: false, ariaSummary: '' })
    const edit: WorkspaceEdit = {
      documentChanges: [{ kind: 'create', uri: 'file:///new.ts' }],
    }
    await expect(mt.$applyWorkspaceEdit(edit)).resolves.toBe(false)
  })

  it('short-circuits true for an empty edit without calling the bulk service', async () => {
    await expect(mt.$applyWorkspaceEdit({})).resolves.toBe(true)
    expect(bulkApply).not.toHaveBeenCalled()
  })
})

function makeMainThread(files: Partial<IFileService> = {}): MainThreadEditor {
  return new MainThreadEditor(
    {} as IEditorService,
    {} as IUriIdentityService,
    undefined,
    files as IFileService,
    {} as IEditorGroupsService,
    { createInstance: () => ({ apply: vi.fn() }) } as unknown as IInstantiationService,
    { warn: vi.fn() } as unknown as ILogger,
    {} as IThemeService,
  )
}

describe('MainThreadEditor remote-ssh document opening', () => {
  it('opens a remote-ssh resource through IFileService instead of rejecting it', async () => {
    const readFileText = vi.fn().mockResolvedValue('remote text')
    const mt = makeMainThread({ readFileText })
    await expect(
      mt.$openTextDocument({ scheme: 'remote-ssh', authority: 'wsl+Ubuntu', path: '/home/u/a.ts' }),
    ).resolves.toBeUndefined()
    expect(readFileText).toHaveBeenCalledOnce()
    const resource = readFileText.mock.calls[0]![0] as { scheme: string; authority: string }
    expect(resource.scheme).toBe('remote-ssh')
    expect(resource.authority).toBe('wsl+Ubuntu')
  })

  it('still rejects an unsupported scheme', async () => {
    const mt = makeMainThread()
    await expect(mt.$openTextDocument({ scheme: 'https', path: '/x' })).rejects.toThrow(
      /unsupported URI/,
    )
  })
})

describe('decoration color helpers', () => {
  it('toCssColor passes literals through and maps ThemeColor to a CSS variable', () => {
    expect(toCssColor('#ff0000')).toBe('#ff0000')
    expect(toCssColor({ id: 'myExt.color1' })).toBe('var(--vscode-myExt-color1)')
  })

  it('toOverviewRulerColor passes strings through and resolves ThemeColor ids', () => {
    const getColor = vi.fn(() => ({ toString: () => '#00ff00' }))
    const themeService = { getColorTheme: () => ({ getColor }) } as unknown as IThemeService

    expect(toOverviewRulerColor(undefined, themeService)).toBeUndefined()
    expect(toOverviewRulerColor('#ffffff', themeService)).toBe('#ffffff')
    expect(toOverviewRulerColor({ id: 'myExt.color1' }, themeService)).toBe('#00ff00')
    expect(getColor).toHaveBeenCalledWith('myExt.color1')
  })

  it('toOverviewRulerColor returns undefined when the theme does not define the color', () => {
    const themeService = {
      getColorTheme: () => ({ getColor: () => undefined }),
    } as unknown as IThemeService
    expect(toOverviewRulerColor({ id: 'missing.color' }, themeService)).toBeUndefined()
  })
})
