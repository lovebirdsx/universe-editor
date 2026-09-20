/*---------------------------------------------------------------------------------------------
 *  Tests for the bounded external-reload read.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, type IFileService } from '@universe-editor/platform'
import { readHeapFlowTotals } from '../../memory/heapFlowCounters.js'
import {
  MAX_EXTERNAL_RELOAD_BYTES,
  isTooLargeForExternalReload,
  readForExternalReload,
} from '../externalReload.js'

type Files = Pick<IFileService, 'stat' | 'readFileText'>

/** Process totals for one flow counter, differenced by the caller. */
function extreload(): { calls: number; chars: number } {
  const reading = readHeapFlowTotals().find((f) => f.name === 'extreload')
  return { calls: reading?.calls ?? 0, chars: reading?.chars ?? 0 }
}

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

  // 重载读盘是那次 OOM 的读侧：一整份文件、它的传输帧与解码，每个 watcher 批次付一次。
  // 不在堆报告里露头，重复发生就只能靠猜。
  it('counts the characters a reload read pulled off disk', async () => {
    const files = makeFiles({ size: 5, text: 'hello' })
    const before = extreload()

    await readForExternalReload(files, uri)

    const after = extreload()
    expect(after.calls - before.calls).toBe(1)
    expect(after.chars - before.chars).toBe(5)
  })

  it('counts nothing for a read the ceiling refused', async () => {
    const files = makeFiles({ size: MAX_EXTERNAL_RELOAD_BYTES + 1 })
    const before = extreload()

    await readForExternalReload(files, uri)

    expect(extreload()).toEqual(before)
  })
})
