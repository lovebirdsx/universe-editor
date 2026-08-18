/*---------------------------------------------------------------------------------------------
 *  Tests for largeFileGuard — verifies the 2MB threshold, binary-vs-text routing
 *  and the dialog wiring for each branch.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  URI,
  type EditorInput,
  type IConfirmOptions,
  type IConfirmResult,
  type IDialogService,
  type IEditorResolverRegistration,
  type IEditorResolverService,
  type IFileService,
  type IFileStat,
} from '@universe-editor/platform'
import { LARGE_FILE_THRESHOLD, confirmOpenFile, isBinaryBytes } from '../largeFileGuard.js'

function makeFs(opts: { stat: IFileStat | Error; head?: Uint8Array | Error }): IFileService {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileHead() {
      if (opts.head === undefined) return new Uint8Array()
      if (opts.head instanceof Error) throw opts.head
      return opts.head
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return true
    },
    async stat() {
      if (opts.stat instanceof Error) throw opts.stat
      return opts.stat
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

function makeDialog(result: IConfirmResult): IDialogService & { calls: IConfirmOptions[] } {
  const calls: IConfirmOptions[] = []
  return {
    _serviceBrand: undefined,
    calls,
    async confirm(opts) {
      calls.push(opts)
      return result
    },
    async prompt() {
      return undefined
    },
  } as IDialogService & { calls: IConfirmOptions[] }
}

/** `undefined` → no registration matches (falls back to the text editor). */
function makeResolver(typeId: string | undefined): IEditorResolverService {
  const regs: IEditorResolverRegistration[] =
    typeId === undefined
      ? []
      : [
          {
            glob: '**/*',
            info: { typeId, displayName: 'x', priority: typeId === 'file' ? 1 : 100 },
            factory: () => ({}) as EditorInput,
          },
        ]
  return {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => regs,
    openEditor: async () => {},
  }
}

const uri = URI.file('/x.txt')

describe('isBinaryBytes', () => {
  it('returns true when the buffer contains a NUL byte', () => {
    expect(isBinaryBytes(new Uint8Array([0x61, 0x00, 0x62]))).toBe(true)
  })

  it('returns false when the buffer has no NUL byte', () => {
    expect(isBinaryBytes(new Uint8Array([0x61, 0x62]))).toBe(false)
  })

  it('returns false for an empty buffer', () => {
    expect(isBinaryBytes(new Uint8Array())).toBe(false)
  })
})

describe('confirmOpenFile', () => {
  it('lets a dedicated editor through without prompting', async () => {
    const fs = makeFs({
      stat: {
        resource: uri,
        isFile: true,
        isDirectory: false,
        size: LARGE_FILE_THRESHOLD * 2,
        mtime: 0,
      },
    })
    const dialog = makeDialog({ confirmed: true, choice: 'primary' })
    const ok = await confirmOpenFile(uri, fs, dialog, makeResolver('image'))
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(0)
  })

  it('returns true without prompting when the file is below the threshold', async () => {
    const fs = makeFs({
      stat: {
        resource: uri,
        isFile: true,
        isDirectory: false,
        size: LARGE_FILE_THRESHOLD - 1,
        mtime: 0,
      },
    })
    const dialog = makeDialog({ confirmed: true, choice: 'primary' })
    const ok = await confirmOpenFile(uri, fs, dialog, makeResolver('file'))
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(0)
  })

  it('prompts with the binary message when the head contains a NUL byte', async () => {
    const fs = makeFs({
      stat: {
        resource: uri,
        isFile: true,
        isDirectory: false,
        size: LARGE_FILE_THRESHOLD * 2,
        mtime: 0,
      },
      head: new Uint8Array([0x00, 0x01]),
    })
    const dialog = makeDialog({ confirmed: true, choice: 'primary' })
    const ok = await confirmOpenFile(uri, fs, dialog, makeResolver('file'))
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(1)
    expect(dialog.calls[0]?.message).toMatch(/binary/)
    expect(dialog.calls[0]?.message).not.toMatch(/MB/)
  })

  it('prompts with the size message when the file is large but not binary', async () => {
    const fs = makeFs({
      stat: {
        resource: uri,
        isFile: true,
        isDirectory: false,
        size: LARGE_FILE_THRESHOLD * 2,
        mtime: 0,
      },
      head: new Uint8Array([0x61, 0x62]),
    })
    const dialog = makeDialog({ confirmed: false, choice: 'cancel' })
    const ok = await confirmOpenFile(uri, fs, dialog, makeResolver('file'))
    expect(ok).toBe(false)
    expect(dialog.calls).toHaveLength(1)
    expect(dialog.calls[0]?.message).toMatch(/MB/)
  })

  it('falls back to allowing the open when stat throws', async () => {
    const fs = makeFs({ stat: new Error('boom') })
    const dialog = makeDialog({ confirmed: false, choice: 'cancel' })
    const ok = await confirmOpenFile(uri, fs, dialog, makeResolver('file'))
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(0)
  })

  it('falls back to the size warning when readFileHead throws', async () => {
    const fs = makeFs({
      stat: {
        resource: uri,
        isFile: true,
        isDirectory: false,
        size: LARGE_FILE_THRESHOLD * 2,
        mtime: 0,
      },
      head: new Error('boom'),
    })
    const dialog = makeDialog({ confirmed: true, choice: 'primary' })
    const ok = await confirmOpenFile(uri, fs, dialog, makeResolver('file'))
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(1)
    expect(dialog.calls[0]?.message).toMatch(/MB/)
  })
})
