/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/focus/focusScopeUtils.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { UriIdentityService } from '@universe-editor/platform'
import { classifyFocusPath, isFocusVisible, normalizeFocusFolders } from '../focusScopeUtils.js'

const win32 = new UriIdentityService('win32')
const linux = new UriIdentityService('linux')

describe('normalizeFocusFolders', () => {
  it('keeps only entries whose value is exactly true', () => {
    expect(
      normalizeFocusFolders({ Client: true, Server: false, Tools: 1, Docs: 'yes' }, win32),
    ).toEqual(['Client'])
  })

  it('canonicalizes separators and strips leading/trailing slashes', () => {
    expect(
      normalizeFocusFolders({ '/Client/': true, 'Tools\\Editor': true, './Server': true }, win32),
    ).toEqual(['Client', 'Tools/Editor', 'Server'])
  })

  it('preserves the configured order (it is what the UI displays)', () => {
    expect(normalizeFocusFolders({ Server: true, Client: true }, win32)).toEqual([
      'Server',
      'Client',
    ])
  })

  it('collapses nested entries to their shallowest ancestor', () => {
    // Both A and A/B focused must yield just A — two overlapping recursive
    // watcher subscriptions would report every event under A/B twice.
    expect(normalizeFocusFolders({ 'A/B': true, A: true }, win32)).toEqual(['A'])
    expect(normalizeFocusFolders({ 'A/B/C': true, 'A/B': true, D: true }, win32)).toEqual([
      'A/B',
      'D',
    ])
  })

  it('keeps siblings that merely share a name prefix', () => {
    expect(normalizeFocusFolders({ Client: true, ClientTools: true }, win32)).toEqual([
      'Client',
      'ClientTools',
    ])
  })

  it('collapses nesting case-insensitively on win32 but not on linux', () => {
    const raw = { Client: true, 'client/Sub': true }
    expect(normalizeFocusFolders(raw, win32)).toEqual(['Client'])
    expect(normalizeFocusFolders(raw, linux)).toEqual(['Client', 'client/Sub'])
  })

  it('dedupes entries that differ only by case on win32', () => {
    expect(normalizeFocusFolders({ Client: true, client: true }, win32)).toEqual(['Client'])
    expect(normalizeFocusFolders({ Client: true, client: true }, linux)).toEqual([
      'Client',
      'client',
    ])
  })

  it('drops entries that address the workspace root itself', () => {
    expect(normalizeFocusFolders({ '.': true, '/': true, '': true }, win32)).toEqual([])
  })

  it('drops entries that escape the workspace root', () => {
    // Clamping `../Other` to the root would turn a typo into "focus everything".
    expect(normalizeFocusFolders({ '../Other': true, Client: true }, win32)).toEqual(['Client'])
  })

  it('resolves interior .. segments', () => {
    expect(normalizeFocusFolders({ 'Tools/../Client': true }, win32)).toEqual(['Client'])
  })
})

