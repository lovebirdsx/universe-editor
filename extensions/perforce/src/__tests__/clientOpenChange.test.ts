/**
 * W3 semantics of `PerforceClient.openChange` (the SCM row "Open Changes" / the
 * diff a user clicks open). The interactive read now surfaces *why* the diff
 * didn't come up: a failed fstat/print toasts (`notifyP4Failure`) and returns
 * WITHOUT falling back to opening the plain file — so the user knows the diff
 * failed instead of mistaking "diff became a plain editor" for normal. Only a
 * genuine "no have revision" (open-for-add / not under depot control) falls back
 * to `_workbench.openFile`. All reads go through the gate's reserved interactive
 * slot + a tight 30s timeout (pinned separately at the p4Service level).
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  kill(): boolean {
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  executeCommand: vi.fn(),
  showMessage: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  chmod: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))

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
const LOCAL = process.platform === 'win32' ? 'C:/ws/tracked.txt' : '/ws/tracked.txt'
const DEPOT = '//depot/tracked.txt'

function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c') {
      i++
      continue
    }
    return a
  }
  return undefined
}

/** Route each spawned fake child by p4 subcommand. */
function respond(handler: (argv: string[]) => { stdout: string; exit?: number }): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout, exit } = handler(argv)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', exit ?? 0)
    })
    return child
  })
}

/** Default responses for discovery + a successful controlled-file diff. */
function defaultHandler(argv: string[]): { stdout: string; exit?: number } {
  const cmd = subcommand(argv)
  if (cmd === 'info') {
    return { stdout: `... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n` }
  }
  if (cmd === 'fstat') {
    return { stdout: `${JSON.stringify({ depotFile: DEPOT, clientFile: LOCAL, haveRev: '3' })}\n` }
  }
  if (cmd === 'print') return { stdout: 'depot content' }
  return { stdout: '' }
}

async function makeClient(
  handler: (argv: string[]) => { stdout: string; exit?: number } = defaultHandler,
) {
  respond(handler)
  const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
    enabled: true,
    workspaceTtlMs: 4000,
  })
  expect(client).toBeDefined()
  return client!
}

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
  mocks.readFile.mockResolvedValue('local content')
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('PerforceClient.openChange', () => {
  it('toasts and returns without fallback when fstat fails', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') return defaultHandler(argv)
      if (cmd === 'fstat') return { stdout: '', exit: 1 }
      return { stdout: '' }
    })

    await client.openChange(LOCAL)

    // The failure was surfaced as a toast, and no plain-file fallback ran.
    expect(mocks.showMessage).toHaveBeenCalledWith('error', expect.stringContaining('failed'), [])
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('_workbench.openFile', expect.anything())
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('_workbench.openDiff', expect.anything())
  })

  it('falls back to opening the file when there is no have revision', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') return defaultHandler(argv)
      if (cmd === 'fstat') {
        // Controlled but no haveRev (open-for-add): the normal fallback, not a fault.
        return { stdout: `${JSON.stringify({ depotFile: DEPOT })}\n` }
      }
      return { stdout: '' }
    })

    await client.openChange(LOCAL)

    expect(mocks.showMessage).not.toHaveBeenCalled()
    expect(mocks.executeCommand).toHaveBeenCalledWith('_workbench.openFile', [LOCAL])
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('_workbench.openDiff', expect.anything())
  })

  it('opens the diff with depot (have) vs local content on success', async () => {
    const client = await makeClient()

    await client.openChange(LOCAL)

    expect(mocks.showMessage).not.toHaveBeenCalled()
    const openDiff = mocks.executeCommand.mock.calls.find((c) => c[0] === '_workbench.openDiff')
    expect(openDiff).toBeDefined()
    const payload = openDiff![1][0] as { original: string; modified: string }
    expect(payload.original).toBe('depot content')
    expect(payload.modified).toBe('local content')
  })
})
