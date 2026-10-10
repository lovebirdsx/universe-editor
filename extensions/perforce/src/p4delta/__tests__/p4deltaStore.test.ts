import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeManagedP4delta,
  openP4deltaStore,
  P4DELTA_EXE_NAME,
  type P4deltaStore,
  type P4deltaStoreOptions,
} from '../p4deltaStore.js'
import type { P4deltaSource } from '../p4deltaUpstream.js'

/** Injected rename failures, for the "another window won the race" path. */
const { fsHooks } = vi.hoisted(() => ({
  fsHooks: {
    renameFail: undefined as ((from: string, to: string) => Error | undefined) | undefined,
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const failure = fsHooks.renameFail?.(String(from), String(to))
      if (failure !== undefined) throw failure
      return actual.renameSync(from, to)
    },
  }
})

const MIRROR: P4deltaSource = { mode: 'mirror', baseUrl: 'https://updates.example.com/p4delta' }
const VERSION = '0.1.10'
const TRIPLE = 'x86_64-pc-windows-msvc'
const ASSET = `p4delta-${VERSION}-${TRIPLE}.zip`
const EXE_BYTES = Buffer.from('MZ this stands in for the real p4delta.exe')

let root: string
let clock: number
/** URLs the stub fetch was asked for, in order. */
let calls: string[]

beforeEach(() => {
  root = mkTempDir('ue-p4delta-')
  clock = 1_700_000_000_000
  calls = []
  fsHooks.renameFail = undefined
})

afterEach(() => {
  removeDirWithRetry(root)
})

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function zipWith(entries: Record<string, Buffer>): Buffer {
  const zip = new AdmZip()
  for (const [name, data] of Object.entries(entries)) zip.addFile(name, data)
  return zip.toBuffer()
}

const releaseZip = (): Buffer => zipWith({ [P4DELTA_EXE_NAME]: EXE_BYTES })

interface Upstream {
  /** Payload of the latest-release document; a number means "respond with that HTTP status". */
  latest?: unknown
  retryAfter?: string
  /** Body of SHA256SUMS; undefined means 404. */
  sums?: string | undefined
  zip?: Buffer
  zipStatus?: number
  /** Hold the latest-release response until this resolves. */
  gate?: Promise<void>
  /** Runs just before the archive is handed over — the "another window got there first" seam. */
  onZip?: () => void
}

function stubFetch(upstream: Upstream): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    calls.push(url)
    if (upstream.gate !== undefined) await upstream.gate
    // Real fetch rejects on an aborted signal; the store reads `signal.aborted`
    // to tell that apart from a network failure, so the stub must honour it.
    if (init?.signal?.aborted === true) throw new Error('This operation was aborted')
    if (url.endsWith('/latest.json')) {
      if (typeof upstream.latest === 'number') {
        const headers =
          upstream.retryAfter !== undefined ? { 'retry-after': upstream.retryAfter } : undefined
        return new Response('nope', { status: upstream.latest, ...(headers ? { headers } : {}) })
      }
      return new Response(JSON.stringify(upstream.latest ?? { version: VERSION }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/SHA256SUMS')) {
      if (upstream.sums === undefined) return new Response('not found', { status: 404 })
      return new Response(upstream.sums, { status: 200 })
    }
    if (url.endsWith('.zip')) {
      const status = upstream.zipStatus ?? 200
      if (status !== 200) return new Response('nope', { status })
      upstream.onZip?.()
      return new Response(new Uint8Array(upstream.zip ?? releaseZip()), { status: 200 })
    }
    return new Response('unexpected request', { status: 500 })
  }) as typeof fetch
}

function makeStore(upstream: Upstream, extra?: Partial<P4deltaStoreOptions>): P4deltaStore {
  return openP4deltaStore({
    root,
    source: MIRROR,
    platform: 'win32',
    arch: 'x64',
    fetchImpl: stubFetch(upstream),
    now: () => clock,
    log: () => {},
    ...extra,
  })
}

const sumsFor = (zip: Buffer): string => `${sha256(zip)}  ${ASSET}\n`

