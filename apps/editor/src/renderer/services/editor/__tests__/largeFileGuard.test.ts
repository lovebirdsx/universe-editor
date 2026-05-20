/*---------------------------------------------------------------------------------------------
 *  Tests for largeFileGuard — verifies the 2MB threshold and dialog wiring.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  URI,
  type IConfirmOptions,
  type IConfirmResult,
  type IDialogService,
  type IFileService,
  type IFileStat,
} from '@universe-editor/platform'
import { LARGE_FILE_THRESHOLD, confirmLargeFile } from '../largeFileGuard.js'

function makeFs(stat: IFileStat | Error): IFileService {
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
      return true
    },
    async stat() {
      if (stat instanceof Error) throw stat
      return stat
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
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

const uri = URI.file('/x.txt')

describe('largeFileGuard', () => {
  it('returns true without prompting when the file is below the threshold', async () => {
    const fs = makeFs({
      resource: uri,
      isFile: true,
      isDirectory: false,
      size: LARGE_FILE_THRESHOLD - 1,
      mtime: 0,
    })
    const dialog = makeDialog({ confirmed: true, choice: 'primary' })
    const ok = await confirmLargeFile(uri, fs, dialog)
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(0)
  })

  it('prompts and returns true when the user confirms', async () => {
    const fs = makeFs({
      resource: uri,
      isFile: true,
      isDirectory: false,
      size: LARGE_FILE_THRESHOLD * 2,
      mtime: 0,
    })
    const dialog = makeDialog({ confirmed: true, choice: 'primary' })
    const ok = await confirmLargeFile(uri, fs, dialog)
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(1)
    expect(dialog.calls[0]?.message).toMatch(/MB/)
  })

  it('prompts and returns false when the user cancels', async () => {
    const fs = makeFs({
      resource: uri,
      isFile: true,
      isDirectory: false,
      size: LARGE_FILE_THRESHOLD * 2,
      mtime: 0,
    })
    const dialog = makeDialog({ confirmed: false, choice: 'cancel' })
    const ok = await confirmLargeFile(uri, fs, dialog)
    expect(ok).toBe(false)
  })

  it('falls back to allowing the open when stat throws', async () => {
    const fs = makeFs(new Error('boom'))
    const dialog = makeDialog({ confirmed: false, choice: 'cancel' })
    const ok = await confirmLargeFile(uri, fs, dialog)
    expect(ok).toBe(true)
    expect(dialog.calls).toHaveLength(0)
  })
})
