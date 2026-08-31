/**
 * The commit-bar Submit button mirrors git's Commit: it is enabled only when the
 * default changelist has files to submit. `acceptInputCommand.disabled` gates the
 * button and Ctrl+Enter, and `acceptInputActions` (the follow-up actions) is
 * unset when there is nothing to submit.
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

interface CommandStub {
  command: string
  title: string
  disabled?: boolean
  icon?: string
}

interface ResourceGroupStub {
  id: string
  label: string
  hideWhenEmpty: boolean | undefined
  resourceStates: unknown[]
  dispose: () => void
}

interface SourceControlStub {
  id: string
  label: string
  rootUri: undefined
  inputBox: { value: string; placeholder: string; onDidChange: () => { dispose: () => void } }
  count: number | undefined
  commitTemplate: undefined
  acceptInputCommand: CommandStub | undefined
  acceptInputActions: CommandStub[] | undefined
  createResourceGroup: (id: string) => ResourceGroupStub
  dispose: () => void
}

const BRIDGE_KEY = '__universeExtensionHostBridge__'
/** The SourceControl the client under test creates, captured so the test can
 *  assert `acceptInputCommand` / `acceptInputActions`. */
let sc: SourceControlStub | undefined
function installScmBridge(): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = {
    createSourceControl: () => {
      const created: SourceControlStub = {
        id: 'perforce',
        label: '',
        rootUri: undefined,
        inputBox: { value: '', placeholder: '', onDidChange: () => ({ dispose() {} }) },
        count: undefined,
        commitTemplate: undefined,
        acceptInputCommand: undefined,
        acceptInputActions: undefined,
        createResourceGroup: (id: string) => ({
          id,
          label: '',
          hideWhenEmpty: undefined,
          resourceStates: [],
          dispose() {},
        }),
        dispose() {},
      }
      sc = created
      return created
    },
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const CLIENT = 'testclient'

/** `p4 -Mj opened` record: one edit. `change` swaps between `default` and a
 *  numbered changelist to exercise both gating branches. */
const OPENED_RECORD = {
  depotFile: '//depot/tracked.txt',
  clientFile: '//testclient/tracked.txt',
  action: 'edit',
  rev: '1',
  change: 'default',
}

/** stdout the `opened` subcommand emits; empty → zero opened files. */
let openedStdout = ''

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

function finish(child: FakeChildProcess, argv: string[]): void {
  const cmd = subcommand(argv)
  let stdout = ''
  if (cmd === 'info') {
    stdout = `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName bob\n\n`
  } else if (cmd === 'opened') {
    stdout = openedStdout
  }
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', 0)
  })
}

describe('PerforceClient commit-bar Submit disabled state', () => {
  beforeEach(() => {
    installScmBridge()
    sc = undefined
    openedStdout = ''
    spawnMock.mockReset()
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      const child = new FakeChildProcess()
      finish(child, argv)
      return child
    })
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('disables Submit when the default changelist has no files', async () => {
    const client = await PerforceClient.create(
      ROOT,
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 4000 },
      undefined,
    )
    expect(client).toBeDefined()
    await client!.refresh()

    expect(sc).toBeDefined()
    expect(sc!.acceptInputCommand?.command).toBe('perforce.submitDefault')
    expect(sc!.acceptInputCommand?.disabled).toBe(true)
    expect(sc!.acceptInputActions).toBeUndefined()

    client!.dispose()
  })

  it('enables Submit when the default changelist has files', async () => {
    openedStdout = `${JSON.stringify(OPENED_RECORD)}\n`
    const client = await PerforceClient.create(
      ROOT,
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 4000 },
      undefined,
    )
    expect(client).toBeDefined()
    await client!.refresh()

    expect(sc!.acceptInputCommand?.command).toBe('perforce.submitDefault')
    expect(sc!.acceptInputCommand?.disabled).toBe(false)
    expect(sc!.acceptInputActions).toBeDefined()
    expect(sc!.acceptInputActions!.length).toBeGreaterThanOrEqual(2)

    client!.dispose()
  })

  it('keeps Submit disabled when only a numbered changelist has files', async () => {
    openedStdout = `${JSON.stringify({ ...OPENED_RECORD, change: '12345' })}\n`
    const client = await PerforceClient.create(
      ROOT,
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 4000 },
      undefined,
    )
    expect(client).toBeDefined()
    await client!.refresh()

    expect(sc!.acceptInputCommand?.command).toBe('perforce.submitDefault')
    expect(sc!.acceptInputCommand?.disabled).toBe(true)
    expect(sc!.acceptInputActions).toBeUndefined()

    client!.dispose()
  })
})
