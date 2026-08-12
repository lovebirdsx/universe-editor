import { describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@universe-editor/extensions-common'
import {
  NullLogger,
  URI,
  relativePathUnder,
  type IFileSearchComplete,
  type IFileSearchService,
  type IFileService,
} from '@universe-editor/platform'
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

const noSearch: IFileSearchService = {
  _serviceBrand: undefined,
  search: () => Promise.reject(new Error('unexpected search call')),
}

function makeFs(
  cwd: string | undefined,
  policy: IAcpPathPolicy,
  files: IFileService,
  fileSearch: IFileSearchService = noSearch,
  defaultExcludes: () => readonly string[] = () => [],
): MainThreadFs {
  return new MainThreadFs(cwd, policy, files, fileSearch, defaultExcludes, new NullLogger())
}

describe('MainThreadFs', () => {
  it('reads a file and base64-encodes its bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    const fs = makeFs('/repo', allowPolicy, fakeFiles({ readFile: () => Promise.resolve(bytes) }))
    expect(await fs.$readFile('/repo/a.bin')).toBe(bytesToBase64(bytes))
  })

  it('decodes base64 before writing', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const writeFile = vi.fn((_resource: unknown, _content: unknown) => Promise.resolve())
    const fs = makeFs('/repo', allowPolicy, fakeFiles({ writeFile }))
    await fs.$writeFile('/repo/a.bin', bytesToBase64(bytes))
    const written = writeFile.mock.calls[0]?.[1] as Uint8Array
    expect(Array.from(written)).toEqual([9, 8, 7])
  })

  it('maps stat and directory entries to the wire shape', async () => {
    const fs = makeFs(
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
    const fs = makeFs(
      '/repo',
      allowPolicy,
      fakeFiles({ readFile: () => Promise.resolve(new Uint8Array()) }),
    )
    await expect(fs.$readFile('/repo/secret/.env')).rejects.toThrow(/denied/)
  })

  it('rejects when no workspace folder is open', async () => {
    const fs = makeFs(undefined, allowPolicy, fakeFiles({}))
    await expect(fs.$readFile('/anything')).rejects.toThrow(/open workspace/)
  })

  it('rejects a workspace-internal symlink whose real path escapes to a sensitive prefix', async () => {
    // The literal path passes the text policy (no "secret" in it), but realpath
    // resolves the symlink to a sensitive location the policy then denies.
    const fs = makeFs(
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
    const fs = makeFs(
      '/repo',
      allowPolicy,
      fakeFiles({
        realpath: () => Promise.resolve(URI.file('/repo/sub/target.txt')),
        readFile: () => Promise.resolve(bytes),
      }),
    )
    expect(await fs.$readFile('/repo/link')).toBe(bytesToBase64(bytes))
  })

  it('re-checks the policy against the realpath URI (envelope revives it across IPC)', async () => {
    // IFileService.realpath returns a URI; in production it crosses ProxyChannel,
    // whose envelope now auto-revives $mid-stamped URIs (see ipc.test.ts URI
    // marshalling round-trip). So MainThreadFs receives a real URI and reads
    // `.fsPath` off it directly — no local revive. A policy that rejects empty
    // targets (mirroring AcpPathPolicy's "empty path" guard) would turn red if
    // `.fsPath` came back empty, catching a regression in that contract.
    const bytes = new Uint8Array([3, 4])
    const emptyAwarePolicy: IAcpPathPolicy = {
      _serviceBrand: undefined,
      check: (_cwd, target) =>
        target ? { ok: true, normalized: target } : { ok: false, reason: 'empty path' },
    }
    const fs = makeFs(
      '/repo',
      emptyAwarePolicy,
      fakeFiles({
        realpath: () => Promise.resolve(URI.file('/repo/sub/target.txt')),
        readFile: () => Promise.resolve(bytes),
      }),
    )
    expect(await fs.$readFile('/repo/link')).toBe(bytesToBase64(bytes))
  })

  it('canonicalizes the cwd before the real-path containment check (Windows 8.3 short name)', async () => {
    // On Windows CI the temp workspace lives under an 8.3 short name (e.g.
    // `RUNNER~1`), so `_cwd` is `C:/Users/RUNNER~1/Temp/ws` while realpath always
    // returns the long form `C:/Users/runneradmin/Temp/ws`. If the guard compared
    // the real target against the literal short-name cwd it would read as
    // "escapes workspace root" and deny every gated read of an unopened file —
    // the markdownLsp / peekNavigation regression seen only on Windows CI.
    const shortCwd = 'C:/Users/RUNNER~1/Temp/ws'
    const bytes = new Uint8Array([5, 6])
    // Real policy semantics: only containment under the *given* cwd is allowed.
    const platform = 'win32' as const
    const containmentPolicy: IAcpPathPolicy = {
      _serviceBrand: undefined,
      check: (cwd, target) =>
        relativePathUnder(cwd, target, platform) !== null
          ? { ok: true, normalized: target }
          : { ok: false, reason: `path escapes workspace root (${cwd})` },
    }
    const fs = makeFs(
      shortCwd,
      containmentPolicy,
      fakeFiles({
        // realpath canonicalizes both the cwd and the target to the long form.
        realpath: (resource) => {
          const p = (resource as URI).fsPath.replace(/\\/g, '/')
          return Promise.resolve(URI.file(p.replace('/RUNNER~1/', '/runneradmin/')))
        },
        readFile: () => Promise.resolve(bytes),
      }),
    )
    // The ext host requests a file under the (short-name) workspace root, so the
    // literal target passes the text policy; the real-path re-check must pass too
    // once the cwd is canonicalized to match realpath's long form.
    expect(await fs.$readFile(`${shortCwd}/other.md`)).toBe(bytesToBase64(bytes))
  })

  it('falls back to the text decision when the file service has no realpath', async () => {
    const bytes = new Uint8Array([7])
    const fs = makeFs('/repo', allowPolicy, fakeFiles({ readFile: () => Promise.resolve(bytes) }))
    expect(await fs.$readFile('/repo/a.bin')).toBe(bytesToBase64(bytes))
  })

  describe('$rename / $copy', () => {
    it('guards both source and target before delegating', async () => {
      const rename = vi.fn((_from: URI, _to: URI, _opts: { overwrite: boolean }) =>
        Promise.resolve(),
      )
      const fs = makeFs('/repo', allowPolicy, fakeFiles({ rename }))
      await fs.$rename('/repo/a.ts', '/repo/b.ts', false)
      expect(rename).toHaveBeenCalledTimes(1)
      const call = rename.mock.calls[0]
      expect(call?.[0]?.fsPath).toBe('/repo/a.ts')
      expect(call?.[1]?.fsPath).toBe('/repo/b.ts')
      expect(call?.[2]).toEqual({ overwrite: false })
    })

    it('denies a rename whose target hits a sensitive prefix', async () => {
      const rename = vi.fn(() => Promise.resolve())
      const fs = makeFs('/repo', allowPolicy, fakeFiles({ rename }))
      await expect(fs.$rename('/repo/a.ts', '/repo/secret/a.ts', true)).rejects.toThrow(/denied/)
      expect(rename).not.toHaveBeenCalled()
    })

    it('copies with the overwrite flag forwarded', async () => {
      const copy = vi.fn((_from: URI, _to: URI, _opts: { overwrite: boolean }) => Promise.resolve())
      const fs = makeFs('/repo', allowPolicy, fakeFiles({ copy }))
      await fs.$copy('/repo/a.ts', '/repo/b.ts', true)
      const call = copy.mock.calls[0]
      expect(call?.[0]?.fsPath).toBe('/repo/a.ts')
      expect(call?.[1]?.fsPath).toBe('/repo/b.ts')
      expect(call?.[2]).toEqual({ overwrite: true })
    })
  })

  describe('$findFiles', () => {
    function fakeSearch(
      matches: Array<{ fsPath: string; relativePath: string }>,
    ): IFileSearchService & { lastQueryExcludes: () => readonly string[] | undefined } {
      let excludes: readonly string[] | undefined
      return {
        _serviceBrand: undefined,
        search: (query) => {
          excludes = query.excludes
          const complete: IFileSearchComplete = {
            results: matches.map((m) => ({
              resource: URI.file(m.fsPath),
              fsPath: m.fsPath,
              relativePath: m.relativePath,
              basename: m.relativePath.split('/').pop() ?? '',
              score: 0,
            })),
            limitHit: false,
            filesWalked: matches.length,
            directoriesWalked: 0,
            durationMs: 0,
          }
          return Promise.resolve(complete)
        },
        lastQueryExcludes: () => excludes,
      }
    }

    it('filters the live enumeration by the include glob', async () => {
      const search = fakeSearch([
        { fsPath: '/repo/src/a.ts', relativePath: 'src/a.ts' },
        { fsPath: '/repo/src/a.css', relativePath: 'src/a.css' },
        { fsPath: '/repo/README.md', relativePath: 'README.md' },
      ])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      expect(await fs.$findFiles('**/*.ts', null, null)).toEqual(['/repo/src/a.ts'])
    })

    it('uses the default search excludes when exclude is null', async () => {
      const search = fakeSearch([])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search, () => ['**/node_modules/**'])
      await fs.$findFiles('**/*.ts', null, null)
      expect(search.lastQueryExcludes()).toEqual(['**/node_modules/**'])
    })

    it('passes an empty exclude list through as "no excludes"', async () => {
      const search = fakeSearch([])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search, () => ['**/node_modules/**'])
      await fs.$findFiles('**/*.ts', [], null)
      expect(search.lastQueryExcludes()).toEqual([])
    })

    it('truncates at maxResults after glob filtering', async () => {
      const search = fakeSearch([
        { fsPath: '/repo/a.ts', relativePath: 'a.ts' },
        { fsPath: '/repo/b.md', relativePath: 'b.md' },
        { fsPath: '/repo/c.ts', relativePath: 'c.ts' },
      ])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      expect(await fs.$findFiles('*.ts', [], 1)).toEqual(['/repo/a.ts'])
    })

    it('rejects when no workspace folder is open', async () => {
      const fs = makeFs(undefined, allowPolicy, fakeFiles({}))
      await expect(fs.$findFiles('**/*.ts', null, null)).rejects.toThrow(/open workspace/)
    })
  })
})
