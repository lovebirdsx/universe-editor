/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/textSearch/textSearchMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DisposableTracker, setDisposableTracker, URI } from '@universe-editor/platform'
import { resolveRipgrepDiskPath, TextSearchMainService } from '../textSearchMainService.js'

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

describe('TextSearchMainService', () => {
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

    const svc = new TextSearchMainService()
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

    const svc = new TextSearchMainService()
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
        String.raw`C:\Users\kuro\AppData\Local\Programs\Universe Editor\resources\app.asar\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
      ),
    ).toBe(
      String.raw`C:\Users\kuro\AppData\Local\Programs\Universe Editor\resources\app.asar.unpacked\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
    )

    expect(
      resolveRipgrepDiskPath(
        String.raw`C:\Users\kuro\AppData\Local\Programs\Universe Editor\resources\node_modules.asar\@vscode\ripgrep-win32-x64\bin\rg.exe`,
      ),
    ).toBe(
      String.raw`C:\Users\kuro\AppData\Local\Programs\Universe Editor\resources\node_modules.asar.unpacked\@vscode\ripgrep-win32-x64\bin\rg.exe`,
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
        String.raw`C:\Users\kuro\AppData\Local\Programs\Universe Editor\resources\app.asar.unpacked\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
      ),
    ).toBe(
      String.raw`C:\Users\kuro\AppData\Local\Programs\Universe Editor\resources\app.asar.unpacked\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`,
    )
  })

  it('applies configured search excludes in the main process', async () => {
    const root = await makeTempRoot()
    const visible = path.join(root, 'src.txt')
    const ignored = path.join(root, 'ignored.txt')
    await writeFile(visible, 'shared-token\n')
    await writeFile(ignored, 'shared-token\n')

    const svc = new TextSearchMainService()
    const complete = await svc.search({
      ...baseQuery(root, 'shared-token'),
      configurationExcludes: ['ignored.txt'],
    })

    expect(complete.results).toHaveLength(1)
    expect(path.normalize(URI.revive(complete.results[0]!.resource)!.fsPath)).toBe(
      path.normalize(visible),
    )
  })

  it('emits progress for the matching session', async () => {
    const root = await makeTempRoot()
    await writeFile(path.join(root, 'a.txt'), 'progress-token\n')
    const svc = new TextSearchMainService()
    const events: string[] = []
    const sub = svc.onDidSearchProgress((event) => events.push(event.sessionId))

    await svc.search(baseQuery(root, 'progress-token'))
    sub.dispose()

    expect(events.some((id) => id.startsWith('test-'))).toBe(true)
  })

  it('disposes child-process event subscriptions after a search completes', async () => {
    const root = await makeTempRoot()
    await writeFile(path.join(root, 'a.txt'), 'leak-check-token\n')
    const svc = new TextSearchMainService()
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
})
