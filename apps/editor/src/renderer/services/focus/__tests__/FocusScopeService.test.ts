/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/focus/FocusScopeService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  URI,
  UriIdentityService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { FocusScopeService } from '../FocusScopeService.js'

const ROOT = URI.file('/repo')

function makeWorkspace(folder: URI | null = ROOT) {
  const onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  let current: IWorkspace | null = folder ? { folder, name: 'repo' } : null
  const service = {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: onDidChangeWorkspace.event,
    recent: [],
    onDidChangeRecent: new Emitter<never>().event,
    whenReady: Promise.resolve(),
  } as unknown as IWorkspaceService

  return {
    service,
    setFolder(next: URI | null) {
      current = next ? { folder: next, name: 'repo' } : null
      onDidChangeWorkspace.fire(current)
    },
  }
}

function makeService(platform: 'win32' | 'linux' = 'linux') {
  const config = new ConfigurationService()
  const workspace = makeWorkspace()
  const svc = new FocusScopeService(config, workspace.service, new UriIdentityService(platform))
  return { config, workspace, svc }
}

function enableFocus(config: ConfigurationService, folders: Record<string, unknown>) {
  config.update('workspace.focusEnabled', true, ConfigurationTarget.User)
  config.update('workspace.focusFolders', folders, ConfigurationTarget.User)
}