function installedExe(version = VERSION): string {
  return join(root, version, P4DELTA_EXE_NAME)
}

function placeVersion(version: string, contents = EXE_BYTES): void {
  mkdirSync(join(root, version), { recursive: true })
  writeFileSync(join(root, version, P4DELTA_EXE_NAME), contents)
}

const readActive = (): string => readFileSync(join(root, '.active'), 'utf8')

describe('p4delta store: skips', () => {
  it('does nothing without a managed root', async () => {
    const store = makeStore({}, { root: '' })
    const outcome = await store.sync()
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no managed root' })
    expect(calls).toEqual([])
  })

  it('does nothing on a platform upstream publishes no build for', async () => {
    const store = makeStore({}, { platform: 'linux', arch: 'x64' })
    expect(await store.sync()).toEqual({
      kind: 'skipped',
      reason: 'no p4delta build for linux-x64',
    })
    expect(calls).toEqual([])
  })

  it('does nothing for an unsupported architecture of a supported platform', async () => {
    const store = makeStore({}, { arch: 'arm64' })
    expect((await store.sync()).kind).toBe('skipped')
    expect(calls).toEqual([])
  })
})

describe('p4delta store: install', () => {
  it('downloads, verifies, extracts and activates', async () => {
    const zip = releaseZip()
    const store = makeStore({ sums: sumsFor(zip), zip })
    const outcome = await store.sync()
    expect(outcome).toEqual({ kind: 'installed', version: VERSION })
    expect(readActive()).toBe(VERSION)
    expect(readFileSync(installedExe())).toEqual(EXE_BYTES)
    expect(activeManagedP4delta(root)).toBe(installedExe())
  })

  it('asks for the checksum list before the archive', async () => {
    const zip = releaseZip()
    await makeStore({ sums: sumsFor(zip), zip }).sync()
    expect(calls.map((url) => url.split('/').at(-1))).toEqual(['latest.json', 'SHA256SUMS', ASSET])
  })

  it('refuses an archive whose digest does not match', async () => {
    const zip = releaseZip()
    const store = makeStore({ sums: sumsFor(Buffer.from('some other release')), zip })
    const outcome = await store.sync()
    expect(outcome.kind).toBe('failed')
    expect(existsSync(join(root, VERSION))).toBe(false)
    expect(existsSync(join(root, '.active'))).toBe(false)
  })

  it('refuses a release with no checksum list at all', async () => {
    const store = makeStore({})
    const outcome = await store.sync()
    expect(outcome.kind).toBe('failed')
    expect(calls.some((url) => url.endsWith('.zip'))).toBe(false)
  })

  it('refuses a checksum list that does not name the asset', async () => {
    const zip = releaseZip()
    const store = makeStore({ sums: `${sha256(zip)}  some-other-file.zip\n`, zip })
    const outcome = await store.sync()
    expect(outcome.kind).toBe('failed')
    expect(calls.some((url) => url.endsWith('.zip'))).toBe(false)
  })

  it('refuses an archive without the executable, leaving no staging behind', async () => {
    const zip = zipWith({ 'README.md': Buffer.from('not the binary') })
    const store = makeStore({ sums: sumsFor(zip), zip })
    const outcome = await store.sync()
    expect(outcome.kind).toBe('failed')
    expect(existsSync(join(root, VERSION))).toBe(false)
    const leftovers = readdirNames().filter(
      (name) => name.includes('.extract.') || name.includes('.zip.'),
    )
    expect(leftovers).toEqual([])
  })

  it('reports the failure reason rather than throwing', async () => {
    const store = makeStore({ latest: 500 })
    const outcome = await store.sync()
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect((outcome as { reason: string }).reason).toContain('500')
  })

  it('upgrades an older managed copy and records where it came from', async () => {
    mkdirSync(root, { recursive: true })
    placeVersion('0.1.9')
    writeFileSync(join(root, '.active'), '0.1.9')
    const zip = releaseZip()
    const outcome = await makeStore({ sums: sumsFor(zip), zip }).sync()
    expect(outcome).toEqual({ kind: 'installed', version: VERSION, previousVersion: '0.1.9' })
    expect(readActive()).toBe(VERSION)
  })

  it('never downgrades when the pointer is ahead of the upstream release', async () => {
    mkdirSync(root, { recursive: true })
    placeVersion('0.1.11')
    writeFileSync(join(root, '.active'), '0.1.11')
    const outcome = await makeStore({ latest: { version: VERSION } }).sync()
    expect(outcome).toEqual({ kind: 'up-to-date', version: '0.1.11' })
  })

  // Another window can finish the same version while our archive is streaming.
  // Its directory — and any pointer already written to it — must survive our
  // placement: overwriting an identical copy is harmless, deleting the target of
  // a live `.active` is not.
  it('keeps the copy another window placed during the download', async () => {
    const other = Buffer.from('MZ placed by the other window while we downloaded')
    const zip = releaseZip()
    const store = makeStore({
      sums: sumsFor(zip),
      zip,
      onZip: () => placeVersion(VERSION, other),
    })
    const outcome = await store.sync()
    expect(outcome).toEqual({ kind: 'installed', version: VERSION })
    expect(readFileSync(installedExe())).toEqual(other)
    expect(readActive()).toBe(VERSION)
    expect(readdirNames().filter((name) => name.includes('.extract.'))).toEqual([])
    expect(readdirNames().filter((name) => name.includes('.zip.'))).toEqual([])
  })

  it('refuses an archive larger than the download cap', async () => {
    const zip = releaseZip()
    const store = makeStore({ sums: sumsFor(zip), zip }, { maxDownloadBytes: 16 })
    const outcome = await store.sync()
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect((outcome as { reason: string }).reason).toContain('16 bytes')
    expect(existsSync(join(root, VERSION))).toBe(false)
    expect(existsSync(join(root, '.active'))).toBe(false)
  })
})

