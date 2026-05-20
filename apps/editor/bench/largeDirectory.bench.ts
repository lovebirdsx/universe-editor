import { bench, beforeAll, afterAll, describe } from 'vitest'
import { vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URI } from '@universe-editor/platform'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), on: vi.fn(), quit: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

const { FileSystemMainService } =
  await import('../src/main/services/files/fileSystemMainService.js')

let tmpDir: string
let dir1k: string
let dir10k: string
let fileSystem: InstanceType<typeof FileSystemMainService>

async function createFiles(dir: string, count: number): Promise<void> {
  // Create in small sequential batches to avoid EMFILE on Windows
  const batchSize = 50
  for (let base = 0; base < count; base += batchSize) {
    const end = Math.min(base + batchSize, count)
    await Promise.all(
      Array.from({ length: end - base }, (_, i) =>
        fs.writeFile(join(dir, `file-${base + i}.txt`), '', 'utf8'),
      ),
    )
  }
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ue-bench-dir-'))
  dir1k = join(tmpDir, 'dir-1k')
  dir10k = join(tmpDir, 'dir-10k')
  await fs.mkdir(dir1k)
  await fs.mkdir(dir10k)

  await createFiles(dir1k, 1000)
  await createFiles(dir10k, 10000)

  fileSystem = new FileSystemMainService()
}, 60_000)

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('largeDirectory list', () => {
  bench('list 1k entries', async () => {
    await fileSystem.list(URI.file(dir1k))
  })

  bench('list 10k entries', async () => {
    await fileSystem.list(URI.file(dir10k))
  })
})