describe('FocusScopeService', () => {
  it('is inactive by default and scans the whole workspace', () => {
    const { svc } = makeService()
    expect(svc.active).toBe(false)
    expect(svc.folders).toEqual([])
    expect(svc.scanRoots.map((u) => u.path)).toEqual(['/repo'])
    expect(svc.isVisible('anything', false)).toBe(true)
  })

  it('resolves scan roots to the focused subfolders', () => {
    const { config, svc } = makeService()
    enableFocus(config, { Client: true, 'Tools/Editor': true })
    expect(svc.active).toBe(true)
    expect(svc.scanRoots.map((u) => u.path)).toEqual(['/repo/Client', '/repo/Tools/Editor'])
  })

  it('stays inactive when enabled but no folder is configured', () => {
    // Otherwise focus mode would hide the entire workspace the moment a user
    // flipped the toggle before picking any folder.
    const { config, svc } = makeService()
    config.update('workspace.focusEnabled', true, ConfigurationTarget.User)
    expect(svc.enabled).toBe(true)
    expect(svc.active).toBe(false)
    expect(svc.scanRoots.map((u) => u.path)).toEqual(['/repo'])
  })

  it('ignores focus folders while the toggle is off', () => {
    const { config, svc } = makeService()
    config.update('workspace.focusFolders', { Client: true }, ConfigurationTarget.User)
    expect(svc.active).toBe(false)
    expect(svc.folders).toEqual([])
  })

  it('merges focus folders across layers and honours a false override', () => {
    // The team commits Client + Server at the Project layer; a developer adds
    // Tools and cancels Server for themselves without restating the rest.
    const { config, svc } = makeService()
    config.update('workspace.focusEnabled', true, ConfigurationTarget.User)
    config.update(
      'workspace.focusFolders',
      { Client: true, Server: true },
      ConfigurationTarget.User,
    )
    config.update(
      'workspace.focusFolders',
      { Server: false, Tools: true },
      ConfigurationTarget.Project,
    )
    expect(svc.folders).toEqual(['Client', 'Tools'])
  })

  it('classifies visibility for skeleton dirs, root files and out-of-scope paths', () => {
    const { config, svc } = makeService()
    enableFocus(config, { 'Tools/Editor': true })
    expect(svc.isVisible('Tools', true)).toBe(true)
    expect(svc.isVisible('Tools/Editor/src/a.ts', false)).toBe(true)
    expect(svc.isVisible('Tools/build.bat', false)).toBe(false)
    expect(svc.isVisible('README.md', false)).toBe(true)
    expect(svc.isVisible('Engine', true)).toBe(false)
  })

  it('hides root files when focusShowRootFiles is off', () => {
    const { config, svc } = makeService()
    enableFocus(config, { Client: true })
    config.update('workspace.focusShowRootFiles', false, ConfigurationTarget.User)
    expect(svc.showRootFiles).toBe(false)
    expect(svc.rootFilesInScope).toBe(false)
    expect(svc.isVisible('README.md', false)).toBe(false)
  })

  it('reports rootFilesInScope only while focus is active', () => {
    const { config, svc } = makeService()
    expect(svc.rootFilesInScope).toBe(false)
    enableFocus(config, { Client: true })
    expect(svc.rootFilesInScope).toBe(true)
  })

  it('fires once per effective change and stays quiet otherwise', () => {
    const { config, svc } = makeService()
    const listener = vi.fn()
    svc.onDidChange(listener)

    enableFocus(config, { Client: true })
    const afterEnable = listener.mock.calls.length
    expect(afterEnable).toBeGreaterThan(0)

    // Rewriting the same value must not fire — consumers rebuild scan caches on
    // every event, and a no-op event would re-run a full workspace listing.
    config.update('workspace.focusFolders', { Client: true }, ConfigurationTarget.User)
    expect(listener.mock.calls.length).toBe(afterEnable)

    // A trailing slash normalizes to the same folder, so it is also a no-op.
    config.update('workspace.focusFolders', { 'Client/': true }, ConfigurationTarget.User)
    expect(listener.mock.calls.length).toBe(afterEnable)
  })

  it('recomputes scan roots when the workspace folder changes', () => {
    const { config, workspace, svc } = makeService()
    enableFocus(config, { Client: true })
    const listener = vi.fn()
    svc.onDidChange(listener)

    workspace.setFolder(URI.file('/other'))
    expect(svc.scanRoots.map((u) => u.path)).toEqual(['/other/Client'])
    expect(listener).toHaveBeenCalled()
  })

  it('reports no scan roots when no workspace is open', () => {
    const { config, workspace, svc } = makeService()
    enableFocus(config, { Client: true })
    workspace.setFolder(null)
    expect(svc.scanRoots).toEqual([])
  })

  it('changes fingerprint with the resolved scope', () => {
    const { config, svc } = makeService()
    const before = svc.fingerprint
    enableFocus(config, { Client: true })
    expect(svc.fingerprint).not.toBe(before)
  })

  it('keeps folder sets with spaces apart in the fingerprint', () => {
    // A space separator collides: ['a b','c'] and ['a','b c'] flatten alike, and
    // folder names with spaces are common enough for a scan cache keyed on this
    // to serve another scope's results.
    const a = makeService()
    enableFocus(a.config, { 'a b': true, c: true })
    const b = makeService()
    enableFocus(b.config, { a: true, 'b c': true })
    expect(a.svc.folders).toEqual(['a b', 'c'])
    expect(b.svc.folders).toEqual(['a', 'b c'])
    expect(a.svc.fingerprint).not.toBe(b.svc.fingerprint)
  })

  it('notifies when only the toggle moves, with no folder configured', () => {
    // The status bar distinguishes "off" from "on with nothing focused"; the
    // fingerprint deliberately stays scope-only (a toggle with no folders cannot
    // change a scan result), so the event cannot key on it alone.
    const { config, svc } = makeService()
    const listener = vi.fn()
    svc.onDidChange(listener)

    config.update('workspace.focusEnabled', true, ConfigurationTarget.User)
    expect(svc.enabled).toBe(true)
    expect(svc.active).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('FocusScopeService writes', () => {
  it('persists a focus set to the Project layer, not User', async () => {
    // Focus folders are workspace-relative: `Client` means nothing in the next
    // folder the user opens, so writing them globally would leak a stale focus
    // into every other workspace.
    const { config, svc } = makeService()
    await svc.setFolders(['Client'])

    expect(config.getLayerSnapshot(ConfigurationTarget.Project)).toEqual({
      'workspace.focusFolders': { Client: true },
      'workspace.focusEnabled': true,
    })
    expect(config.getLayerSnapshot(ConfigurationTarget.User)).toEqual({})
    expect(svc.folders).toEqual(['Client'])
    expect(svc.active).toBe(true)
  })

  it('normalizes written paths and collapses nested entries', async () => {
    const { config, svc } = makeService()
    await svc.setFolders(['\\Client\\', 'Client/Sub', 'Tools/Editor'])

    expect(config.getValueForTarget('workspace.focusFolders', ConfigurationTarget.Project)).toEqual(
      {
        Client: true,
        'Tools/Editor': true,
      },
    )
    expect(svc.folders).toEqual(['Client', 'Tools/Editor'])
  })

  it('adds and removes folders without restating the rest', async () => {
    const { svc } = makeService()
    await svc.setFolders(['Client'])
    await svc.addFolders(['Server'])
    expect(svc.folders).toEqual(['Client', 'Server'])

    await svc.removeFolders(['Client'])
    expect(svc.folders).toEqual(['Server'])
  })

  it('turns focus off when the last folder is removed', async () => {
    // Focus on with nothing focused looks exactly like unfocused, so leaving the
    // flag set would make the status bar claim a scope that filters nothing.
    const { config, svc } = makeService()
    await svc.setFolders(['Client'])
    await svc.removeFolders(['Client'])

    expect(config.getValueForTarget('workspace.focusEnabled', ConfigurationTarget.Project)).toBe(
      false,
    )
    expect(svc.enabled).toBe(false)
    expect(svc.active).toBe(false)
    expect(svc.scanRoots.map((u) => u.path)).toEqual(['/repo'])
  })

  it('cancels a lower-layer entry with false instead of dropping it silently', async () => {
    // The user focuses Client + Server globally; removing Server here must write
    // an explicit `false`, otherwise the per-key merge re-inherits it.
    const { config, svc } = makeService()
    config.update('workspace.focusEnabled', true, ConfigurationTarget.User)
    config.update(
      'workspace.focusFolders',
      { Client: true, Server: true },
      ConfigurationTarget.User,
    )
    expect(svc.folders).toEqual(['Client', 'Server'])

    await svc.removeFolders(['Server'])

    expect(config.getValueForTarget('workspace.focusFolders', ConfigurationTarget.Project)).toEqual(
      {
        Client: true,
        Server: false,
      },
    )
    expect(svc.folders).toEqual(['Client'])
  })

  it('re-focusing a single folder cancels the others it replaces', async () => {
    const { config, svc } = makeService()
    config.update('workspace.focusEnabled', true, ConfigurationTarget.User)
    config.update(
      'workspace.focusFolders',
      { Client: true, Server: true },
      ConfigurationTarget.User,
    )

    await svc.setFolders(['Tools/Editor'])

    expect(config.getValueForTarget('workspace.focusFolders', ConfigurationTarget.Project)).toEqual(
      {
        'Tools/Editor': true,
        Client: false,
        Server: false,
      },
    )
    expect(svc.folders).toEqual(['Tools/Editor'])
  })

  it('setEnabled(false) keeps the folder set for a later re-enable', async () => {
    // Exiting focus mode is a view toggle, not a reset: retyping the folders is
    // exactly the tedium this feature exists to remove.
    const { config, svc } = makeService()
    await svc.setFolders(['Client', 'Server'])
    await svc.setEnabled(false)

    expect(svc.active).toBe(false)
    expect(config.getValueForTarget('workspace.focusFolders', ConfigurationTarget.Project)).toEqual(
      {
        Client: true,
        Server: true,
      },
    )

    await svc.setEnabled(true)
    expect(svc.folders).toEqual(['Client', 'Server'])
  })

  it('ignores a no-op write and fires once for a real one', async () => {
    const { svc } = makeService()
    await svc.setFolders(['Client'])

    const listener = vi.fn()
    svc.onDidChange(listener)

    await svc.setEnabled(true)
    await svc.addFolders(['Client/'])
    await svc.removeFolders(['Engine'])
    expect(listener).not.toHaveBeenCalled()

    await svc.addFolders(['Server'])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('drops entries that address the workspace root itself', async () => {
    // '.', '/' and '' all mean "the whole workspace", which is what focus mode
    // turns off — accepting one as a focus folder would be a no-op in disguise.
    const { config, svc } = makeService()
    await svc.setFolders(['.', '', 'Client/..'])

    expect(config.getValueForTarget('workspace.focusFolders', ConfigurationTarget.Project)).toEqual(
      {},
    )
    expect(svc.active).toBe(false)
  })

  it('matches focus folders case-insensitively on win32', async () => {
    const config = new ConfigurationService()
    const workspace = makeWorkspace()
    const svc = new FocusScopeService(config, workspace.service, new UriIdentityService('win32'))

    await svc.setFolders(['Client'])
    expect(svc.isFocusFolder('client')).toBe(true)
    expect(svc.isFocusFolder('CLIENT\\')).toBe(true)
    expect(svc.isFocusFolder('Client/Sub')).toBe(false)
    expect(svc.isFocusFolder('Server')).toBe(false)

    // A differently-cased remove must still cancel the entry it matches.
    await svc.removeFolders(['CLIENT'])
    expect(svc.folders).toEqual([])
  })

  it('reports isFocusFolder only for exact focus folders', async () => {
    const { svc } = makeService()
    await svc.setFolders(['Tools/Editor'])
    expect(svc.isFocusFolder('Tools/Editor')).toBe(true)
    expect(svc.isFocusFolder('Tools')).toBe(false)
    expect(svc.isFocusFolder('Tools/Editor/src')).toBe(false)
    expect(svc.isFocusFolder('.')).toBe(false)
  })
})
