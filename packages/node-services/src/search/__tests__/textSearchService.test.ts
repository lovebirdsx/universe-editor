/*---------------------------------------------------------------------------------------------
 *  Tests for packages/node-services/src/search/textSearchService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, cpus } from 'node:os'
import path from 'node:path'
import { DisposableTracker, setDisposableTracker, URI } from '@universe-editor/platform'
import {
  resolveSearchThreads,
  rgErrorMsgForDisplay,
  resolveRipgrepDiskPath,
  TextSearchService,
} from '../textSearchService.js'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ue-text-search-'))
  tempRoots.push(root)
  return root
}

async function tryDirLink(target: string, linkPath: string): Promise<boolean> {
  // 'dir' for POSIX symlinks; 'junction' is the privilege-free fallback on
  // Windows (real symlinks there need developer mode / elevation).
  for (const type of ['dir', 'junction'] as const) {
    try {
      await symlink(target, linkPath, type)
      return true
    } catch {
      // try the next link flavour
    }
  }
  return false
}

function baseQuery(root: string, pattern: string) {
  return {
    sessionId: `test-${Date.now()}`,
    root: URI.file(root).toJSON(),
    pattern,
    isRegex: false,
    matchCase: true,
    matchWholeWord: false,
    includes: [],
    excludes: [],
    configurationExcludes: [],
  }
}

describe('TextSearchService', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    )
  })

  it('searches beyond the old renderer-side 1000-file cap', async () => {
    const root = await makeTempRoot()
    const target = path.join(root, 'file-1005.txt')

    for (let start = 0; start < 1010; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 1010 - start) }, async (_, offset) => {
          const i = start + offset
          const file = path.join(root, `file-${i}.txt`)
          await writeFile(file, file === target ? 'needle-from-deep-file\n' : 'ordinary content\n')
        }),
      )
    }

    const svc = new TextSearchService()
    try {
      const complete = await svc.search(baseQuery(root, 'needle-from-deep-file'))

      expect(complete.results).toHaveLength(1)
      expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(target),
      )
      expect(complete.progress.limitHit).toBeUndefined()
    } finally {
      svc.dispose()
    }
  }, 15_000)

  it('follows symbolic links so matches reachable only through a link are found', async () => {
    const root = await makeTempRoot()
    const external = await makeTempRoot()
    await writeFile(path.join(external, 'data.txt'), 'symlink-needle\n')
    if (!(await tryDirLink(external, path.join(root, 'linkdir')))) return // 无 symlink 权限 → 跳过

    const svc = new TextSearchService()
    try {
      const complete = await svc.search(baseQuery(root, 'symlink-needle'))

      expect(complete.results).toHaveLength(1)
      expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(path.join(root, 'linkdir', 'data.txt')),
      )
    } finally {
      svc.dispose()
    }
  }, 15_000)

  it('resolves packaged ripgrep binaries from app.asar.unpacked', () => {
    expect(
      resolveRipgrepDiskPath(
        String.raw`C:\Users\testuser\AppData\Local\Programs\Universe Editor\resources\app.asar\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
      ),
    ).toBe(
      String.raw`C:\Users\testuser\AppData\Local\Programs\Universe Editor\resources\app.asar.unpacked\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
    )

    expect(
      resolveRipgrepDiskPath(
        String.raw`C:\Users\testuser\AppData\Local\Programs\Universe Editor\resources\node_modules.asar\@vscode\ripgrep-win32-x64\bin\rg.exe`,
      ),
    ).toBe(
      String.raw`C:\Users\testuser\AppData\Local\Programs\Universe Editor\resources\node_modules.asar.unpacked\@vscode\ripgrep-win32-x64\bin\rg.exe`,
    )
  })

  it('keeps unpacked or development ripgrep paths stable', () => {
    expect(
      resolveRipgrepDiskPath(
        String.raw`C:\repo\apps\editor\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
      ),
    ).toBe(String.raw`C:\repo\apps\editor\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`)

    expect(
      resolveRipgrepDiskPath(
        String.raw`C:\Users\testuser\AppData\Local\Programs\Universe Editor\resources\app.asar.unpacked\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
      ),
    ).toBe(
      String.raw`C:\Users\testuser\AppData\Local\Programs\Universe Editor\resources\app.asar.unpacked\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
    )
  })

  it('applies configured search excludes in the main process', async () => {
    const root = await makeTempRoot()
    const visible = path.join(root, 'src.txt')
    const ignored = path.join(root, 'ignored.txt')
    await writeFile(visible, 'shared-token\n')
    await writeFile(ignored, 'shared-token\n')

    const svc = new TextSearchService()
    const complete = await svc.search({
      ...baseQuery(root, 'shared-token'),
      configurationExcludes: ['ignored.txt'],
    })

    expect(complete.results).toHaveLength(1)
    expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
      path.normalize(visible),
    )
  })

  async function makeIncludeFixture(root: string, token: string): Promise<string> {
    const dir = path.join(root, 'd.地图', '110')
    await mkdir(dir, { recursive: true })
    const inside = path.join(dir, 'map.json')
    await writeFile(inside, `${token}\n`)
    await writeFile(path.join(root, 'outside.txt'), `${token}\n`)
    return inside
  }

  it('finds matches under a directory include pattern (VSCode include semantics)', async () => {
    const root = await makeTempRoot()
    const inside = await makeIncludeFixture(root, 'include-dir-token')

    const svc = new TextSearchService()
    try {
      const complete = await svc.search({
        ...baseQuery(root, 'include-dir-token'),
        includes: ['d.地图/110'],
      })
      expect(complete.results).toHaveLength(1)
      expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(inside),
      )
    } finally {
      svc.dispose()
    }
  })

  it('matches a bare directory name include at any depth', async () => {
    const root = await makeTempRoot()
    const inside = await makeIncludeFixture(root, 'include-bare-token')

    const svc = new TextSearchService()
    try {
      const complete = await svc.search({
        ...baseQuery(root, 'include-bare-token'),
        includes: ['110'],
      })
      expect(complete.results).toHaveLength(1)
      expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(inside),
      )
    } finally {
      svc.dispose()
    }
  })

  it('anchors ./-prefixed includes at the workspace root', async () => {
    const root = await makeTempRoot()
    const inside = await makeIncludeFixture(root, 'include-rooted-token')

    const svc = new TextSearchService()
    try {
      const hit = await svc.search({
        ...baseQuery(root, 'include-rooted-token'),
        includes: ['./d.地图/110'],
      })
      expect(hit.results).toHaveLength(1)
      expect(path.normalize(URI.revive(hit.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(inside),
      )

      // 同名目录在非根路径时不应被 ./ 形式命中。
      const nested = path.join(root, 'nested', 'd.地图', '110')
      await mkdir(nested, { recursive: true })
      await writeFile(path.join(nested, 'map.json'), 'include-rooted-token\n')
      const stillRooted = await svc.search({
        ...baseQuery(root, 'include-rooted-token'),
        includes: ['./d.地图/110'],
      })
      expect(stillRooted.results).toHaveLength(1)
      expect(path.normalize(URI.revive(stillRooted.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(inside),
      )
    } finally {
      svc.dispose()
    }
  })

  it('accepts backslash-separated include paths on Windows', async () => {
    const root = await makeTempRoot()
    const inside = await makeIncludeFixture(root, 'include-backslash-token')

    const svc = new TextSearchService()
    try {
      const complete = await svc.search({
        ...baseQuery(root, 'include-backslash-token'),
        includes: ['d.地图\\110'],
      })
      expect(complete.results).toHaveLength(1)
      expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(inside),
      )
    } finally {
      svc.dispose()
    }
  })

  it('keeps extension glob includes working', async () => {
    const root = await makeTempRoot()
    const dir = path.join(root, 'src')
    await mkdir(dir, { recursive: true })
    const tsFile = path.join(dir, 'a.ts')
    await writeFile(tsFile, 'include-glob-token\n')
    await writeFile(path.join(dir, 'a.txt'), 'include-glob-token\n')

    const svc = new TextSearchService()
    try {
      const complete = await svc.search({
        ...baseQuery(root, 'include-glob-token'),
        includes: ['*.ts'],
      })
      expect(complete.results).toHaveLength(1)
      expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(tsFile),
      )
    } finally {
      svc.dispose()
    }
  })

  it('emits progress for the matching session', async () => {
    const root = await makeTempRoot()
    await writeFile(path.join(root, 'a.txt'), 'progress-token\n')
    const svc = new TextSearchService()
    const events: string[] = []
    const sub = svc.onDidSearchProgress((event) => events.push(event.sessionId))

    await svc.search(baseQuery(root, 'progress-token'))
    sub.dispose()

    expect(events.some((id) => id.startsWith('test-'))).toBe(true)
  })

  it('emits incremental result batches for the matching session', async () => {
    const root = await makeTempRoot()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeFile(path.join(root, `hit-${i}.txt`), 'incremental-token\n'),
      ),
    )
    const svc = new TextSearchService()
    const batchedFiles: string[] = []
    const query = baseQuery(root, 'incremental-token')
    const sub = svc.onDidSearchResults((event) => {
      if (event.sessionId !== query.sessionId) return
      for (const fm of event.results) {
        batchedFiles.push(URI.revive(fm.resource)!.toString())
      }
    })

    try {
      const complete = await svc.search(query)
      // Every file surfaced through an incremental batch (deduped by resource),
      // and the batches never exceed the authoritative final result set.
      expect(complete.results.length).toBe(20)
      expect(new Set(batchedFiles).size).toBe(20)
    } finally {
      sub.dispose()
      svc.dispose()
    }
  }, 15_000)

  it('disposes child-process event subscriptions after a search completes', async () => {
    const root = await makeTempRoot()
    await writeFile(path.join(root, 'a.txt'), 'leak-check-token\n')
    const svc = new TextSearchService()
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    try {
      await svc.search(baseQuery(root, 'leak-check-token'))
      expect(tracker.computeLeakingDisposables()).toBeUndefined()
    } finally {
      setDisposableTracker(null)
      svc.dispose()
    }
  })

  it('resolves search threads from the configured value or CPU cores minus 2', () => {
    expect(resolveSearchThreads(4)).toBe(4)
    expect(resolveSearchThreads(3.9)).toBe(3)
    expect(resolveSearchThreads(undefined)).toBe(Math.max(1, cpus().length - 2))
    expect(resolveSearchThreads(0)).toBe(Math.max(1, cpus().length - 2))
    // Degenerate values must never reach ripgrep as a non-positive --threads.
    expect(resolveSearchThreads(-5)).toBeGreaterThanOrEqual(1)
  })

  it('classifies fatal ripgrep stderr but ignores non-fatal path errors', () => {
    // Broken symlink / unreadable path → non-fatal, results should be kept.
    expect(
      rgErrorMsgForDisplay(
        String.raw`rg: .\node_modules\eslint-plugin-rule: 系统找不到指定的文件。 (os error 2)`,
      ),
    ).toBeUndefined()
    expect(rgErrorMsgForDisplay('rg: /some/path: No such file or directory (os error 2)')).toBe(
      undefined,
    )

    // Genuinely fatal diagnostics → surface as a failure.
    expect(rgErrorMsgForDisplay('regex parse error:\n  unclosed group')).toContain(
      'regex parse error',
    )
    expect(rgErrorMsgForDisplay('grep config error: unknown encoding: utf-99')).toBe(
      'Unknown encoding: utf-99',
    )
    expect(rgErrorMsgForDisplay('error parsing glob **/[: bad glob')).toContain('rror parsing glob')
  })

  it('keeps results when ripgrep follows a broken symlink and exits non-zero', async () => {
    const root = await makeTempRoot()
    await writeFile(path.join(root, 'a.txt'), 'broken-link-token\n')
    // Point a link at a target that does not exist so --follow makes ripgrep
    // emit an "os error 2" on stderr and exit with code 2, mirroring the pnpm
    // dangling-symlink case from the field report.
    if (!(await tryDirLink(path.join(root, 'does-not-exist'), path.join(root, 'dangling')))) return

    const svc = new TextSearchService()
    try {
      const complete = await svc.search(baseQuery(root, 'broken-link-token'))
      expect(complete.results).toHaveLength(1)
      expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
        path.normalize(path.join(root, 'a.txt')),
      )
    } finally {
      svc.dispose()
    }
  }, 15_000)
})
