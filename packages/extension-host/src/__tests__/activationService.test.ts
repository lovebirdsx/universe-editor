import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionActivationService } from '../activationService.js'
import type { IActivationErrorReport } from '../activationService.js'
import type { IScannedExtension } from '../extensionScanner.js'

// An extension module that records its activation by writing to a global the test
// can read back (the host imports it as a real ESM module).
const EXT_SOURCE = `
globalThis.__activationCount = (globalThis.__activationCount ?? 0) + 1
export function activate() {
  globalThis.__activated = (globalThis.__activated ?? 0) + 1
}
`

let dir: string
let mainPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ue-act-'))
  mainPath = join(dir, 'extension.mjs')
  await writeFile(mainPath, EXT_SOURCE, 'utf8')
  ;(globalThis as Record<string, unknown>).__activated = 0
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>).__activated
})

function scanned(
  activationEvents: string[],
  overrides: Partial<IScannedExtension> = {},
): IScannedExtension {
  return {
    id: 'test.ext',
    extensionPath: dir,
    builtin: false,
    mainPath,
    manifest: {
      name: 'ext',
      version: '0.0.0',
      main: 'extension.mjs',
      engines: { universe: '^0.1.0' },
      activationEvents,
    },
    ...overrides,
  }
}

const activatedCount = () => (globalThis as Record<string, unknown>).__activated as number

describe('ExtensionActivationService', () => {
  it('does not activate until a matching event fires', async () => {
    const svc = new ExtensionActivationService([scanned(['onCommand:test.cmd'])], () => true)
    await svc.activateByEvent('onCommand:unrelated')
    expect(activatedCount()).toBe(0)
  })

  it('activates when a declared event fires', async () => {
    const svc = new ExtensionActivationService([scanned(['onCommand:test.cmd'])], () => true)
    await svc.activateByEvent('onCommand:test.cmd')
    expect(activatedCount()).toBe(1)
  })

  it('a wildcard extension activates on any non-startup event', async () => {
    const svc = new ExtensionActivationService([scanned(['*'])], () => true)
    await svc.activateByEvent('onStartupFinished')
    expect(activatedCount()).toBe(1)
  })

  it('activates each extension at most once across repeated events', async () => {
    const svc = new ExtensionActivationService([scanned(['*'])], () => true)
    await svc.activateByEvent('onStartupFinished')
    await svc.activateByEvent('onStartupFinished')
    expect(activatedCount()).toBe(1)
  })

  it('isolates a throwing activate without rejecting', async () => {
    const badMain = join(dir, 'bad.mjs')
    await writeFile(badMain, `export function activate() { throw new Error('boom') }`, 'utf8')
    const ext: IScannedExtension = {
      id: 'bad.ext',
      extensionPath: dir,
      builtin: false,
      mainPath: badMain,
      manifest: {
        name: 'bad',
        version: '0.0.0',
        main: 'bad.mjs',
        engines: { universe: '^0.1.0' },
        activationEvents: ['*'],
      },
    }
    const svc = new ExtensionActivationService([ext], () => true)
    await expect(svc.activateByEvent('onStartupFinished')).resolves.toBeUndefined()
  })

  it('reports a throwing activate to the error sink', async () => {
    const badMain = join(dir, 'bad2.mjs')
    await writeFile(badMain, `export function activate() { throw new Error('boom') }`, 'utf8')
    const ext: IScannedExtension = {
      id: 'bad.ext',
      extensionPath: dir,
      builtin: false,
      mainPath: badMain,
      manifest: {
        name: 'bad',
        version: '0.0.0',
        main: 'bad2.mjs',
        displayName: 'Bad Extension',
        engines: { universe: '^0.1.0' },
        activationEvents: ['*'],
      },
    }
    const reports: IActivationErrorReport[] = []
    const svc = new ExtensionActivationService(
      [ext],
      () => true,
      undefined,
      undefined,
      (r) => reports.push(r),
    )
    await svc.activateByEvent('onStartupFinished')
    expect(reports).toHaveLength(1)
    expect(reports[0]!.extensionId).toBe('bad.ext')
    expect(reports[0]!.displayName).toBe('Bad Extension')
    expect(reports[0]!.message).toBe('boom')
    expect(reports[0]!.stack).toContain('boom')
  })

  it('does not report when activate succeeds', async () => {
    const reports: IActivationErrorReport[] = []
    const svc = new ExtensionActivationService(
      [scanned(['*'])],
      () => true,
      undefined,
      undefined,
      (r) => reports.push(r),
    )
    await svc.activateByEvent('onStartupFinished')
    expect(reports).toHaveLength(0)
  })

  it('does not activate a main extension in an untrusted workspace (default gate)', async () => {
    const svc = new ExtensionActivationService([scanned(['*'])], () => false)
    await svc.activateByEvent('onStartupFinished')
    expect(activatedCount()).toBe(0)
  })

  it('activates an untrusted-supported extension even when untrusted', async () => {
    const ext = scanned(['*'], {
      manifest: {
        name: 'ext',
        version: '0.0.0',
        main: 'extension.mjs',
        engines: { universe: '^0.1.0' },
        activationEvents: ['*'],
        capabilities: {
          untrustedWorkspaces: { supported: 'limited', description: 'runs limited' },
        },
      },
    })
    const svc = new ExtensionActivationService([ext], () => false)
    await svc.activateByEvent('onStartupFinished')
    expect(activatedCount()).toBe(1)
  })

  it('activates a built-in extension even when untrusted', async () => {
    const svc = new ExtensionActivationService([scanned(['*'], { builtin: true })], () => false)
    await svc.activateByEvent('onStartupFinished')
    expect(activatedCount()).toBe(1)
  })

  it('replayFiredEvents activates gated-off extensions after trust flips', async () => {
    let trusted = false
    const svc = new ExtensionActivationService([scanned(['onLanguage:typescript'])], () => trusted)
    await svc.activateByEvent('onLanguage:typescript')
    expect(activatedCount()).toBe(0) // gated off while untrusted

    trusted = true
    await svc.replayFiredEvents()
    expect(activatedCount()).toBe(1) // the earlier event is replayed
  })
})