describe('p4delta store: adopting what is already on disk', () => {
  it('activates a version another window already downloaded, without re-downloading it', async () => {
    mkdirSync(root, { recursive: true })
    placeVersion(VERSION)
    const outcome = await makeStore({}).sync()
    expect(outcome).toEqual({ kind: 'installed', version: VERSION })
    expect(readActive()).toBe(VERSION)
    // Only the latest-release document was fetched; the archive came off disk.
    expect(calls.map((url) => url.split('/').at(-1))).toEqual(['latest.json'])
  })
})

describe('p4delta store: throttling', () => {
  it('does not re-query within the success window', async () => {
    const zip = releaseZip()
    await makeStore({ sums: sumsFor(zip), zip }).sync()
    calls = []
    clock += 60 * 60 * 1000
    const outcome = await makeStore({}).sync()
    expect(outcome.kind).toBe('throttled')
    expect(calls).toEqual([])
  })

  it('queries again once the success window has passed', async () => {
    const zip = releaseZip()
    await makeStore({ sums: sumsFor(zip), zip }).sync()
    calls = []
    clock += 25 * 60 * 60 * 1000
    const outcome = await makeStore({}).sync()
    expect(outcome).toEqual({ kind: 'up-to-date', version: VERSION })
    expect(calls.length).toBeGreaterThan(0)
  })

  it('backs off after a failure', async () => {
    await makeStore({ latest: 500 }).sync()
    calls = []
    clock += 30 * 60 * 1000
    expect((await makeStore({}).sync()).kind).toBe('throttled')
    expect(calls).toEqual([])
  })

  it('honours Retry-After over the default backoff', async () => {
    await makeStore({ latest: 429, retryAfter: '7200' }).sync()
    const record = JSON.parse(readFileSync(join(root, '.check'), 'utf8')) as { nextCheckAt: number }
    expect(record.nextCheckAt).toBe(clock + 7200 * 1000)
  })

  it('ignores the throttle when forced', async () => {
    const zip = releaseZip()
    await makeStore({ sums: sumsFor(zip), zip }).sync()
    calls = []
    const outcome = await makeStore({}).sync(true)
    expect(outcome).toEqual({ kind: 'up-to-date', version: VERSION })
    expect(calls.length).toBeGreaterThan(0)
  })

  it('treats a corrupt throttle record as never checked', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.check'), '{ this is not json')
    const zip = releaseZip()
    const outcome = await makeStore({ sums: sumsFor(zip), zip }).sync()
    expect(outcome.kind).toBe('installed')
  })
})

