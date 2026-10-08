/**
 * The gate a collect / clean passes at the CLIENT — asked inside the branch that
 * is about to run, on the range that branch is about to run:
 *
 *  - the RANGE is derived from the raw typed targets the caller named, at
 *    execution time, under the scope in force at that instant. A caller that
 *    gated its operation minutes ago (a confirmation dialog) cannot make this
 *    run obey a reading of the config that no longer exists;
 *  - an unusable scope (blocked / empty) is a range nobody can name, so nothing
 *    runs — a `p4 clean -a` over a range built from rules that no longer hold
 *    deletes where the user shielded;
 *  - a target the scope does not cover at all leaves nothing to run, and the
 *    whole selection sitting under the exclusions is an ANSWER, never an empty
 *    call (`p4 reconcile` with no path would walk the client).
 *
 * What is deliberately NOT here any more: accepting a pre-built carve product,
 * or comparing a write's rules with the rules a carve was prepared under. There
 * is no caller-supplied filespec list to freeze and nothing to verify against —
 * the report a user answered and the run that follows are one reading.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncScopeTarget } from '../p4Filespec.js'
import type { ScopeRead } from './scopeFixture.js'
import { scopeFixture } from './scopeFixture.js'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { EMPTY_RECONCILE_NOISE } from '../reconcileNoise.js'
import { clientSpecReply, isClientSpecProbe } from './discoveryProbe.js'
type PerforceClientInstance = import('../client.js').PerforceClient

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  pid: number | undefined = 4242
  kill(): boolean {
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn(), showMessage: vi.fn() }))

const windowMock = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
}))
vi.mock('@universe-editor/extension-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@universe-editor/extension-api')>()
  return { ...actual, window: windowMock }
})

const BRIDGE_KEY = '__universeExtensionHostBridge__'
function installBridge(): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = {
    createSourceControl: () => ({
      id: 'perforce',
      label: '',
      rootUri: undefined,
      inputBox: { value: '', placeholder: '', onDidChange: () => ({ dispose() {} }) },
      count: undefined,
      commitTemplate: undefined,
      acceptInputCommand: undefined,
      acceptInputActions: undefined,
      createResourceGroup: () => ({
        id: '',
        label: '',
        hideWhenEmpty: undefined,
        resourceStates: [],
        dispose() {},
      }),
      dispose() {},
    }),
    executeCommand: mocks.executeCommand,
    showMessage: mocks.showMessage,
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'
const CLIENT = 'testclient'
const LOCAL = `${ROOT_FWD}/src`
const SUB = `${LOCAL}/sub`

/** A config that cannot be read at all — every operation over an unknown range
 *  has to fail closed. */
function unreadableScope(): ScopeRead {
  return () => ({ kind: 'error', path: `${ROOT_FWD}/.p4delta-scope`, reason: 'unreadable' })
}

function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c' || a === '-x') {
      i++
      continue
    }
    return a
  }
  return undefined
}

/** Every p4 argv the client spawned, in order. */
const spawned: string[][] = []

/** The client root `p4 info` reports back. A test whose range must cover a REAL
 *  tree roots its client there, and discovery only accepts a folder inside the
 *  reported client root — so the mock has to agree with the test. */
let spawnClientRoot = ROOT

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  spawned.length = 0
  spawnClientRoot = ROOT
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    spawned.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      if (isClientSpecProbe(argv)) {
        // Discovery reads the client spec's FIXED Root and fails closed on an
        // unreadable one; the spec must agree with the root `info` reports.
        child.stdout.emit('data', Buffer.from(clientSpecReply(spawnClientRoot)))
      } else if (subcommand(argv) === 'info') {
        child.stdout.emit(
          'data',
          Buffer.from(
            `... clientName ${CLIENT}\n... clientRoot ${spawnClientRoot}\n... userName testuser\n\n`,
          ),
        )
      }
      child.emit('close', 0)
    })
    return child
  })
  mocks.executeCommand.mockResolvedValue(undefined)
  windowMock.showWarningMessage.mockClear()
  windowMock.showInformationMessage.mockClear()
  windowMock.showErrorMessage.mockClear()
})

