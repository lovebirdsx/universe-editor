import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExtensionActivationService } from '../activationService.js'
import type { IActivationErrorReport } from '../activationService.js'
import type { IScannedExtension } from '../extensionScanner.js'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'

// An extension module that records its activation by writing to a global the test
// can read back (the host imports it as a real ESM module).
const EXT_SOURCE = `
globalThis.__activationCount = (globalThis.__activationCount ?? 0) + 1
export function activate() {
  globalThis.__activated = (globalThis.__activated ?? 0) + 1
}
`

// Same idea, but `activate` parks on a global the test releases by hand, so a
// second event can be fired while this activation is provably still in flight.
const BLOCKING_SOURCE = `
globalThis.__blockingImports = (globalThis.__blockingImports ?? 0) + 1
export async function activate() {
  globalThis.__blockingEntered = (globalThis.__blockingEntered ?? 0) + 1
  await new Promise((resolve) => { globalThis.__releaseBlocking = resolve })
  globalThis.__blockingDone = (globalThis.__blockingDone ?? 0) + 1
}
`

let dir: string
let mainPath: string

beforeEach(async () => {
  dir = mkTempDir('ue-act-')
  mainPath = join(dir, 'extension.mjs')
  await writeFile(mainPath, EXT_SOURCE, 'utf8')
  ;(globalThis as Record<string, unknown>).__activated = 0
})
afterEach(async () => {
  removeDirWithRetry(dir)
  for (const key of [
    '__activated',
    '__blockingImports',
    '__blockingEntered',
    '__blockingDone',
    '__releaseBlocking',
  ]) {
    delete (globalThis as Record<string, unknown>)[key]
  }
})

const g = globalThis as Record<string, unknown>

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

/** An extension whose manifest contributes `commands` but declares no onCommand. */
function contributes(
  activationEvents: string[],
  commands: string[],
  overrides: Partial<IScannedExtension> = {},
): IScannedExtension {
  const ext = scanned(activationEvents, overrides)
  return {
    ...ext,
    manifest: {
      ...ext.manifest,
      contributes: { commands: commands.map((command) => ({ command, title: command })) },
    },
  }
}

/** Let every promise that is already resolvable settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await settle()
  }
  throw new Error('condition never became true')
}

const activatedCount = () => g.__activated as number

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

  it('activates a dev extension even when untrusted (--extension-development-path)', async () => {
    const svc = new ExtensionActivationService(
      [scanned(['*'], { isUnderDevelopment: true })],
      () => false,
    )
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

  it('captures the activate return value as exports', async () => {
    const exportsMain = join(dir, 'exports.mjs')
    await writeFile(exportsMain, `export function activate() { return { answer: 42 } }`, 'utf8')
    const ext = scanned(['*'], { mainPath: exportsMain })
    const svc = new ExtensionActivationService([ext], () => true)
    expect(svc.isActivated(ext.id)).toBe(false)
    expect(svc.getExports(ext.id)).toBeUndefined()

    await svc.activateByEvent('onStartupFinished')
    expect(svc.isActivated(ext.id)).toBe(true)
    expect(svc.getExports(ext.id)).toEqual({ answer: 42 })
  })

  it('activateById activates on demand, regardless of declared events', async () => {
    const svc = new ExtensionActivationService([scanned(['onCommand:test.cmd'])], () => true)
    const exportsValue = await svc.activateById('test.ext')
    expect(activatedCount()).toBe(1)
    expect(exportsValue).toBeUndefined() // the default fixture returns nothing
  })

  it('activateById resolves undefined for unknown or trust-gated extensions', async () => {
    const svc = new ExtensionActivationService([scanned(['*'])], () => false)
    await expect(svc.activateById('no.such')).resolves.toBeUndefined()
    await expect(svc.activateById('test.ext')).resolves.toBeUndefined()
    expect(activatedCount()).toBe(0)
  })
})

describe('ExtensionActivationService command-derived activation', () => {
  it('activates on an onCommand event derived from contributes.commands', async () => {
    const svc = new ExtensionActivationService(
      [contributes(['onStartupFinished'], ['test.cmd'])],
      () => true,
    )
    await svc.activateByEvent('onCommand:test.cmd')
    expect(activatedCount()).toBe(1)
  })

  it('does not activate for a command the manifest does not contribute', async () => {
    const svc = new ExtensionActivationService(
      [contributes(['onStartupFinished'], ['test.cmd'])],
      () => true,
    )
    await svc.activateByEvent('onCommand:test.other')
    expect(activatedCount()).toBe(0)
  })

  it('joins an in-flight activation instead of resolving immediately', async () => {
    const blockingMain = join(dir, 'blocking.mjs')
    await writeFile(blockingMain, BLOCKING_SOURCE, 'utf8')
    const svc = new ExtensionActivationService(
      [contributes(['onStartupFinished'], ['test.cmd'], { mainPath: blockingMain })],
      () => true,
    )

    // Startup activation (onStartupFinished) parks inside activate().
    const startup = svc.activateByEvent('onStartupFinished')
    await waitUntil(() => g.__blockingEntered === 1)
    expect(svc.isActivating).toBe(true)

    // The contributed command's event must wait for that activation, not race it.
    let settled = false
    const command = svc.activateByEvent('onCommand:test.cmd').then(() => {
      settled = true
    })
    await settle()
    expect(settled).toBe(false)
    ;(g.__releaseBlocking as () => void)()
    await Promise.all([startup, command])
    expect(settled).toBe(true)
    expect(g.__blockingImports).toBe(1) // joined the import, did not re-enter it
    expect(g.__blockingDone).toBe(1) // activate() ran exactly once
  })

  it('resolves an event no extension matches without waiting for other activations', async () => {
    const blockingMain = join(dir, 'blocking2.mjs')
    await writeFile(blockingMain, BLOCKING_SOURCE, 'utf8')
    const svc = new ExtensionActivationService(
      [contributes(['onStartupFinished'], ['test.cmd'], { mainPath: blockingMain })],
      () => true,
    )
    const startup = svc.activateByEvent('onStartupFinished')
    await waitUntil(() => g.__blockingEntered === 1)

    let settled = false
    const unrelated = svc.activateByEvent('onCommand:no.such.command').then(() => {
      settled = true
    })
    await settle()
    expect(settled).toBe(true)
    ;(g.__releaseBlocking as () => void)()
    await Promise.all([startup, unrelated])
  })

  it('still resolves the derived command event when activate() throws', async () => {
    const badMain = join(dir, 'bad-derived.mjs')
    await writeFile(badMain, `export async function activate() { throw new Error('boom') }`, 'utf8')
    const reports: IActivationErrorReport[] = []
    const svc = new ExtensionActivationService(
      [contributes(['onStartupFinished'], ['test.cmd'], { mainPath: badMain })],
      () => true,
      undefined,
      undefined,
      (r) => reports.push(r),
    )
    await expect(svc.activateByEvent('onCommand:test.cmd')).resolves.toBeUndefined()
    expect(reports).toHaveLength(1)
    expect(svc.isActivating).toBe(false)
  })
})
