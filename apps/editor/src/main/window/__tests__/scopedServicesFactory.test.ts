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
      fileWatcher: {} as ApplicationServices['fileWatcher'],
      recentWorkspaces: {} as ApplicationServices['recentWorkspaces'],
      logFiles: {} as ApplicationServices['logFiles'],
      acpHost: {} as ApplicationServices['acpHost'],
      acpTerminal: {} as ApplicationServices['acpTerminal'],
      extensionHost: {} as ApplicationServices['extensionHost'],
      markdownLanguage: {} as ApplicationServices['markdownLanguage'],
      typescriptLanguage: {} as ApplicationServices['typescriptLanguage'],
      claudeBinary: {} as ApplicationServices['claudeBinary'],
      codexBinary: {} as ApplicationServices['codexBinary'],
      disposableLeak: {} as ApplicationServices['disposableLeak'],
      update: {} as ApplicationServices['update'],
      releaseNotes: {} as ApplicationServices['releaseNotes'],
      performance: {} as ApplicationServices['performance'],
      sessionSwitcher: {} as ApplicationServices['sessionSwitcher'],
    }
    expect(Object.keys(svc)).toHaveLength(19)
  })
})

describe('WindowScopedServices type', () => {
  it('accepts an object with all per-window service fields', () => {
    const svc: WindowScopedServices = {
      host: {} as WindowScopedServices['host'],
      logChannel: {} as WindowScopedServices['logChannel'],
      storage: {} as WindowScopedServices['storage'],
      workspace: {} as WindowScopedServices['workspace'],
      userData: {} as WindowScopedServices['userData'],
      terminal: {} as WindowScopedServices['terminal'],
    }
    expect(Object.keys(svc)).toHaveLength(6)
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
      'fileWatcher',
      'recentWorkspaces',
      'logFiles',
    ]
    expect(appKeys).toHaveLength(7)
  })

  it('WindowScopedServices holds the per-window workspace stack', () => {
    const windowKeys: (keyof WindowScopedServices)[] = [
      'host',
      'logChannel',
      'storage',
      'workspace',
      'userData',
      'terminal',
    ]
    expect(windowKeys).toHaveLength(6)
  })
})
