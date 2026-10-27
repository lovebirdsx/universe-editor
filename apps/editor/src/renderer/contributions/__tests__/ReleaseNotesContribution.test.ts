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
    title: '三版',
    summary: '摘要 C',
    body: '## 新功能\n\n- C\n',
  },
  { version: '0.1.2', date: '2026-05-20', title: '', summary: '', body: '## Bug 修复\n\n- B\n' },
  { version: '0.1.1', date: '2026-05-01', title: '', summary: '', body: '## 新功能\n\n- A\n' },
]

function versions(input: IEditorInput): string[] {
  return (input as ReleaseNotesInput).notes.map((note) => note.version)
}

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

function fakeGroups(): {
  service: IEditorGroupsService
  opened: IEditorInput[]
  openOptions: Record<string, unknown>[]
} {
  const opened: IEditorInput[] = []
  const openOptions: Record<string, unknown>[] = []
  const group = {
    openEditor(input: IEditorInput, options?: Record<string, unknown>) {
      opened.push(input)
      openOptions.push(options ?? {})
    },
  }
  const service = {
    activeGroup: group,
    activeGroupForOpen: group,
    openTargetGroup: group,
    activateGroup() {},
  } as unknown as IEditorGroupsService
  return { service, opened, openOptions }
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
    const input = groups.opened[0]!
    expect(input).toBeInstanceOf(ReleaseNotesInput)
    expect(versions(input)).toEqual(['0.1.3'])
    expect((input as ReleaseNotesInput).notes[0]?.body).toContain('- C')
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
    const input = groups.opened[0]!
    expect(input).toBeInstanceOf(ReleaseNotesInput)
    expect(versions(input)).toEqual(['0.1.3', '0.1.2'])
    expect(storage.read()).toBe('0.1.3')
  })

  it('opens the what’s-new tab without stealing the active editor', async () => {
    const storage = fakeStorage('0.1.1')
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.1.3'),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    // A background open must not displace the editor the user is working in —
    // a file opened right after restore would otherwise never mount its model
    // and its extension host `onLanguage:` activation would never fire.
    expect(groups.openOptions[0]?.activate).toBe(false)
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

  it('never shows a version newer than the running app', async () => {
    const storage = fakeStorage('0.1.1')
    const groups = fakeGroups()
    const withFuture: IReleaseNote[] = [
      { version: '0.2.0', title: '', summary: '', body: '## 未来\n' },
      ...NOTES,
    ]
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.1.3', withFuture),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    // A shipped file can carry newer versions; this install can't vouch for them.
    expect(versions(groups.opened[0]!)).toEqual(['0.1.3', '0.1.2'])
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

  it('shows the only known note once for an existing install with no version marker', async () => {
    const storage = fakeStorage({ [EXISTING_INSTALL_MARKER_KEY]: [{ id: 1 }] })
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.1.3', [NOTES[0]!]),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(versions(groups.opened[0]!)).toEqual(['0.1.3'])
    expect(storage.read()).toBe('0.1.3')
  })
})

// A patch never gets its own runtime entry — the compiler merges its fixes into the
// main note it belongs to (headed `## vX.Y.Z 补丁修复`), so a merged body is still one
// runtime note at the main version.
const MERGED_NOTES: IReleaseNote[] = [
  {
    version: '0.15.1',
    date: '2026-10-12',
    title: '主稿',
    summary: '摘要',
    body: '## 本次重点\n\n- 主稿内容\n\n## v0.15.2 补丁修复\n\n- 修好了 X\n',
  },
]

describe('ReleaseNotesContribution — merged patches', () => {
  it('does not pop for a patch-only upgrade under a seen main note, but records the version', async () => {
    const storage = fakeStorage('0.15.1')
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.15.3', MERGED_NOTES),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(0)
    expect(storage.read()).toBe('0.15.3')
  })

  it('shows the unseen main note — merged patch section included — when crossing series', async () => {
    const storage = fakeStorage('0.14.9')
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.15.3', MERGED_NOTES),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(1)
    const input = groups.opened[0]!
    expect(versions(input)).toEqual(['0.15.1'])
    expect((input as ReleaseNotesInput).notes[0]?.body).toContain('## v0.15.2 补丁修复')
    expect((input as ReleaseNotesInput).notes[0]?.body).toContain('修好了 X')
  })

  it('records silently on first install of a patch build', async () => {
    const storage = fakeStorage(undefined)
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.15.2', MERGED_NOTES),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(groups.opened).toHaveLength(0)
    expect(storage.read()).toBe('0.15.2')
  })

  it('shows the latest main draft once for an old install (marker, no lastVersion) that lands on a patch', async () => {
    const storage = fakeStorage({ [EXISTING_INSTALL_MARKER_KEY]: [{ id: 1 }] })
    const groups = fakeGroups()
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.15.2', MERGED_NOTES),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    // 旧版未知：按「最新主稿的前一篇（或 0.0.0）」作基线，range 命中最新主稿一次；
    // 若按当前补丁找前一篇会解析回 0.15.1，range 落空，来自更老系列的用户反而什么都看不到。
    expect(groups.opened).toHaveLength(1)
    const input = groups.opened[0]!
    expect(versions(input)).toEqual(['0.15.1'])
    expect((input as ReleaseNotesInput).notes[0]?.body).toContain('## v0.15.2 补丁修复')
    expect(storage.read()).toBe('0.15.2')
  })

  it('uses the previous main draft as the baseline so only the newest main note shows', async () => {
    const storage = fakeStorage({ [EXISTING_INSTALL_MARKER_KEY]: [{ id: 1 }] })
    const groups = fakeGroups()
    const notes: IReleaseNote[] = [
      {
        version: '0.15.1',
        title: '主稿',
        summary: '摘要',
        body: '## 本次重点\n\n- 主稿内容\n',
      },
      { version: '0.15.0', title: '', summary: '', body: '## 上一稿\n\n- 旧内容\n' },
    ]
    const contrib = new ReleaseNotesContribution(
      fakeReleaseNotes('0.15.3', notes),
      storage.service,
      groups.service,
    )
    await contrib.whenReady
    expect(versions(groups.opened[0]!)).toEqual(['0.15.1'])
    expect(storage.read()).toBe('0.15.3')
  })
})
