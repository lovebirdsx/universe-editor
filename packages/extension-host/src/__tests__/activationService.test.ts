import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionActivationService } from '../activationService.js'
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

function scanned(activationEvents: string[]): IScannedExtension {
  return {
    id: 'test.ext',
    extensionPath: dir,
    mainPath,
    manifest: {
      name: 'ext',
      version: '0.0.0',
      main: 'extension.mjs',
      engines: { universe: '^0.1.0' },
      activationEvents,
    },
  }
}

const activatedCount = () => (globalThis as Record<string, unknown>).__activated as number

describe('ExtensionActivationService', () => {
  it('does not activate until a matching event fires', async () => {
    const svc = new ExtensionActivationService([scanned(['onCommand:test.cmd'])])
    await svc.activateByEvent('onCommand:unrelated')
    expect(activatedCount()).toBe(0)
  })

  it('activates when a declared event fires', async () => {
    const svc = new ExtensionActivationService([scanned(['onCommand:test.cmd'])])
    await svc.activateByEvent('onCommand:test.cmd')
    expect(activatedCount()).toBe(1)
  })

  it('a wildcard extension activates on any non-startup event', async () => {
    const svc = new ExtensionActivationService([scanned(['*'])])
    await svc.activateByEvent('onStartupFinished')
    expect(activatedCount()).toBe(1)
  })

  it('activates each extension at most once across repeated events', async () => {
    const svc = new ExtensionActivationService([scanned(['*'])])
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
      mainPath: badMain,
      manifest: {
        name: 'bad',
        version: '0.0.0',
        main: 'bad.mjs',
        engines: { universe: '^0.1.0' },
        activationEvents: ['*'],
      },
    }
    const svc = new ExtensionActivationService([ext])
    await expect(svc.activateByEvent('onStartupFinished')).resolves.toBeUndefined()
  })
})
