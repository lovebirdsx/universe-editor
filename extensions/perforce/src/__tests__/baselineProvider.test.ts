/**
 * {@link BaselineProvider} semantics for the have-revision diff baseline. W2
 * cached `p4 fstat` per `norm(localPath)` (short TTL), and W3 split
 * `getHaveContent` into a `getHaveContentResult` that surfaces *why* a read is
 * empty (fstat failed / no haveRev / print failed / success) and reports
 * per-stage timings. The highest-risk parts guarded here: a failed fstat must
 * never cache (so it retries, not stuck 15s), the negative "not under depot
 * control" result must cache (so the gutter doesn't re-fstat every tab switch),
 * and a failed print must never land in the immutable print cache (which would
 * poison the left side of every later diff forever).
 */
import { describe, expect, it, vi } from 'vitest'
import { BaselineProvider } from '../baselineProvider.js'
import { P4Cache, registerP4CacheNamespaces } from '../p4Cache.js'
import { norm } from '../pathUtil.js'
import type { P4ExecResult, P4Service } from '../p4Service.js'

const LOCAL = '/ws/tracked.txt'
const DEPOT = '//depot/tracked.txt'
/** A controlled file at have rev 3. */
const FSTAT_RECORD = { depotFile: DEPOT, clientFile: LOCAL, haveRev: '3', headRev: '5' }

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000
  return { now: () => t, advance: (ms) => (t += ms) }
}

function ok(records: Record<string, unknown>[]): { result: P4ExecResult; records: unknown[] } {
  return { result: { stdout: '', stderr: '', exitCode: 0 }, records }
}

function print(stdout: string, exitCode = 0): P4ExecResult {
  return { stdout, stderr: exitCode === 0 ? '' : 'print failed', exitCode }
}

function makeProvider() {
  const clock = fakeClock()
  const cache = new P4Cache(clock.now)
  registerP4CacheNamespaces(cache, 4000) // fstat ttl = max(4000, 15_000) = 15_000
  const execRecords = vi.fn()
  const exec = vi.fn()
  const execBinary = vi.fn()
  const provider = new BaselineProvider(
    { execRecords, exec, execBinary } as unknown as P4Service,
    cache,
  )
  return { provider, cache, clock, execRecords, exec, execBinary }
}

