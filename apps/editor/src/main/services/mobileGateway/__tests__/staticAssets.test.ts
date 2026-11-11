import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { afterEach, describe, expect, it } from 'vitest'
import { readWebBuildId, webBuildIdFromIndexHtml } from '../staticAssets.js'

const cleanup: Array<() => void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

describe('webBuildIdFromIndexHtml', () => {
  it('extracts the module entry script name regardless of attribute order', () => {
    expect(
      webBuildIdFromIndexHtml(
        '<script type="module" crossorigin src="/assets/index-_PQNuEOX.js"></script>',
      ),
    ).toBe('index-_PQNuEOX.js')
    expect(
      webBuildIdFromIndexHtml("<script src='/assets/index-a.js' type='module'></script>"),
    ).toBe('index-a.js')
  })

  it('ignores classic, inline and src-less module scripts', () => {
    expect(
      webBuildIdFromIndexHtml(
        '<script src="/assets/theme.js"></script><script type="module">void 0</script>',
      ),
    ).toBeUndefined()
  })
})

describe('readWebBuildId', () => {
  it('reads the entry script from index.html and tolerates a missing shell', async () => {
    const dir = mkTempDir('ue-mobile-build-id-')
    cleanup.push(() => removeDirWithRetry(dir))
    expect(await readWebBuildId(dir)).toBeUndefined()

    await fs.writeFile(
      join(dir, 'index.html'),
      '<script type="module" src="/assets/index-abc.js"></script>',
    )
    expect(await readWebBuildId(dir)).toBe('index-abc.js')
  })
})
