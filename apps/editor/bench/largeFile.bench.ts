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
let fileSystem: InstanceType<typeof FileSystemMainService>

const SIZE_1MB = 1 * 1024 * 1024
const SIZE_10MB = 10 * 1024 * 1024
const SIZE_50MB = 50 * 1024 * 1024

async function writeTestFile(path: string, sizeBytes: number): Promise<void> {
  const chunk = Buffer.alloc(65536, 'a')
  const fd = await fs.open(path, 'w')
  let written = 0
  while (written < sizeBytes) {
    const toWrite = Math.min(chunk.length, sizeBytes - written)
    await fd.write(chunk, 0, toWrite)
    written += toWrite
  }
  await fd.close()
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ue-bench-largefile-'))
  fileSystem = new FileSystemMainService()
  await Promise.all([
    writeTestFile(join(tmpDir, '1mb.txt'), SIZE_1MB),
    writeTestFile(join(tmpDir, '10mb.txt'), SIZE_10MB),
    writeTestFile(join(tmpDir, '50mb.txt'), SIZE_50MB),
  ])
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('largeFile read', () => {
  bench('readFileText 1 MB', async () => {
    await fileSystem.readFileText(URI.file(join(tmpDir, '1mb.txt')))
  })

  bench('readFileText 10 MB', async () => {
    await fileSystem.readFileText(URI.file(join(tmpDir, '10mb.txt')))
  })

  bench('readFileText 50 MB', async () => {
    await fileSystem.readFileText(URI.file(join(tmpDir, '50mb.txt')))
  })
})
