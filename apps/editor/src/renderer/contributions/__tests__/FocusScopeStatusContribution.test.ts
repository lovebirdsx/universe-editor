/*---------------------------------------------------------------------------------------------
 *  Tests for FocusScopeStatusContribution — the folder-icon count status entry
 *  ("$(folder) N") shows only while a focus set is active and tracks onDidChange,
 *  and the `focusScopeActive` context key it publishes gates the focus commands.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  StatusBarAlignment,
  type IStatusBarService,
} from '@universe-editor/platform'
import { ManageFocusScopeAction } from '../../actions/focusScopeActions.js'
import { FakeFocusScopeService } from '../../services/focus/testing/fakeFocusScopeService.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { FocusScopeStatusContribution } from '../FocusScopeStatusContribution.js'

function makeContrib(folders: readonly string[]) {
  const statusBar: IStatusBarService = new StatusBarService()
  const focusScope = new FakeFocusScopeService(folders)
  const contextKeys = new ContextKeyService()
  const contrib = new FocusScopeStatusContribution(focusScope, statusBar, contextKeys)
  return { statusBar, focusScope, contextKeys, contrib }
}

describe('FocusScopeStatusContribution', () => {
  it('shows no entry when focus is inactive', () => {
    const { statusBar, contrib } = makeContrib([])
    expect(statusBar.entries.get()).toHaveLength(0)
    contrib.dispose()
  })

  it('shows the count for one focus folder', () => {
    const { statusBar, contrib } = makeContrib(['src'])
    const entries = statusBar.entries.get()
    expect(entries).toHaveLength(1)
    const entry = entries[0]?.entry
    expect(entry?.text).toBe('$(folder) 1')
    expect(entry?.tooltip).toContain('src')
    expect(entry?.command).toBe(ManageFocusScopeAction.ID)
    expect(entry?.alignment).toBe(StatusBarAlignment.Left)
    contrib.dispose()
  })

  it('shows the folder count and lists every folder in the tooltip', () => {
    const { statusBar, contrib } = makeContrib(['src', 'lib'])
    const entry = statusBar.entries.get()[0]?.entry
    expect(entry?.text).toBe('$(folder) 2')
    expect(entry?.tooltip).toContain('src')
    expect(entry?.tooltip).toContain('lib')
    contrib.dispose()
  })

  it('updates the count when the focus set changes', async () => {
    const { statusBar, focusScope, contrib } = makeContrib(['src'])
    await focusScope.addFolders(['lib'])
    const entries = statusBar.entries.get()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entry.text).toBe('$(folder) 2')
    contrib.dispose()
  })

  it('removes the entry when the focus set empties', async () => {
    const { statusBar, focusScope, contrib } = makeContrib(['src'])
    await focusScope.removeFolders(['src'])
    expect(statusBar.entries.get()).toHaveLength(0)
    contrib.dispose()
  })

  it('removes the entry when focus mode is turned off', async () => {
    const { statusBar, focusScope, contrib } = makeContrib(['src'])
    await focusScope.setEnabled(false)
    expect(statusBar.entries.get()).toHaveLength(0)
    contrib.dispose()
  })

  it('dispose removes the entry', () => {
    const { statusBar, contrib } = makeContrib(['src'])
    contrib.dispose()
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it('tracks focusScopeActive so the focus commands can gate on it', async () => {
    const { focusScope, contextKeys, contrib } = makeContrib([])
    expect(contextKeys.get('focusScopeActive')).toBe(false)

    await focusScope.setFolders(['src'])
    expect(contextKeys.get('focusScopeActive')).toBe(true)

    await focusScope.setEnabled(false)
    expect(contextKeys.get('focusScopeActive')).toBe(false)
    contrib.dispose()
  })

  // Enabled with no folders filters nothing, so it is indistinguishable from
  // unfocused unless the status bar shows it — and the way out has to stay
  // reachable there, which is why the entry (and the manage command behind it)
  // gates on `focusScopeEnabled` not `Active`.
  it('warns about the enabled-but-empty state instead of hiding the entry', () => {
    const { statusBar, focusScope, contextKeys, contrib } = makeContrib([])
    focusScope.setEnabledWithNoFolders()

    const entry = statusBar.entries.get()[0]?.entry
    expect(entry?.text).toBe('$(folder) 0')
    expect(entry?.tooltip).toContain('nothing is filtered')
    expect(entry?.command).toBe(ManageFocusScopeAction.ID)
    expect(entry?.kind).toBe('prominent')

    expect(contextKeys.get('focusScopeEnabled')).toBe(true)
    expect(contextKeys.get('focusScopeActive')).toBe(false)
    contrib.dispose()
  })

  it('tracks focusScopeEnabled independently of the folder set', async () => {
    const { focusScope, contextKeys, contrib } = makeContrib(['src'])
    expect(contextKeys.get('focusScopeEnabled')).toBe(true)

    // Removing the last folder turns focus off, so both keys drop.
    await focusScope.removeFolders(['src'])
    expect(contextKeys.get('focusScopeEnabled')).toBe(false)
    expect(contextKeys.get('focusScopeActive')).toBe(false)
    contrib.dispose()
  })
})
