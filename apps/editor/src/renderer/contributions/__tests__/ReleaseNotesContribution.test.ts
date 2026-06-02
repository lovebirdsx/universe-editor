/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ReleaseNotesContribution — the upgrade-detection logic that decides
 *  whether to open a "what's new" tab. Dependencies are faked at the injected
 *  interface boundary (no Electron, no real IPC).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  IEditorGroupsService,
  IEditorInput,
  IStorageService,
  StorageScope,
} from '@universe-editor/platform'
import { ReleaseNotesContribution } from '../ReleaseNotesContribution.js'
import { ReleaseNotesInput } from '../../services/editor/ReleaseNotesInput.js'
import type { IReleaseNote, IReleaseNotesService } from '../../../shared/ipc/releaseNotesService.js'

const LAST_VERSION_KEY = 'app.releaseNotes.lastVersion'
const EXISTING_INSTALL_MARKER_KEY = 'workbench.windowsState'

const NOTES: IReleaseNote[] = [
  {
    version: '0.1.3',
    date: '2026-06-02',
    groups: [{ type: 'feat', title: '新功能', items: ['C'] }],
  },
  {
    version: '0.1.2',
    date: '2026-05-20',
    groups: [{ type: 'fix', title: 'Bug 修复', items: ['B'] }],
  },
  {
    version: '0.1.1',
    date: '2026-05-01',
    groups: [{ type: 'feat', title: '新功能', items: ['A'] }],
  },
]

function fakeReleaseNotes(currentVersion: string, notes = NOTES): IReleaseNotesService {
  return {
    _serviceBrand: undefined,
    getReleaseNotes: async () => ({ currentVersion, notes }),
  }
}

function fakeStorage(initial?: string | Record<string, unknown>): {
  service: IStorageService
  read: (key?: string) => unknown
} {
  const store =
    typeof initial === 'string'
      ? new Map<string, unknown>([[LAST_VERSION_KEY, initial]])
      : new Map<string, unknown>(Object.entries(initial ?? {}))
  const service = {
    _serviceBrand: undefined,
    async get<T>(key: string, _scope: StorageScope): Promise<T | undefined> {
      return store.get(key) as T | undefined
    },
    async set(key: string, v: unknown): Promise<void> {
      store.set(key, v)
    },
    async remove(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as IStorageService
  return { service, read: (key = LAST_VERSION_KEY) => store.get(key) }
}

function fakeGroups(): { service: IEditorGroupsService; opened: IEditorInput[] } {
  const opened: IEditorInput[] = []
  const service = {
    activeGroup: {
      openEditor(input: IEditorInput) {
        opened.push(input)
      },
    },
  } as unknown as IEditorGroupsService
  return { service, opened }
}

describe('ReleaseNotesContribution', () => {
  it('records the version silently on first install (no tab)', async () => {
    const storage = fakeStorage(undefined)
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.1.3'),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(0)
    expect(storage.read()).toBe('0.1.3')
  })

  it('opens the current what’s-new tab for an existing install missing the version marker', async () => {
    const storage = fakeStorage({ [EXISTING_INSTALL_MARKER_KEY]: [{ id: 1 }] })
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.1.3'),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(1)
    const input = groups.opened[0]
    expect(input).toBeInstanceOf(ReleaseNotesInput)
    const md = (input as ReleaseNotesInput).markdown
    expect(md).toContain('## 0.1.3')
    expect(md).not.toContain('## 0.1.2')
    expect(storage.read()).toBe('0.1.3')
  })

  it('opens a what’s-new tab covering the range on upgrade', async () => {
    const storage = fakeStorage('0.1.1')
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.1.3'),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(1)
    const input = groups.opened[0]
    expect(input).toBeInstanceOf(ReleaseNotesInput)
    const md = (input as ReleaseNotesInput).markdown
    expect(md).toContain('## 0.1.3')
    expect(md).toContain('## 0.1.2')
    expect(md).not.toContain('## 0.1.1')
    expect(storage.read()).toBe('0.1.3')
  })

  it('does nothing when the version is unchanged', async () => {
    const storage = fakeStorage('0.1.3')
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.1.3'),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(0)
  })

  it('advances the version without a tab when the range has no notes', async () => {
    const storage = fakeStorage('0.1.3')
    const groups = fakeGroups()
    // current newer than last, but no notes entries fall in the range
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.2.0'),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(0)
    expect(storage.read()).toBe('0.2.0')
  })
})
