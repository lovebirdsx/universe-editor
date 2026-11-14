import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { NullLogger } from '@universe-editor/platform'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { SessionReportReader } from '../sessionReportReader.js'

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'
const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

async function createRunsDir(): Promise<string> {
  const dir = mkTempDir('ue-session-report-')
  cleanup.push(async () => {
    await removeDirWithRetry(dir)
  })
  const runsDir = join(dir, 'runs')
  await fs.mkdir(runsDir, { recursive: true })
  return runsDir
}

function reader(runsDir: string, maxBytes?: number): SessionReportReader {
  return new SessionReportReader({
    runsDir,
    logger: new NullLogger(),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  })
}

describe('SessionReportReader', () => {
  it('reads report.md from the matching run directory', async () => {
    const runsDir = await createRunsDir()
    const runDir = join(runsDir, RUN_ID)
    await fs.mkdir(runDir)
    await fs.writeFile(join(runDir, 'report.md'), '# Report\n\nbody', 'utf8')

    const result = await reader(runsDir).read(RUN_ID)

    expect(result).toMatchObject({
      ok: true,
      bytes: Buffer.from('# Report\n\nbody', 'utf8'),
    })
    if (!result.ok) throw new Error('expected a readable report')
    expect(result.runDir.endsWith(RUN_ID)).toBe(true)
    expect(result.modifiedAt).toBeGreaterThan(0)
  })

  it('returns an empty report as-is', async () => {
    const runsDir = await createRunsDir()
    const runDir = join(runsDir, RUN_ID)
    await fs.mkdir(runDir)
    await fs.writeFile(join(runDir, 'report.md'), '')

    const result = await reader(runsDir).read(RUN_ID)

    expect(result).toMatchObject({ ok: true, bytes: Buffer.alloc(0) })
  })

  it('rejects run ids that are not UUIDs', async () => {
    const runsDir = await createRunsDir()
    for (const runId of ['', '..', '../outside', '/etc/passwd', 'C:\\Windows', 'run-1']) {
      expect(await reader(runsDir).read(runId)).toEqual({ ok: false, reason: 'not_found' })
    }
  })

  it('rejects missing files and directories named report.md', async () => {
    const runsDir = await createRunsDir()
    const runDir = join(runsDir, RUN_ID)
    await fs.mkdir(runDir)
    expect(await reader(runsDir).read(RUN_ID)).toEqual({ ok: false, reason: 'not_found' })

    await fs.mkdir(join(runDir, 'report.md'))
    expect(await reader(runsDir).read(RUN_ID)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('does not fall back to a nested report.md', async () => {
    const runsDir = await createRunsDir()
    const runDir = join(runsDir, RUN_ID)
    await fs.mkdir(join(runDir, 'nested'), { recursive: true })
    await fs.writeFile(join(runDir, 'nested', 'report.md'), 'nested')

    expect(await reader(runsDir).read(RUN_ID)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('rejects reports above the byte limit before reading them', async () => {
    const runsDir = await createRunsDir()
    const runDir = join(runsDir, RUN_ID)
    await fs.mkdir(runDir)
    await fs.writeFile(join(runDir, 'report.md'), 'x'.repeat(33))

    expect(await reader(runsDir, 32).read(RUN_ID)).toEqual({ ok: false, reason: 'too_large' })
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked report file', async () => {
    const runsDir = await createRunsDir()
    const runDir = join(runsDir, RUN_ID)
    await fs.mkdir(runDir)
    const outside = join(runsDir, 'outside.md')
    await fs.writeFile(outside, 'secret')
    await fs.symlink(outside, join(runDir, 'report.md'))

    expect(await reader(runsDir).read(RUN_ID)).toEqual({ ok: false, reason: 'not_found' })
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked run directory', async () => {
    const runsDir = await createRunsDir()
    const outside = join(runsDir, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'report.md'), 'secret')
    await fs.symlink(outside, join(runsDir, RUN_ID))

    expect(await reader(runsDir).read(RUN_ID)).toEqual({ ok: false, reason: 'not_found' })
  })
})
