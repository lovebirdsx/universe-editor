import { describe, expect, it, vi } from 'vitest'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the pure `handleSetActiveRepo` helper doesn't require the real host.
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

import { handleSetActiveRepo } from '../extension.js'
import type { ClientManager } from '../clientManager.js'
import type { P4StatusBarController } from '../p4StatusBar.js'

const ROOT = process.platform === 'win32' ? 'c:\\p4ws\\main' : '/p4ws/main'

/** A manager fake with the routing surface the handler touches. */
function makeManager(known: ReadonlySet<string>) {
  const setActive = vi.fn()
  const mgr = {
    // Mirror the real ClientManager.has, which normalizes the key first and
    // throws on null. Without this the null case below would pass even against
    // the pre-fix `root === undefined` guard.
    has: (root: string) => {
      if (root == null) throw new TypeError('Cannot read properties of null')
      return known.has(root)
    },
    setActive,
  } as unknown as ClientManager
  return { mgr, setActive }
}

function makeStatusBar() {
  const setVisible = vi.fn()
  return { statusBar: { setVisible } as unknown as P4StatusBarController, setVisible }
}

describe('handleSetActiveRepo', () => {
  it('hides the status bar when the root is undefined', () => {
    const { mgr } = makeManager(new Set([ROOT]))
    const { statusBar, setVisible } = makeStatusBar()

    handleSetActiveRepo(mgr, statusBar, undefined)

    expect(setVisible).toHaveBeenCalledWith(false)
  })

  it('treats null as no selection without throwing (RPC nested-args semantics)', () => {
    const { mgr, setActive } = makeManager(new Set([ROOT]))
    const { statusBar, setVisible } = makeStatusBar()

    expect(() => handleSetActiveRepo(mgr, statusBar, null)).not.toThrow()
    expect(setVisible).toHaveBeenCalledWith(false)
    expect(setActive).not.toHaveBeenCalled()
  })

  it('hides the status bar for a root the manager does not own', () => {
    const { mgr, setActive } = makeManager(new Set([ROOT]))
    const { statusBar, setVisible } = makeStatusBar()

    handleSetActiveRepo(mgr, statusBar, `${ROOT}/gitrepo`)

    expect(setVisible).toHaveBeenCalledWith(false)
    expect(setActive).not.toHaveBeenCalled()
  })

  it('activates the root and shows the status bar for an owned root', () => {
    const { mgr, setActive } = makeManager(new Set([ROOT]))
    const { statusBar, setVisible } = makeStatusBar()

    handleSetActiveRepo(mgr, statusBar, ROOT)

    expect(setActive).toHaveBeenCalledWith(ROOT)
    expect(setVisible).toHaveBeenCalledWith(true)
  })
})
