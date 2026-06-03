/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/textSearch/textSearchMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { URI } from '@universe-editor/platform'
import { TextSearchMainService } from '../textSearchMainService.js'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ue-text-search-'))
  tempRoots.push(root)
  return root
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
})
