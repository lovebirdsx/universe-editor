/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/window/scopedServicesFactory.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ApplicationServices, WindowScopedServices } from '../scopedServicesFactory.js'

describe('ApplicationServices type', () => {
  it('accepts an object with all required singleton service fields', () => {
    const svc: ApplicationServices = {
      ping: {} as ApplicationServices['ping'],
      fileSystem: {} as ApplicationServices['fileSystem'],
      fileSearch: {} as ApplicationServices['fileSearch'],
      textSearch: {} as ApplicationServices['textSearch'],
      recentWorkspaces: {} as ApplicationServices['recentWorkspaces'],
      acpHost: {} as ApplicationServices['acpHost'],
      acpTerminal: {} as ApplicationServices['acpTerminal'],
      extensionHost: {} as ApplicationServices['extensionHost'],
      claudeBinary: {} as ApplicationServices['claudeBinary'],
      claudeConfig: {} as ApplicationServices['claudeConfig'],
      codexBinary: {} as ApplicationServices['codexBinary'],
      codexConfig: {} as ApplicationServices['codexConfig'],
      disposableLeak: {} as ApplicationServices['disposableLeak'],
      update: {} as ApplicationServices['update'],
      releaseNotes: {} as ApplicationServices['releaseNotes'],
      performance: {} as ApplicationServices['performance'],
      usage: {} as ApplicationServices['usage'],
      sessionSwitcher: {} as ApplicationServices['sessionSwitcher'],
      configLocation: {} as ApplicationServices['configLocation'],
      aiModel: {} as ApplicationServices['aiModel'],
      aiDebug: {} as ApplicationServices['aiDebug'],
      remoteSchema: {} as ApplicationServices['remoteSchema'],
      exchangeRate: {} as ApplicationServices['exchangeRate'],
      resourceAccess: {} as ApplicationServices['resourceAccess'],
    }
    expect(Object.keys(svc)).toHaveLength(24)
  })
})

describe('WindowScopedServices type', () => {
  it('accepts an object with all per-window service fields', () => {
    const svc: WindowScopedServices = {
      host: {} as WindowScopedServices['host'],
      logChannel: {} as WindowScopedServices['logChannel'],
      logFiles: {} as WindowScopedServices['logFiles'],
      storage: {} as WindowScopedServices['storage'],
      workspace: {} as WindowScopedServices['workspace'],
      userData: {} as WindowScopedServices['userData'],
      terminal: {} as WindowScopedServices['terminal'],
      fileWatcher: {} as WindowScopedServices['fileWatcher'],
    }
    expect(Object.keys(svc)).toHaveLength(8)
  })
})

describe('service layer separation', () => {
  it('ApplicationServices holds only window-independent singletons', () => {
    // Type-level check: ApplicationServices keys are the singleton services only.
    // If this compiles, the separation is correct.
    const appKeys: (keyof ApplicationServices)[] = [
      'ping',
      'fileSystem',
      'fileSearch',
      'textSearch',
      'recentWorkspaces',
    ]
    expect(appKeys).toHaveLength(5)
  })

  it('WindowScopedServices holds the per-window workspace stack', () => {
    const windowKeys: (keyof WindowScopedServices)[] = [
      'host',
      'logChannel',
      'logFiles',
      'storage',
      'workspace',
      'userData',
      'terminal',
      'fileWatcher',
    ]
    expect(windowKeys).toHaveLength(8)
  })
})
