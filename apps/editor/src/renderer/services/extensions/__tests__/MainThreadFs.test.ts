import { describe, expect, it, vi } from 'vitest'
import {
  bytesToBase64,
  compileGlobMatcher,
  type IRelativePatternDto,
} from '@universe-editor/extensions-common'
import {
  CancellationTokenSource,
  NullLogger,
  REMOTE_SCHEME,
  URI,
  relativePathUnder,
  type HostPlatform,
  type IFileSearchComplete,
  type IFileSearchQuery,
  type IFileSearchService,
  type IFileService,
  type IFileStat,
  type ILogger,
} from '@universe-editor/platform'
import { MainThreadFs } from '../MainThreadFs.js'
import {
  AcpPathPolicy,
  type AcpPathPolicyEnv,
  type IAcpPathPolicy,
} from '../../acp/acpPathPolicy.js'
import type {
  IRemoteStatusService,
  RemoteEnvironmentDto,
} from '../../../../shared/ipc/remoteStatusService.js'

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

/** A plain-file `IFileStat`; only type/size/mtime reach the wire shape. */
function fileStat(overrides: Partial<IFileStat> = {}): IFileStat {
  return {
    resource: undefined as never,
    isFile: true,
    isDirectory: false,
    size: 0,
    mtime: 0,
    ...overrides,
  }
}

const noSearch: IFileSearchService = {
  _serviceBrand: undefined,
  search: () => Promise.reject(new Error('unexpected search call')),
}

/** A remote host environment DTO; only `os`/`homeDir` drive the path policy. */
function remoteEnvDto(overrides: Partial<RemoteEnvironmentDto> = {}): RemoteEnvironmentDto {
  return {
    os: 'linux',
    arch: 'x64',
    homeDir: '/home/user',
    tmpDir: '/tmp',
    pathCaseSensitive: true,
    serverVersion: '1.0.0',
    ...overrides,
  }
}

/** `getEnvironment` stub; `env: null` mimics "authority not connected". */
function fakeRemoteStatus(
  env: RemoteEnvironmentDto | null = null,
  impl?: () => Promise<RemoteEnvironmentDto | null>,
): IRemoteStatusService & { calls: () => number } {
  const getEnvironment = vi.fn(impl ?? (() => Promise.resolve(env)))
  return {
    _serviceBrand: undefined,
    getEnvironment,
    calls: () => getEnvironment.mock.calls.length,
  } as unknown as IRemoteStatusService & { calls: () => number }
}

/** Records every `check` call so tests can assert the policy env we pass. */
function recordingPolicy(): IAcpPathPolicy & {
  calls: () => Array<{ cwd: string; target: string; env: AcpPathPolicyEnv | undefined }>
} {
  const calls: Array<{ cwd: string; target: string; env: AcpPathPolicyEnv | undefined }> = []
  return {
    _serviceBrand: undefined,
    check: (cwd, target, env) => {
      calls.push({ cwd, target, env })
      return { ok: true, normalized: target }
    },
    calls: () => calls,
  }
}

