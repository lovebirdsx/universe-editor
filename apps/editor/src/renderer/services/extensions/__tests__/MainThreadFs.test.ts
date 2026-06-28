import { describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@universe-editor/extensions-common'
import { URI, type IFileService } from '@universe-editor/platform'
import { MainThreadFs } from '../MainThreadFs.js'
import type { IAcpPathPolicy } from '../../acp/acpPathPolicy.js'

const allowPolicy: IAcpPathPolicy = {
  _serviceBrand: undefined,
  check: (_cwd, target) =>
    target.includes('secret')
      ? { ok: false, reason: 'path resolves under sensitive prefix' }
      : { ok: true, normalized: target },
}

function fakeFiles(overrides: Partial<IFileService>): IFileService {
  return overrides as IFileService
}

describe('MainThreadFs', () => {
  it('reads a file and base64-encodes its bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    const fs = new MainThreadFs(
      '/repo',
      allowPolicy,
      fakeFiles({ readFile: () => Promise.resolve(bytes) }),
    )
    expect(await fs.$readFile('/repo/a.bin')).toBe(bytesToBase64(bytes))
  })

  it('decodes base64 before writing', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const writeFile = vi.fn((_resource: unknown, _content: unknown) => Promise.resolve())
    const fs = new MainThreadFs('/repo', allowPolicy, fakeFiles({ writeFile }))
    await fs.$writeFile('/repo/a.bin', bytesToBase64(bytes))
    const written = writeFile.mock.calls[0]?.[1] as Uint8Array
    expect(Array.from(written)).toEqual([9, 8, 7])
  })

  it('maps stat and directory entries to the wire shape', async () => {
    const fs = new MainThreadFs(
      '/repo',
      allowPolicy,
      fakeFiles({
        stat: () =>
          Promise.resolve({
            resource: undefined as never,
            isFile: false,
            isDirectory: true,
            size: 42,
            mtime: 100,
          }),
        list: () =>
          Promise.resolve([
            { name: 'sub', isFile: false, isDirectory: true },
            { name: 'f.ts', isFile: true, isDirectory: false },
          ]),
      }),
    )
    expect(await fs.$stat('/repo/sub')).toEqual({ type: 'dir', size: 42, mtime: 100 })
    expect(await fs.$readDirectory('/repo')).toEqual([
      ['sub', 'dir'],
      ['f.ts', 'file'],
    ])
  })

  it('rejects paths the policy denies', async () => {
    const fs = new MainThreadFs(
      '/repo',
      allowPolicy,
      fakeFiles({ readFile: () => Promise.resolve(new Uint8Array()) }),
    )
    await expect(fs.$readFile('/repo/secret/.env')).rejects.toThrow(/denied/)
  })

  it('rejects when no workspace folder is open', async () => {
    const fs = new MainThreadFs(undefined, allowPolicy, fakeFiles({}))
    await expect(fs.$readFile('/anything')).rejects.toThrow(/open workspace/)
  })

  it('rejects a workspace-internal symlink whose real path escapes to a sensitive prefix', async () => {
    // The literal path passes the text policy (no "secret" in it), but realpath
    // resolves the symlink to a sensitive location the policy then denies.
    const fs = new MainThreadFs(
      '/repo',
      allowPolicy,
      fakeFiles({
        realpath: () => Promise.resolve(URI.file('/home/user/secret/.ssh/id_rsa')),
        readFile: () => Promise.resolve(new Uint8Array()),
      }),
    )
    await expect(fs.$readFile('/repo/link')).rejects.toThrow(/denied \(real path\)/)
  })

  it('allows a symlink whose real path stays inside the workspace', async () => {
    const bytes = new Uint8Array([1, 2])
    const fs = new MainThreadFs(
      '/repo',
      allowPolicy,
      fakeFiles({
        realpath: () => Promise.resolve(URI.file('/repo/sub/target.txt')),
        readFile: () => Promise.resolve(bytes),
      }),
    )
    expect(await fs.$readFile('/repo/link')).toBe(bytesToBase64(bytes))
  })

  it('falls back to the text decision when the file service has no realpath', async () => {
    const bytes = new Uint8Array([7])
    const fs = new MainThreadFs(
      '/repo',
      allowPolicy,
      fakeFiles({ readFile: () => Promise.resolve(bytes) }),
    )
    expect(await fs.$readFile('/repo/a.bin')).toBe(bytesToBase64(bytes))
  })
})