describe('classifyFocusPath', () => {
  const folders = ['Client', 'Tools/Editor']

  it('treats everything as in scope when no folders are focused', () => {
    expect(classifyFocusPath('anything/at/all', false, [], true, linux)).toBe('inScope')
  })

  it('puts a focus folder and its descendants in scope', () => {
    expect(classifyFocusPath('Client', true, folders, true, linux)).toBe('inScope')
    expect(classifyFocusPath('Client/Source/main.cpp', false, folders, true, linux)).toBe('inScope')
    expect(classifyFocusPath('Tools/Editor/src/app.ts', false, folders, true, linux)).toBe(
      'inScope',
    )
  })

  it('marks ancestors of a focus folder as skeleton', () => {
    expect(classifyFocusPath('Tools', true, folders, true, linux)).toBe('skeleton')
  })

  it('puts unrelated directories out of scope', () => {
    expect(classifyFocusPath('Engine', true, folders, true, linux)).toBe('out')
    expect(classifyFocusPath('Tools/Cooker', true, folders, true, linux)).toBe('out')
  })

  it('does not mistake a name-prefix sibling for a descendant', () => {
    expect(classifyFocusPath('ClientTools', true, folders, true, linux)).toBe('out')
    expect(classifyFocusPath('ClientTools/x.ts', false, folders, true, linux)).toBe('out')
  })

  it('gates root-level files on showRootFiles', () => {
    expect(classifyFocusPath('README.md', false, folders, true, linux)).toBe('inScope')
    expect(classifyFocusPath('README.md', false, folders, false, linux)).toBe('out')
  })

  it('always hides files inside a skeleton directory', () => {
    // Tools/ exists only as a path to Tools/Editor; its own files are noise
    // regardless of showRootFiles, which is about the workspace root only.
    expect(classifyFocusPath('Tools/build.bat', false, folders, true, linux)).toBe('out')
    expect(classifyFocusPath('Tools/build.bat', false, folders, false, linux)).toBe('out')
  })

  it('keeps the workspace root itself in scope', () => {
    expect(classifyFocusPath('', true, folders, true, linux)).toBe('inScope')
  })

  // Regression: the focus settings live in .universe-editor/settings.json, so
  // hiding that directory locked the user's own settings file behind the filter
  // they would edit it to change.
  it('never hides the editor configuration directories', () => {
    expect(classifyFocusPath('.universe-editor', true, folders, true, linux)).toBe('inScope')
    expect(classifyFocusPath('.universe-editor/settings.json', false, folders, true, linux)).toBe(
      'inScope',
    )
    expect(classifyFocusPath('.vscode', true, folders, true, linux)).toBe('inScope')
    expect(classifyFocusPath('.vscode/settings.json', false, folders, true, linux)).toBe('inScope')
  })

  it('keeps configuration directories visible even with root files hidden', () => {
    // showRootFiles is about README / build scripts; it must not be able to
    // hide the settings file, which is the escape hatch out of focus mode.
    expect(classifyFocusPath('.universe-editor/settings.json', false, folders, false, linux)).toBe(
      'inScope',
    )
  })

  it('exempts configuration directories at the root only', () => {
    // Exempting the name at any depth would be a wildcard hole in the filter.
    expect(classifyFocusPath('Engine/.vscode', true, folders, true, linux)).toBe('out')
    expect(classifyFocusPath('Engine/.vscode/settings.json', false, folders, true, linux)).toBe(
      'out',
    )
  })

  it('exempts configuration directories case-insensitively on win32', () => {
    expect(classifyFocusPath('.VSCode', true, folders, true, win32)).toBe('inScope')
    expect(classifyFocusPath('.Universe-Editor/settings.json', false, folders, true, win32)).toBe(
      'inScope',
    )
  })

  it('does not exempt a root-level file that merely carries the name', () => {
    // The exemption is about the configuration directories; a root *file* is
    // governed by showRootFiles like every other root file.
    expect(classifyFocusPath('.vscode', false, folders, false, linux)).toBe('out')
    expect(classifyFocusPath('.vscode', false, folders, true, linux)).toBe('inScope')
  })

  it('matches case-insensitively on win32 so a typed folder still resolves', () => {
    // The folders are typed by a human and the path comes from disk, so their
    // case will not match on win32. A case-sensitive test would classify the
    // focus folder itself as out of scope and render an empty tree.
    expect(classifyFocusPath('Client', true, ['client'], true, win32)).toBe('inScope')
    expect(classifyFocusPath('Client/Source/main.cpp', false, ['client'], true, win32)).toBe(
      'inScope',
    )
    expect(classifyFocusPath('TOOLS', true, ['tools/editor'], true, win32)).toBe('skeleton')
    expect(classifyFocusPath('Engine', true, ['client'], true, win32)).toBe('out')
    // Prefix siblings must still not match once case is folded.
    expect(classifyFocusPath('ClientTools', true, ['client'], true, win32)).toBe('out')
  })

  it('stays case-sensitive on linux, where two casings are two directories', () => {
    expect(classifyFocusPath('Client', true, ['client'], true, linux)).toBe('out')
  })
})

describe('isFocusVisible', () => {
  const folders = ['Tools/Editor']

  it('counts skeleton directories as visible so the tree can render them', () => {
    expect(isFocusVisible('Tools', true, folders, true, linux)).toBe(true)
  })

  it('hides out-of-scope entries', () => {
    expect(isFocusVisible('Engine', true, folders, true, linux)).toBe(false)
  })
})