function makeFs(
  cwd: string | undefined,
  policy: IAcpPathPolicy,
  files: IFileService,
  fileSearch: IFileSearchService = noSearch,
  defaultExcludes: () => readonly string[] = () => [],
  logger: ILogger = new NullLogger(),
  platform: HostPlatform = 'linux',
  authority: string | undefined = undefined,
  remoteStatus: IRemoteStatusService = fakeRemoteStatus(null),
): MainThreadFs {
  return new MainThreadFs(
    cwd,
    authority,
    policy,
    files,
    fileSearch,
    defaultExcludes,
    logger,
    platform,
    remoteStatus,
  )
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
          Promise.resolve(fileStat({ isFile: false, isDirectory: true, size: 42, mtime: 100 })),
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
    /**
     * Test-local emulation of the engine-side pruning FileSearchMainService
     * performs with rg `-g !glob`: gitignore semantics — a glob excludes a path
     * when it matches the path itself, everything beneath a directory it names
     * (expandExcludeGlob's `<glob>/**` half), or any ancestor directory.
     */
    function enginePruned(relativePath: string, excludes: readonly string[]): boolean {
      const segments = relativePath.split('/')
      return excludes.some((raw) => {
        const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
        if (!normalized) return false
        const matcher = compileGlobMatcher(normalized)
        if (matcher(relativePath)) return true
        if (normalized.endsWith('/**')) return false
        if (compileGlobMatcher(`${normalized}/**`)(relativePath)) return true
        for (let i = 1; i < segments.length; i++) {
          if (matcher(segments.slice(0, i).join('/'))) return true
        }
        return false
      })
    }

    function fakeSearch(
      matches: Array<{ fsPath: string; relativePath: string }>,
    ): IFileSearchService & { lastQueryExcludes: () => readonly string[] | undefined } {
      let excludes: readonly string[] | undefined
      return {
        _serviceBrand: undefined,
        search: (query) => {
          excludes = query.excludes
          // The real engine prunes `query.excludes` during the walk, before its
          // own maxResults cap — excluded entries never consume the cap.
          const candidates = matches.filter(
            (m) => !enginePruned(m.relativePath, query.excludes ?? []),
          )
          const cap = query.maxResults ?? Number.POSITIVE_INFINITY
          const limited = candidates.slice(0, cap)
          const truncated = candidates.length > limited.length
          const complete: IFileSearchComplete = {
            results: limited.map((m) => ({
              resource: URI.file(m.fsPath),
              fsPath: m.fsPath,
              relativePath: m.relativePath,
              basename: m.relativePath.split('/').pop() ?? '',
              score: 0,
            })),
            limitHit: truncated,
            filesWalked: candidates.length,
            directoriesWalked: 0,
            durationMs: 0,
            ...(truncated ? { stopReason: 'maxResults' as const } : {}),
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

    it('roots the enumeration at a RelativePattern base and matches base-relative paths', async () => {
      const roots: string[] = []
      const search: IFileSearchService = {
        _serviceBrand: undefined,
        search: (query: IFileSearchQuery) => {
          roots.push(query.root.fsPath)
          const complete: IFileSearchComplete = {
            results: [
              {
                resource: URI.file('/repo/src/a.ts'),
                fsPath: '/repo/src/a.ts',
                relativePath: 'a.ts',
                basename: 'a.ts',
                score: 0,
              },
              {
                resource: URI.file('/repo/src/deep/b.ts'),
                fsPath: '/repo/src/deep/b.ts',
                relativePath: 'deep/b.ts',
                basename: 'b.ts',
                score: 0,
              },
            ],
            limitHit: false,
            filesWalked: 2,
            directoriesWalked: 1,
            durationMs: 0,
          }
          return Promise.resolve(complete)
        },
      }
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      const include: IRelativePatternDto = {
        base: URI.file('/repo/src').toJSON(),
        pattern: '*.ts',
      }
      const result = await fs.$findFiles(include, null, null)
      expect(roots).toEqual(['/repo/src'])
      // Slashless pattern matches the basename at any depth below the base.
      expect(result).toEqual(['/repo/src/a.ts', '/repo/src/deep/b.ts'])
    })

    it('returns no results (not an RPC error) for a RelativePattern base outside the workspace', async () => {
      const search = fakeSearch([])
      const warn = vi.fn()
      const logger = { ...new NullLogger(), warn } as unknown as ILogger
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search, () => [], logger)
      await expect(
        fs.$findFiles({ base: URI.file('/elsewhere').toJSON(), pattern: '*.ts' }, null, null),
      ).resolves.toEqual([])
      // The containment guard still holds: the enumeration never ran.
      expect(search.lastQueryExcludes()).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/escapes the workspace/)
    })

    it('returns no results for a RelativePattern base whose real path escapes the workspace', async () => {
      const search = fakeSearch([])
      const warn = vi.fn()
      const logger = { ...new NullLogger(), warn } as unknown as ILogger
      const fs = makeFs(
        '/repo',
        allowPolicy,
        fakeFiles({
          realpath: (resource) => {
            const p = (resource as URI).fsPath
            return Promise.resolve(URI.file(p === '/repo' ? '/repo' : '/outside/target'))
          },
        }),
        search,
        () => [],
        logger,
      )
      await expect(
        fs.$findFiles({ base: URI.file('/repo/link').toJSON(), pattern: '*.ts' }, null, null),
      ).resolves.toEqual([])
      expect(search.lastQueryExcludes()).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/escapes the workspace/)
    })

    it('scopes a RelativePattern exclude to its own base', async () => {
      const search = fakeSearch([
        { fsPath: '/repo/generated/a.ts', relativePath: 'generated/a.ts' },
        { fsPath: '/repo/generated/deep/b.ts', relativePath: 'generated/deep/b.ts' },
        { fsPath: '/repo/src/generated/keep.ts', relativePath: 'src/generated/keep.ts' },
        { fsPath: '/repo/src/c.ts', relativePath: 'src/c.ts' },
      ])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      const exclude: IRelativePatternDto = {
        base: URI.file('/repo/generated').toJSON(),
        pattern: '**',
      }
      const result = await fs.$findFiles('**/*.ts', [exclude], null)
      expect(result).toEqual(['/repo/src/generated/keep.ts', '/repo/src/c.ts'])
    })

    it('prunes string excludes in the engine (defaults are not mixed in)', async () => {
      const search = fakeSearch([
        { fsPath: '/repo/node_modules/pkg/index.ts', relativePath: 'node_modules/pkg/index.ts' },
        { fsPath: '/repo/src/a.ts', relativePath: 'src/a.ts' },
      ])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search, () => ['**/dist/**'])
      const result = await fs.$findFiles('**/*.ts', ['**/node_modules/**', '*.log'], null)
      expect(search.lastQueryExcludes()).toEqual(['**/node_modules/**', '*.log'])
      expect(result).toEqual(['/repo/src/a.ts'])
    })

    it('prunes directories named by a slashless exclude at any depth', async () => {
      const search = fakeSearch([
        { fsPath: '/repo/node_modules/pkg/index.ts', relativePath: 'node_modules/pkg/index.ts' },
        { fsPath: '/repo/lib/node_modules/x.ts', relativePath: 'lib/node_modules/x.ts' },
        { fsPath: '/repo/src/a.ts', relativePath: 'src/a.ts' },
      ])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      expect(await fs.$findFiles('**/*.ts', ['node_modules'], null)).toEqual(['/repo/src/a.ts'])
    })

    it('folds a RelativePattern exclude into an engine glob beneath its base', async () => {
      const search = fakeSearch([])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      await fs.$findFiles(
        '**/*.ts',
        [{ base: URI.file('/repo/generated').toJSON(), pattern: '**' }],
        null,
      )
      expect(search.lastQueryExcludes()).toEqual(['generated/**'])
      // A slashless pattern keeps its "basename at any depth (beneath the base)"
      // meaning once anchored under the folded prefix.
      await fs.$findFiles(
        '**/*.ts',
        [{ base: URI.file('/repo/gen').toJSON(), pattern: '*.log' }],
        null,
      )
      expect(search.lastQueryExcludes()).toEqual(['gen/**/*.log'])
    })

    it('folds a RelativePattern exclude against a RelativePattern include base', async () => {
      const seen: { roots: string[]; excludes: readonly string[] | undefined } = {
        roots: [],
        excludes: undefined,
      }
      const search: IFileSearchService = {
        _serviceBrand: undefined,
        search: (query) => {
          seen.roots.push(query.root.fsPath)
          seen.excludes = query.excludes
          const complete: IFileSearchComplete = {
            results: [],
            limitHit: false,
            filesWalked: 0,
            directoriesWalked: 0,
            durationMs: 0,
          }
          return Promise.resolve(complete)
        },
      }
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      await fs.$findFiles(
        { base: URI.file('/repo/src').toJSON(), pattern: '*.ts' },
        [{ base: URI.file('/repo/src/gen').toJSON(), pattern: '**' }],
        null,
      )
      expect(seen.roots).toEqual(['/repo/src'])
      expect(seen.excludes).toEqual(['gen/**'])
    })

    it('drops a RelativePattern exclude whose base lies outside the enumeration root', async () => {
      const search = fakeSearch([{ fsPath: '/repo/src/a.ts', relativePath: 'src/a.ts' }])
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      const result = await fs.$findFiles(
        '**/*.ts',
        [{ base: URI.file('/elsewhere').toJSON(), pattern: '**' }],
        null,
      )
      expect(search.lastQueryExcludes()).toEqual([])
      expect(result).toEqual(['/repo/src/a.ts'])
    })

    it('excluded entries never consume the enumeration cap', async () => {
      // 100k excluded entries ahead of one real hit: when excludes were applied
      // by renderer-side post-filtering they ate the whole engine-side cap and
      // the real hit was silently truncated away (plus a misleading warn).
      const matches = [
        ...Array.from({ length: 100_000 }, (_, i) => ({
          fsPath: `/repo/node_modules/${i}.ts`,
          relativePath: `node_modules/${i}.ts`,
        })),
        { fsPath: '/repo/src/keep.ts', relativePath: 'src/keep.ts' },
      ]
      const warn = vi.fn()
      const logger = { ...new NullLogger(), warn } as unknown as ILogger
      const search = fakeSearch(matches)
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search, () => [], logger)
      const result = await fs.$findFiles('**/*.ts', ['**/node_modules/**'], null)
      expect(result).toEqual(['/repo/src/keep.ts'])
      expect(warn).not.toHaveBeenCalled()
    })

    it('forwards the RPC token to the underlying search (cancel kills the walk)', async () => {
      let seenToken: unknown
      const search: IFileSearchService = {
        _serviceBrand: undefined,
        search: (_query: IFileSearchQuery, token?: unknown) => {
          seenToken = token
          const complete: IFileSearchComplete = {
            results: [],
            limitHit: false,
            filesWalked: 0,
            directoriesWalked: 0,
            durationMs: 0,
            ...(token !== undefined ? { stopReason: 'canceled' as const } : {}),
          }
          return Promise.resolve(complete)
        },
      }
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search)
      const cts = new CancellationTokenSource()
      await fs.$findFiles('**/*.ts', null, null, cts.token)
      expect(seenToken).toBe(cts.token)
    })

    it('logs the truncation details when the enumeration cap is hit', async () => {
      const warn = vi.fn()
      const logger = { ...new NullLogger(), warn } as unknown as ILogger
      const search: IFileSearchService = {
        _serviceBrand: undefined,
        search: () => {
          const complete: IFileSearchComplete = {
            results: [],
            limitHit: true,
            filesWalked: 100_000,
            directoriesWalked: 5_000,
            durationMs: 0,
            stopReason: 'maxResults',
          }
          return Promise.resolve(complete)
        },
      }
      const fs = makeFs('/repo', allowPolicy, fakeFiles({}), search, () => [], logger)
      await fs.$findFiles('**/*.ts', null, null)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/truncated at the 100000-entry cap/)
      expect(warn.mock.calls[0]?.[0]).toMatch(/maxResults/)
    })
  })

  /**
   * A remote workspace hosts the extension host on the remote server, and the
   * `workspace.fs` wire carries bare path strings — which the host↔renderer codec
   * never transforms (only $mid-stamped UriComponents get translated). So the
   * paths arriving here are the *remote* host's native paths and must resolve to
   * `remote-ssh:` resources; `URI.file` would send them to the client's own disk.
   */
  describe('remote workspace', () => {
    const authority = 'ssh+devbox'
    const remoteUri = (path: string): URI => URI.from({ scheme: REMOTE_SCHEME, authority, path })

    it('routes gated reads to the remote authority instead of the local disk', async () => {
      const stat = vi.fn((_resource: URI) => Promise.resolve(fileStat({ size: 3, mtime: 1 })))
      const fs = makeFs(
        '/home/user/repo',
        allowPolicy,
        fakeFiles({ stat }),
        noSearch,
        () => [],
        new NullLogger(),
        'win32', // a Windows client talking to a POSIX remote
        authority,
        fakeRemoteStatus(remoteEnvDto()),
      )
      await fs.$stat('/home/user/repo/docs/x.md')
      expect(stat).toHaveBeenCalledTimes(1)
      const resource = stat.mock.calls[0]?.[0] as unknown as URI
      expect(resource.scheme).toBe(REMOTE_SCHEME)
      expect(resource.authority).toBe(authority)
      expect(resource.path).toBe('/home/user/repo/docs/x.md')
    })

    it('routes rename and copy endpoints to the remote authority', async () => {
      const rename = vi.fn(() => Promise.resolve())
      const copy = vi.fn(() => Promise.resolve())
      const fs = makeFs(
        '/home/user/repo',
        allowPolicy,
        fakeFiles({ rename, copy }),
        noSearch,
        () => [],
        new NullLogger(),
        'win32',
        authority,
        fakeRemoteStatus(remoteEnvDto()),
      )
      await fs.$rename('/home/user/repo/a.ts', '/home/user/repo/b.ts', false)
      await fs.$copy('/home/user/repo/a.ts', '/home/user/repo/c.ts', true)
      for (const spy of [rename, copy]) {
        for (const arg of (spy.mock.calls[0] as unknown as URI[]).slice(0, 2)) {
          expect(arg.scheme).toBe(REMOTE_SCHEME)
          expect(arg.authority).toBe(authority)
        }
      }
    })

    it("passes the remote host's platform and home to the path policy", async () => {
      const policy = recordingPolicy()
      const fs = makeFs(
        '/home/user/repo',
        policy,
        fakeFiles({ stat: () => Promise.resolve(fileStat()) }),
        noSearch,
        () => [],
        new NullLogger(),
        'win32',
        authority,
        fakeRemoteStatus(remoteEnvDto({ homeDir: '/home/dev' })),
      )
      await fs.$stat('/home/user/repo/a.md')
      const call = policy.calls()[0]
      expect(call?.cwd).toBe('/home/user/repo')
      expect(call?.env).toEqual({ platform: 'linux', home: '/home/dev' })
    })

    it('leaves the policy env unset for a local workspace', async () => {
      const policy = recordingPolicy()
      const fs = makeFs('/repo', policy, fakeFiles({ stat: () => Promise.resolve(fileStat()) }))
      await fs.$stat('/repo/a.md')
      const call = policy.calls()[0]
      expect(call?.env).toBeUndefined()
    })

    it('resolves the remote environment once per connection', async () => {
      const remoteStatus = fakeRemoteStatus(remoteEnvDto())
      const fs = makeFs(
        '/home/user/repo',
        allowPolicy,
        fakeFiles({ readFile: () => Promise.resolve(new Uint8Array([1])) }),
        noSearch,
        () => [],
        new NullLogger(),
        'linux',
        authority,
        remoteStatus,
      )
      await fs.$readFile('/home/user/repo/a.md')
      await fs.$readFile('/home/user/repo/b.md')
      expect((remoteStatus as unknown as { calls: () => number }).calls()).toBe(1)
    })

    it('degrades to POSIX facts when the remote environment is unavailable', async () => {
      const policy = recordingPolicy()
      const fs = makeFs(
        '/home/user/repo',
        policy,
        fakeFiles({ stat: () => Promise.resolve(fileStat()) }),
        noSearch,
        () => [],
        new NullLogger(),
        'win32',
        authority,
        fakeRemoteStatus(null, () => Promise.reject(new Error('not connected'))),
      )
      await fs.$stat('/home/user/repo/a.md')
      expect(policy.calls()[0]?.env).toEqual({ platform: 'linux', home: '/' })
    })

    it('retries the environment after a degrade so a reconnect restores the guards', async () => {
      // The host survives transparent reconnects, and an authority mid-reconnect
      // reports no environment. Memoizing that answer would leave the remote
      // sensitive-prefix probes blind for the rest of the connection's life.
      let connected = false
      const policy = recordingPolicy()
      const remoteStatus = fakeRemoteStatus(null, () =>
        Promise.resolve(connected ? remoteEnvDto({ homeDir: '/home/dev' }) : null),
      )
      const fs = makeFs(
        '/home/user/repo',
        policy,
        fakeFiles({ stat: () => Promise.resolve(fileStat()) }),
        noSearch,
        () => [],
        new NullLogger(),
        'linux',
        authority,
        remoteStatus,
      )
      await fs.$stat('/home/user/repo/a.md')
      expect(policy.calls()[0]?.env).toEqual({ platform: 'linux', home: '/' })

      connected = true
      await fs.$stat('/home/user/repo/b.md')
      expect(policy.calls()[1]?.env).toEqual({ platform: 'linux', home: '/home/dev' })
      // …and the healed answer is memoized again.
      await fs.$stat('/home/user/repo/c.md')
      expect((remoteStatus as unknown as { calls: () => number }).calls()).toBe(2)
    })

    it('keeps the real-path defense in depth on a remote host', async () => {
      const fs = makeFs(
        '/home/user/repo',
        allowPolicy,
        fakeFiles({
          realpath: () => Promise.resolve(remoteUri('/home/user/secret/.ssh/id_rsa')),
          readFile: () => Promise.resolve(new Uint8Array()),
        }),
        noSearch,
        () => [],
        new NullLogger(),
        'win32',
        authority,
        fakeRemoteStatus(remoteEnvDto()),
      )
      await expect(fs.$readFile('/home/user/repo/link')).rejects.toThrow(/denied \(real path\)/)
    })

    it('roots the enumeration at the remote workspace, not a local path', async () => {
      const roots: URI[] = []
      const search: IFileSearchService = {
        _serviceBrand: undefined,
        search: (query: IFileSearchQuery) => {
          roots.push(query.root)
          const complete: IFileSearchComplete = {
            results: [
              {
                resource: remoteUri('/home/user/repo/src/a.ts'),
                // The remote search channel reports server-native fs paths, which
                // are exactly what the remote-hosted extension expects back.
                fsPath: '/home/user/repo/src/a.ts',
                relativePath: 'src/a.ts',
                basename: 'a.ts',
                score: 0,
              },
            ],
            limitHit: false,
            filesWalked: 1,
            directoriesWalked: 1,
            durationMs: 0,
          }
          return Promise.resolve(complete)
        },
      }
      const fs = makeFs(
        '/home/user/repo',
        allowPolicy,
        fakeFiles({}),
        search,
        () => [],
        new NullLogger(),
        'win32',
        authority,
        fakeRemoteStatus(remoteEnvDto()),
      )
      expect(await fs.$findFiles('**/*.ts', null, null)).toEqual(['/home/user/repo/src/a.ts'])
      expect(roots[0]?.scheme).toBe(REMOTE_SCHEME)
      expect(roots[0]?.authority).toBe(authority)
      expect(roots[0]?.path).toBe('/home/user/repo')
    })

    it('accepts a RelativePattern base that arrived in the remote URI space', async () => {
      // The host sends `file:` bases; the codec translates them to remote-ssh
      // before they reach us, so rejecting non-`file:` bases would break every
      // remote RelativePattern search.
      const roots: URI[] = []
      const search: IFileSearchService = {
        _serviceBrand: undefined,
        search: (query: IFileSearchQuery) => {
          roots.push(query.root)
          const complete: IFileSearchComplete = {
            results: [],
            limitHit: false,
            filesWalked: 0,
            directoriesWalked: 0,
            durationMs: 0,
          }
          return Promise.resolve(complete)
        },
      }
      const warn = vi.fn()
      const logger = { ...new NullLogger(), warn } as unknown as ILogger
      const fs = makeFs(
        '/home/user/repo',
        allowPolicy,
        fakeFiles({}),
        search,
        () => [],
        logger,
        'win32',
        authority,
        fakeRemoteStatus(remoteEnvDto()),
      )
      const include: IRelativePatternDto = {
        base: remoteUri('/home/user/repo/src').toJSON(),
        pattern: '*.ts',
      }
      await fs.$findFiles(include, null, null)
      expect(warn).not.toHaveBeenCalled()
      expect(roots[0]?.scheme).toBe(REMOTE_SCHEME)
      expect(roots[0]?.path).toBe('/home/user/repo/src')
    })

    it('still rejects a remote RelativePattern base outside the workspace', async () => {
      const search = fakeSearchRecorder()
      const warn = vi.fn()
      const logger = { ...new NullLogger(), warn } as unknown as ILogger
      const fs = makeFs(
        '/home/user/repo',
        new AcpPathPolicy({ platform: 'win32', home: 'C:/Users/client' }),
        fakeFiles({}),
        search,
        () => [],
        logger,
        'win32',
        authority,
        fakeRemoteStatus(remoteEnvDto()),
      )
      await expect(
        fs.$findFiles({ base: remoteUri('/home/other').toJSON(), pattern: '*.ts' }, null, null),
      ).resolves.toEqual([])
      expect(search.ran()).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it("compares containment with the remote host's case-sensitivity, not the client's", async () => {
      // A POSIX remote browsed from Windows. The policy here is permissive on
      // purpose so the only thing under test is the containment re-check in
      // _resolveRelativePatternBase: with the client's case-insensitive rules
      // `/home/Dev/repo/src` folds into the root `/home/dev/repo` and gets
      // enumerated; the remote's own `linux` facts keep it out.
      const search = fakeSearchRecorder()
      const warn = vi.fn()
      const logger = { ...new NullLogger(), warn } as unknown as ILogger
      const fs = makeFs(
        '/home/dev/repo',
        allowPolicy,
        fakeFiles({}),
        search,
        () => [],
        logger,
        'win32',
        authority,
        fakeRemoteStatus(remoteEnvDto({ homeDir: '/home/dev' })),
      )
      await expect(
        fs.$findFiles(
          { base: remoteUri('/home/Dev/repo/src').toJSON(), pattern: '*.ts' },
          null,
          null,
        ),
      ).resolves.toEqual([])
      expect(search.ran()).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/escapes the workspace folder/)
    })

    describe('Windows remote host', () => {
      // A remote-ssh URI encodes a drive letter with a leading slash (`/C:/…`),
      // so the workspace root arrives as `/C:/Users/x` while the host reports
      // native `C:\Users\x\…`. relativePathUnder compares drive letters with an
      // anchored regex that never matches the `/C:` form — without normalizing
      // the containment base, every gated read on a Windows remote is denied.
      const winAuthority = 'ssh+winbox'
      const realPolicy = new AcpPathPolicy({ platform: 'win32', home: 'C:/Users/client' })
      const winEnv = remoteEnvDto({
        os: 'win32',
        homeDir: 'C:/Users/remote',
        pathCaseSensitive: false,
      })

      it('allows a native Windows path under the remote workspace root', async () => {
        const stat = vi.fn((_resource: URI) => Promise.resolve(fileStat({ size: 1, mtime: 1 })))
        const fs = makeFs(
          '/C:/Users/x/repo',
          realPolicy,
          fakeFiles({ stat }),
          noSearch,
          () => [],
          new NullLogger(),
          'win32',
          winAuthority,
          fakeRemoteStatus(winEnv),
        )
        await fs.$stat('C:\\Users\\x\\repo\\docs\\a.md')
        const resource = stat.mock.calls[0]?.[0] as unknown as URI
        expect(resource.scheme).toBe(REMOTE_SCHEME)
        expect(resource.authority).toBe(winAuthority)
        expect(resource.path).toBe('/C:/Users/x/repo/docs/a.md')
      })

      it("denies a path outside the remote workspace and the remote host's own secrets", async () => {
        const fs = makeFs(
          '/C:/Users/x/repo',
          realPolicy,
          fakeFiles({ stat: () => Promise.resolve(fileStat({ size: 1, mtime: 1 })) }),
          noSearch,
          () => [],
          new NullLogger(),
          'win32',
          winAuthority,
          fakeRemoteStatus(winEnv),
        )
        await expect(fs.$stat('C:\\Users\\other\\a.md')).rejects.toThrow(/escapes workspace root/)
      })

      it("guards the remote host's sensitive prefixes, not the client's", async () => {
        // The remote home is `C:/Users/remote`; a client-home policy would let
        // the remote host's own `.ssh` through.
        const fs = makeFs(
          '/C:/Users/remote',
          realPolicy,
          fakeFiles({ readFile: () => Promise.resolve(new Uint8Array()) }),
          noSearch,
          () => [],
          new NullLogger(),
          'win32',
          winAuthority,
          fakeRemoteStatus(winEnv),
        )
        await expect(fs.$readFile('C:\\Users\\remote\\.ssh\\id_rsa')).rejects.toThrow(/denied/)
      })

      it('roots the enumeration at the drive-form remote path', async () => {
        const roots: URI[] = []
        const search: IFileSearchService = {
          _serviceBrand: undefined,
          search: (query: IFileSearchQuery) => {
            roots.push(query.root)
            return Promise.resolve({
              results: [],
              limitHit: false,
              filesWalked: 0,
              directoriesWalked: 0,
              durationMs: 0,
            } satisfies IFileSearchComplete)
          },
        }
        const fs = makeFs(
          '/C:/Users/x/repo',
          realPolicy,
          fakeFiles({}),
          search,
          () => [],
          new NullLogger(),
          'win32',
          winAuthority,
          fakeRemoteStatus(winEnv),
        )
        await fs.$findFiles('**/*.ts', null, null)
        expect(roots[0]?.path).toBe('/C:/Users/x/repo')
      })
    })
  })
})

/** Minimal search stub that only records whether the engine ever ran. */
function fakeSearchRecorder(): IFileSearchService & { ran: () => boolean } {
  let ran = false
  return {
    _serviceBrand: undefined,
    search: () => {
      ran = true
      return Promise.resolve({
        results: [],
        limitHit: false,
        filesWalked: 0,
        directoriesWalked: 0,
        durationMs: 0,
      } satisfies IFileSearchComplete)
    },
    ran: () => ran,
  }
}
