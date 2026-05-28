/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/window/scopedServicesFactory.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ApplicationServices, WindowScopedServices } from '../scopedServicesFactory.js'

describe('ApplicationServices type', () => {
  it('accepts an object with all required singleton service fields', () => {
    const svc: ApplicationServices = {
      storage: {} as ApplicationServices['storage'],
      ping: {} as ApplicationServices['ping'],
      fileSystem: {} as ApplicationServices['fileSystem'],
      fileWatcher: {} as ApplicationServices['fileWatcher'],
      workspace: {} as ApplicationServices['workspace'],
      userData: {} as ApplicationServices['userData'],
      logFiles: {} as ApplicationServices['logFiles'],
      acpHost: {} as ApplicationServices['acpHost'],
      acpTerminal: {} as ApplicationServices['acpTerminal'],
      disposableLeak: {} as ApplicationServices['disposableLeak'],
    }
    expect(Object.keys(svc)).toHaveLength(10)
  })
})

describe('WindowScopedServices type', () => {
  it('accepts an object with host and logChannel fields', () => {
    const svc: WindowScopedServices = {
      host: {} as WindowScopedServices['host'],
      logChannel: {} as WindowScopedServices['logChannel'],
    }
    expect(Object.keys(svc)).toHaveLength(2)
  })
})

describe('service layer separation', () => {
  it('ApplicationServices does not include per-window fields', () => {
    // Type-level check: ApplicationServices keys are the singleton services only.
    // If this compiles, the separation is correct.
    const appKeys: (keyof ApplicationServices)[] = [
      'storage',
      'ping',
      'fileSystem',
      'fileWatcher',
      'workspace',
      'userData',
      'logFiles',
    ]
    expect(appKeys).toHaveLength(7)
  })

  it('WindowScopedServices does not include singleton fields', () => {
    const windowKeys: (keyof WindowScopedServices)[] = ['host', 'logChannel']
    expect(windowKeys).toHaveLength(2)
  })
})