describe('BaselineProvider fstat caching', () => {
  it('two getHaveContent reads of the same path issue one fstat (and one print)', async () => {
    const { provider, execRecords, exec } = makeProvider()
    execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    exec.mockResolvedValue(print('line1\nline2'))

    await provider.getHaveContent(LOCAL)
    await provider.getHaveContent(LOCAL)

    expect(execRecords).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('re-fetches fstat after the 15s TTL window', async () => {
    const { provider, execRecords, exec, clock } = makeProvider()
    execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    exec.mockResolvedValue(print('content'))

    await provider.getHaveContent(LOCAL)
    clock.advance(15_001)
    await provider.getHaveContent(LOCAL)

    expect(execRecords).toHaveBeenCalledTimes(2)
    // print is immutable → not re-fetched even though fstat was.
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('invalidateWorkspace drops the fstat entry', async () => {
    const { provider, execRecords, exec, cache } = makeProvider()
    execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    exec.mockResolvedValue(print('content'))

    await provider.getFstatInfo(LOCAL)
    cache.invalidateWorkspace()
    await provider.getFstatInfo(LOCAL)

    expect(execRecords).toHaveBeenCalledTimes(2)
  })

  it('invalidateFile drops the fstat entry for that path', async () => {
    const { provider, execRecords, exec, cache } = makeProvider()
    execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    exec.mockResolvedValue(print('content'))

    await provider.getFstatInfo(LOCAL)
    cache.invalidateFile(norm(LOCAL))
    await provider.getFstatInfo(LOCAL)

    expect(execRecords).toHaveBeenCalledTimes(2)
  })

  it('does not cache a transient fstat failure (exitCode != 0)', async () => {
    const { provider, execRecords } = makeProvider()
    execRecords.mockResolvedValue({
      result: { stdout: '', stderr: 'no such file', exitCode: 1 },
      records: [],
    })

    await expect(provider.getFstatInfo(LOCAL)).resolves.toBeUndefined()
    await expect(provider.getFstatInfo(LOCAL)).resolves.toBeUndefined()

    expect(execRecords).toHaveBeenCalledTimes(2)
  })

  it('caches the negative (not under depot control) result as the sentinel', async () => {
    const { provider, execRecords } = makeProvider()
    execRecords.mockResolvedValue(ok([])) // parseFstat finds no depotFile → NOT_CONTROLLED

    await expect(provider.getFstatInfo(LOCAL)).resolves.toBeUndefined()
    await expect(provider.getFstatInfo(LOCAL)).resolves.toBeUndefined()

    expect(execRecords).toHaveBeenCalledTimes(1)
  })
})

describe('BaselineProvider getHaveContentResult', () => {
  it('distinguishes fstat failure / no haveRev / print failure / success', async () => {
    const fail = makeProvider()
    fail.execRecords.mockResolvedValue({
      result: { stdout: '', stderr: 'fstat fail', exitCode: 1 },
      records: [],
    })
    const fstatError = await fail.provider.getHaveContentResult(LOCAL)
    expect(fstatError.error).toBeDefined()
    expect(fstatError.content).toBeUndefined()

    const noHave = makeProvider()
    noHave.execRecords.mockResolvedValue(ok([{ depotFile: DEPOT }])) // no haveRev
    const noHaveRev = await noHave.provider.getHaveContentResult(LOCAL)
    expect(noHaveRev.error).toBeUndefined()
    expect(noHaveRev.content).toBeUndefined()

    const printFail = makeProvider()
    printFail.execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    printFail.exec.mockResolvedValue(print('', 1))
    const printError = await printFail.provider.getHaveContentResult(LOCAL)
    expect(printError.error).toBeDefined()
    expect(printError.content).toBeUndefined()

    const okCase = makeProvider()
    okCase.execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    okCase.exec.mockResolvedValue(print('content'))
    const success = await okCase.provider.getHaveContentResult(LOCAL)
    expect(success.error).toBeUndefined()
    expect(success.content).toBe('content')
  })

  it("treats haveRev 'none' (open-for-add) as no baseline and never prints #none", async () => {
    // `'none'` is a real value p4 reports (PROBE-FINDINGS §3) and it is truthy —
    // a bare falsy check would send `p4 print -q //depot/a.txt#none`, which fails
    // and turns a normal open-for-add into a toast-worthy error.
    const text = makeProvider()
    text.execRecords.mockResolvedValue(
      ok([{ depotFile: DEPOT, clientFile: LOCAL, haveRev: 'none' }]),
    )
    text.exec.mockResolvedValue(print('should never be fetched'))
    const res = await text.provider.getHaveContentResult(LOCAL)
    expect(res.content).toBeUndefined()
    expect(res.error).toBeUndefined()
    expect(text.exec).not.toHaveBeenCalled()

    const bytes = makeProvider()
    bytes.execRecords.mockResolvedValue(
      ok([{ depotFile: DEPOT, clientFile: LOCAL, haveRev: 'none' }]),
    )
    const bytesRes = await bytes.provider.getHaveContentBytesResult(LOCAL)
    expect(bytesRes.content).toBeUndefined()
    expect(bytesRes.error).toBeUndefined()
    expect(bytes.execBinary).not.toHaveBeenCalled()
  })

  it('does not cache a failed print (the immutable print cache is never poisoned)', async () => {
    const { provider, execRecords, exec } = makeProvider()
    execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    exec.mockResolvedValueOnce(print('', 1))
    exec.mockResolvedValueOnce(print('content'))

    const first = await provider.getHaveContentResult(LOCAL)
    expect(first.error).toBeDefined()

    const second = await provider.getHaveContentResult(LOCAL)
    expect(second.error).toBeUndefined()
    expect(second.content).toBe('content')

    // fstat stayed cached; the print retried on the second call.
    expect(execRecords).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('reports printCached=false on a miss and true on a hit', async () => {
    const { provider, execRecords, exec } = makeProvider()
    execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    exec.mockResolvedValue(print('content'))

    const first = await provider.getHaveContentResult(LOCAL)
    expect(first.timings.printCached).toBe(false)

    const second = await provider.getHaveContentResult(LOCAL)
    expect(second.timings.printCached).toBe(true)
  })

  it('both concurrent readers see a print failure (no "no have rev" misread)', async () => {
    const { provider, execRecords, exec } = makeProvider()
    execRecords.mockResolvedValue(ok([FSTAT_RECORD]))
    // A slow, eventually-failing print: both callers share one in-flight fetch,
    // so the failure must reach BOTH — the second must not read "no content" as
    // "no have revision" (which would silently fall back to opening the file).
    exec.mockImplementation(
      () => new Promise<P4ExecResult>((resolve) => setTimeout(() => resolve(print('', 1)), 10)),
    )

    const [first, second] = await Promise.all([
      provider.getHaveContentResult(LOCAL),
      provider.getHaveContentResult(LOCAL),
    ])

    expect(exec).toHaveBeenCalledTimes(1) // one shared p4 print (in-flight dedup)
    expect(first.error).toBeDefined()
    expect(second.error).toBeDefined()
    expect(first.content).toBeUndefined()
    expect(second.content).toBeUndefined()
  })
})