describe('p4delta store: concurrency', () => {
  it('shares one run between concurrent callers', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const zip = releaseZip()
    const store = makeStore({ sums: sumsFor(zip), zip, gate })
    const first = store.sync()
    const second = store.sync()
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ kind: 'installed', version: VERSION })
    expect(b).toEqual(a)
    expect(calls).toHaveLength(3)
  })

  it('lets a second store on the same root reach the same state', async () => {
    const zip = releaseZip()
    const a = makeStore({ sums: sumsFor(zip), zip })
    const b = makeStore({ sums: sumsFor(zip), zip })
    const first = a.sync()
    // b is the second window, and a forced one (the install command): it must not
    // be answered by a's run — it waits for it and then decides for itself, which
    // is what finds the version a left behind.
    const second = b.sync(true)
    expect(await first).toEqual({ kind: 'installed', version: VERSION })
    expect(await second).toEqual({ kind: 'up-to-date', version: VERSION })
    expect(activeManagedP4delta(root)).toBe(installedExe())
    expect(readdirNames().filter((name) => name.includes('.extract.'))).toEqual([])
  })

  // The install command's own decision, progress and cancel cannot be borrowed
  // from whoever happened to be running: joining a run the user did not start is
  // how a forced install ends up reporting the throttle or the failure of a run
  // that was never trying to satisfy it.
  it('does not answer a forced call with the run in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const zip = releaseZip()
    const store = makeStore({ sums: sumsFor(zip), zip, gate })
    const background = store.sync()
    const manual = store.sync(true)
    release()
    expect(await background).toEqual({ kind: 'installed', version: VERSION })
    // Not `installed`: the forced run checked for itself and found the version
    // the background run had just placed.
    expect(await manual).toEqual({ kind: 'up-to-date', version: VERSION })
    expect(calls).toHaveLength(4)
  })

  it('ends a forced call as cancelled when its own signal fires while waiting', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const zip = releaseZip()
    const store = makeStore({ sums: sumsFor(zip), zip, gate })
    const background = store.sync()
    const controller = new AbortController()
    const manual = store.sync(true, { signal: controller.signal })
    controller.abort()
    release()
    expect(await background).toEqual({ kind: 'installed', version: VERSION })
    expect(await manual).toEqual({ kind: 'cancelled' })
  })
})

describe('p4delta store: cancellation', () => {
  // A cancel is the user's decision, not a verdict on the upstream — so it must
  // not teach the throttle that something failed. The next run has to be free to
  // go out immediately; otherwise cancelling one manual install would silence
  // the automatic one for an hour.
  it('reports a cancel during the version query, and stamps no backoff', async () => {
    const controller = new AbortController()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const zip = releaseZip()
    const store = makeStore({ sums: sumsFor(zip), zip, gate })
    const run = store.sync(false, { signal: controller.signal })
    controller.abort()
    release()
    expect(await run).toEqual({ kind: 'cancelled' })
    expect(existsSync(join(root, '.check'))).toBe(false)

    expect((await store.sync()).kind).toBe('installed')
    expect(calls).toHaveLength(4)
  })

  it('reports a cancel during the download, leaving no staging behind', async () => {
    const zip = releaseZip()
    const controller = new AbortController()
    const upstream = stubFetch({ sums: sumsFor(zip), zip })
    const store = makeStore(
      {},
      {
        fetchImpl: (async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          if (String(input).endsWith('.zip')) {
            controller.abort()
            throw new Error('This operation was aborted')
          }
          return await upstream(input, init)
        }) as typeof fetch,
      },
    )
    expect(await store.sync(false, { signal: controller.signal })).toEqual({ kind: 'cancelled' })
    expect(existsSync(join(root, '.check'))).toBe(false)
    expect(readdirNames().filter((name) => name.includes('.zip.'))).toEqual([])
  })
})