afterEach(() => {
  for (const client of createdClients) client.dispose()
  createdClients.length = 0
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

const createdClients: PerforceClientInstance[] = []

async function makeClient(
  readScope: ScopeRead = scopeFixture([LOCAL]),
  root: string = ROOT,
): Promise<PerforceClientInstance> {
  spawnClientRoot = root
  const client = await PerforceClient.create(
    root,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000 },
    { readScope },
  )
  const created = client!
  createdClients.push(created)
  await created.refreshScope()
  return created
}

/** The `p4 reconcile` APPLY spawns (never a `-n` dry run), with the global
 *  connection options stripped so an assertion reads as the command. */
function collectSpawns(): string[][] {
  return spawned
    .filter((a) => subcommand(a) === 'reconcile' && !a.includes('-n'))
    .map((a) => a.slice(a.indexOf('reconcile')))
}

/** The `p4 clean` spawns. */
function cleanSpawns(): string[][] {
  return spawned.filter((a) => subcommand(a) === 'clean').map((a) => a.slice(a.indexOf('clean')))
}

const dir = (path: string): SyncScopeTarget => ({ path, isDirectory: true })
const file = (path: string): SyncScopeTarget => ({ path, isDirectory: false })

/** The carve walk appends children with `/` and keeps the caller's spelling, so
 *  the fixtures must do the same rather than inheriting `node:path.join`. */
function posixJoin(...parts: string[]): string {
  return parts.join('/')
}

/** A scope the test swaps from under the client: `apply` resolves the new answer
 *  the way a config-file watcher does. */
function scopeSwapper(initial: ScopeRead): {
  readonly get: () => ScopeRead
  apply(client: PerforceClientInstance, next: ScopeRead): Promise<void>
} {
  let current = initial
  return {
    get: () => current,
    async apply(client, next) {
      current = next
      await client.refreshScope()
    },
  }
}

describe('PerforceClient — a write derives its range at execution time', () => {
  it('runs over the scope in force NOW, not the one the caller gated under', async () => {
    const scope = scopeSwapper(scopeFixture([LOCAL]))
    const client = await makeClient((root) => scope.get()(root))
    const targets = [dir(LOCAL)]

    // The caller's gate — the confirmation dialog — ran under this config. Then
    // the config narrows while that dialog is still up.
    await scope.apply(client, scopeFixture([SUB]))

    expect(await client.reconcile({ targets })).toBe(true)

    // The range is the intersection computed here, at the write: the narrower
    // include, and no sign of the wider one the caller saw.
    expect(collectSpawns()).toEqual([['reconcile', '-a', '-e', '-d', `${SUB}/...`]])
  })

  it('carves around the exclusions in force NOW, not the caller’s reading', async () => {
    const realDir = mkTempDir('p4-dirExcl-')
    // The target is a SUBTREE, not the client root: the config file sits at the
    // root, and the carve covers its level with `<dir>/*` — a hole native p4 is
    // refused over (that is its own test). Here the subject is the carve.
    const src = posixJoin(realDir, 'src')
    const gen = posixJoin(src, 'gen')
    mkdirSync(gen, { recursive: true })
    writeFileSync(posixJoin(src, 'a.txt'), 'a')
    try {
      const scope = scopeSwapper(scopeFixture([src]))
      const client = await makeClient((root) => scope.get()(root), realDir)
      const targets = [dir(src)]

      // The exclusion lands after the caller gated: the carve must be built from
      // the rules read here, at the write, or the excluded subtree would be
      // walked (`p4 clean -a` deletes through a `<dir>/...`).
      await scope.apply(client, scopeFixture([src], [gen]))

      expect(await client.reconcile({ targets })).toBe(true)

      const argv = collectSpawns().at(-1)!
      expect(argv.slice(0, 4)).toEqual(['reconcile', '-a', '-e', '-d'])
      expect(argv).toHaveLength(5)
      // The scope's own spelling of the include is what the intersection hands
      // back, so compare normalized rather than byte-for-byte.
      expect(argv[4]!.replaceAll('\\', '/')).toBe(`${src.replaceAll('\\', '/')}/*`)
      expect(argv.some((spec) => spec.includes('/gen'))).toBe(false)
    } finally {
      removeDirWithRetry(realDir)
    }
  })

  it('refuses a write whose scope went unusable before the run', async () => {
    const client = await makeClient(unreadableScope())

    const ok = await client.reconcile({ targets: [file(`${LOCAL}/a.txt`)] })

    expect(ok).toBe(false)
    expect(collectSpawns()).toEqual([])
    expect(String(windowMock.showWarningMessage.mock.calls.at(-1)?.[0] ?? '')).toContain(
      'daily scope is not usable',
    )
  })

  it('refuses a target the scope does not reach at all', async () => {
    const client = await makeClient(scopeFixture([SUB]))

    const ok = await client.reconcile({ targets: [dir(`${LOCAL}/other`)] })

    expect(ok).toBe(false)
    expect(collectSpawns()).toEqual([])
  })

  it('reports an all-excluded selection instead of running an empty call', async () => {
    // The scope admits SUB; the RULES in force hide it. The answer is a message,
    // never an empty call (a path-less `p4 clean` would walk the client).
    const client = await makeClient()
    client.setReconcileExcludes({ dirs: [SUB], files: [] })

    const ok = await client.revertReconcile({ targets: [dir(SUB)] })

    expect(ok).toBe(false)
    expect(cleanSpawns()).toEqual([])
    expect(windowMock.showInformationMessage).toHaveBeenCalledTimes(1)
  })

  /**
   * The destructive half of "the range is derived at the write": a rule that
   * appears while the confirmation dialog is up must shield its subtree from the
   * clean. The shape this used to have — the command layer handing over the rule
   * set it read before the dialog, which won over the live one — is exactly how
   * `p4 clean -a` ended up deleting inside a folder the user had just excluded.
   */
  it('carves around a rule that appeared while the confirmation was up', async () => {
    const realDir = mkTempDir('p4-noiseNow-')
    const src = posixJoin(realDir, 'src')
    const bin = posixJoin(src, 'bin')
    const keep = posixJoin(src, 'keep')
    mkdirSync(bin, { recursive: true })
    mkdirSync(keep, { recursive: true })
    writeFileSync(posixJoin(bin, 'b.txt'), 'b')
    writeFileSync(posixJoin(keep, 'a.txt'), 'a')
    try {
      const client = await makeClient(scopeFixture([src]), realDir)
      expect(client.reconcileNoise).toEqual(EMPTY_RECONCILE_NOISE)
      // The dialog's reading was empty; `bin` is excluded while it is still up.
      client.setReconcileExcludes({ dirs: [bin], files: [] })

      expect(await client.revertReconcile({ targets: [dir(src)] })).toBe(true)

      const argv = cleanSpawns().at(-1)!
      expect(argv.slice(0, 4)).toEqual(['clean', '-a', '-e', '-d'])
      const specs = argv.slice(4).map((spec) => spec.replaceAll('\\', '/'))
      expect(specs).toContain(`${src.replaceAll('\\', '/')}/*`)
      expect(specs).toContain(`${keep.replaceAll('\\', '/')}/...`)
      // The newly excluded subtree is an ABSENT level, never a recursive spec
      // that would delete inside it.
      expect(specs.some((spec) => spec.includes('/bin'))).toBe(false)
    } finally {
      removeDirWithRetry(realDir)
    }
  })

  it('runs an override over the named targets even though the scope excludes them', async () => {
    const client = await makeClient(scopeFixture([LOCAL], [SUB]))

    expect(await client.reconcile({ targets: [dir(SUB)] }, { overrideScope: true })).toBe(true)
    expect(collectSpawns()).toEqual([['reconcile', '-a', '-e', '-d', `${SUB}/...`]])
  })

  it('leaves a caller-named DEPOT range alone — the scope never had a vote over it', async () => {
    const client = await makeClient()

    expect(await client.reconcile({ specs: ['//depot/branch_x/...'] })).toBe(true)
    expect(collectSpawns()).toEqual([['reconcile', '-a', '-e', '-d', '//depot/branch_x/...']])
  })

  it('refuses a spec list no one can read back as local targets', async () => {
    // "No targets to check" must never be read as "no range to check": a
    // relative spelling the caller named has no scope behind it either.
    const client = await makeClient()

    expect(await client.reconcile({ specs: ['src/...'] })).toBe(false)
    expect(collectSpawns()).toEqual([])
  })

  it('refuses an empty range rather than asking p4 to walk the client', async () => {
    const client = await makeClient()

    expect(await client.reconcile({})).toBe(false)
    expect(await client.reconcile({ targets: [] })).toBe(false)
    expect(collectSpawns()).toEqual([])
  })
})
