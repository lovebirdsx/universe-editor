/*---------------------------------------------------------------------------------------------
 *  Tests for the bounded external-reload read.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, type IFileService } from '@universe-editor/platform'
import {
  MAX_EXTERNAL_RELOAD_BYTES,
  isTooLargeForExternalReload,
  readForExternalReload,
} from '../externalReload.js'

type Files = Pick<IFileService, 'stat' | 'readFileText'>

function makeFiles(opts: {
  size?: number
  text?: string
  statError?: boolean
  readError?: boolean
}): Files & { reads: number } {
  const files = {
    reads: 0,
    async stat(resource: URI) {
      if (opts.statError) throw new Error('ENOENT')
      return {
        resource,
        isFile: true,
        isDirectory: false,
        size: opts.size ?? 0,
        mtime: 1,
      }
    },
    async readFileText() {
      files.reads++
      if (opts.readError) throw new Error('EIO')
      return opts.text ?? ''
    },
  }
  return files as unknown as Files & { reads: number }
}

const uri = URI.file('/ws/a.txt')

describe('externalReload', () => {
  it('treats the ceiling itself as readable and one byte over as not', () => {
    expect(isTooLargeForExternalReload(MAX_EXTERNAL_RELOAD_BYTES)).toBe(false)
    expect(isTooLargeForExternalReload(MAX_EXTERNAL_RELOAD_BYTES + 1)).toBe(true)
  })

  it('reads a file under the ceiling', async () => {
    const files = makeFiles({ size: 10, text: 'hello' })
    expect(await readForExternalReload(files, uri)).toEqual({ ok: true, text: 'hello' })
    expect(files.reads).toBe(1)
  })

  it('refuses a file over the ceiling without reading it', async () => {
    const files = makeFiles({ size: MAX_EXTERNAL_RELOAD_BYTES + 1 })
    expect(await readForExternalReload(files, uri)).toEqual({ ok: false, reason: 'too-large' })
    expect(files.reads).toBe(0)
  })

  it('reports a missing file as unreadable rather than too large', async () => {
    const files = makeFiles({ statError: true })
    expect(await readForExternalReload(files, uri)).toEqual({ ok: false, reason: 'unreadable' })
    expect(files.reads).toBe(0)
  })

  it('reports a failed read as unreadable', async () => {
    const files = makeFiles({ size: 10, readError: true })
    expect(await readForExternalReload(files, uri)).toEqual({ ok: false, reason: 'unreadable' })
    expect(files.reads).toBe(1)
  })
})