describe('p4delta store: placing the version', () => {
  it('counts a rename failure as success when the destination already holds the executable', async () => {
    fsHooks.renameFail = (from, to) => {
      if (!from.includes('.extract.')) return undefined
      // Stand in for another window finishing the same version first.
      mkdirSync(to, { recursive: true })
      writeFileSync(join(to, P4DELTA_EXE_NAME), EXE_BYTES)
      return new Error('EPERM: destination is busy')
    }
    const zip = releaseZip()
    const outcome = await makeStore({ sums: sumsFor(zip), zip }).sync()
    expect(outcome).toEqual({ kind: 'installed', version: VERSION })
    expect(readActive()).toBe(VERSION)
  })

  it('fails after exhausting retries when the destination never materializes', async () => {
    fsHooks.renameFail = (from) =>
      from.includes('.extract.') ? new Error('EPERM: locked') : undefined
    const zip = releaseZip()
    const outcome = await makeStore({ sums: sumsFor(zip), zip }).sync()
    expect(outcome.kind).toBe('failed')
    expect(existsSync(join(root, '.active'))).toBe(false)
  }, 20_000)
})

describe('p4delta store: cleanup', () => {
  it('keeps the active version and sweeps the rest', async () => {
    mkdirSync(root, { recursive: true })
    placeVersion('0.1.8')
    placeVersion('0.1.9')
    const zip = releaseZip()
    await makeStore({ sums: sumsFor(zip), zip }).sync()
    expect(existsSync(join(root, '0.1.8'))).toBe(false)
    expect(existsSync(join(root, '0.1.9'))).toBe(false)
    expect(existsSync(join(root, VERSION, P4DELTA_EXE_NAME))).toBe(true)
  })

  it('leaves directories that are not versions alone', async () => {
    mkdirSync(join(root, 'scratch'), { recursive: true })
    const zip = releaseZip()
    await makeStore({ sums: sumsFor(zip), zip }).sync()
    expect(existsSync(join(root, 'scratch'))).toBe(true)
  })

  it('sweeps stale staging but not one that is still young', async () => {
    mkdirSync(join(root, '0.1.8.extract.999.1'), { recursive: true })
    mkdirSync(join(root, '0.1.8.zip.999.2'), { recursive: true })
    const stale = Math.floor((clock - 2 * 60 * 60 * 1000) / 1000)
    utimesSync(join(root, '0.1.8.extract.999.1'), stale, stale)
    const zip = releaseZip()
    await makeStore({ sums: sumsFor(zip), zip }).sync()
    // The old one is a leftover from a process that died; the young one may be a
    // live window mid-download, and deleting it under that window is the one
    // thing a sweeper must never do.
    expect(readdirNames()).toContain('0.1.8.zip.999.2')
    expect(readdirNames()).not.toContain('0.1.8.extract.999.1')
  })
})

describe('activeManagedP4delta', () => {
  it('reports nothing without a root', () => {
    expect(activeManagedP4delta('')).toBeUndefined()
  })

  it('reports nothing when the pointer is missing, malformed or dangling', () => {
    mkdirSync(root, { recursive: true })
    expect(activeManagedP4delta(root)).toBeUndefined()

    writeFileSync(join(root, '.active'), 'not-a-version')
    expect(activeManagedP4delta(root)).toBeUndefined()

    writeFileSync(join(root, '.active'), '0.1.10')
    expect(activeManagedP4delta(root)).toBeUndefined()

    mkdirSync(join(root, '0.1.10'), { recursive: true })
    expect(activeManagedP4delta(root)).toBeUndefined()

    writeFileSync(installedExe(), EXE_BYTES)
    expect(activeManagedP4delta(root)).toBe(installedExe())
  })
})

function readdirNames(): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}
