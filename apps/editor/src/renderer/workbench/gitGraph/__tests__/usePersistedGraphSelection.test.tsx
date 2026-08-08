/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  usePersistedGraphSelection — the focused commit is written per repository
 *  (single selections only; a deselect clears the repo's entry; a compare
 *  selection and the synthetic uncommitted/pending row are never persisted),
 *  and a fresh session reveals the stored commit again once the first page and
 *  the repo resolution land. Cached sessions (tab remount) never restore.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import {
  Event,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  StorageScope,
  observableValue,
  type ISettableObservable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { usePersistedGraphSelection } from '../usePersistedGraphSelection.js'

const KEY = 'gitGraph.lastSelectedCommit'
const EXCLUDED = ['*']
const REPO = 'R:/repo'

interface HarnessProps {
  readonly selection: readonly string[]
  readonly effectiveRepo: string | null
  readonly result: unknown
  readonly pendingReveal: ISettableObservable<string | null>
}

function Harness(props: HarnessProps) {
  usePersistedGraphSelection({ storageKey: KEY, excludedIds: EXCLUDED, ...props })
  return null
}

function setup(stored: Record<string, string> | undefined, initial: Partial<HarnessProps> = {}) {
  const get = vi.fn().mockResolvedValue(stored)
  const set = vi.fn().mockResolvedValue(undefined)
  const services = new ServiceCollection()
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get,
    set,
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: Event.None,
  } as unknown as IStorageService)
  const instantiation = new InstantiationService(services)
  const pendingReveal = observableValue<string | null>('test.pendingReveal', null)
  const base: HarnessProps = {
    selection: [],
    effectiveRepo: null,
    result: null,
    pendingReveal,
    ...initial,
  }
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <Harness {...base} />
    </ServicesContext.Provider>,
  )
  const update = (overrides: Partial<HarnessProps>) =>
    utils.rerender(
      <ServicesContext.Provider value={instantiation}>
        <Harness {...base} {...overrides} />
      </ServicesContext.Provider>,
    )
  return { get, set, pendingReveal, update }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('usePersistedGraphSelection restore', () => {
  it('reveals the stored commit once the first page and the repo resolution land', async () => {
    const { pendingReveal, update } = setup({ [REPO]: 'hash1' })
    await flush()
    expect(pendingReveal.get()).toBeNull()

    // First page in, repo unresolved yet: keep waiting.
    update({ result: { commits: [] } })
    await flush()
    expect(pendingReveal.get()).toBeNull()

    update({ result: { commits: [] }, effectiveRepo: REPO })
    await flush()
    expect(pendingReveal.get()).toBe('hash1')
  })

  it('ignores entries stored for a different repo', async () => {
    const { pendingReveal, update } = setup({ 'R:/other': 'hash1' })
    update({ result: { commits: [] }, effectiveRepo: REPO })
    await flush()
    expect(pendingReveal.get()).toBeNull()
  })

  it('never restores in a cached session (result present at mount)', async () => {
    const { pendingReveal, update } = setup({ [REPO]: 'hash1' }, { result: { commits: [] } })
    await flush()
    update({ effectiveRepo: REPO })
    await flush()
    expect(pendingReveal.get()).toBeNull()
  })

  it('a selection made during the load wins over the restore', async () => {
    const { pendingReveal, update } = setup({ [REPO]: 'hash1' })
    update({ selection: ['userpicked'] })
    await flush()
    update({ selection: ['userpicked'], result: { commits: [] }, effectiveRepo: REPO })
    await flush()
    expect(pendingReveal.get()).toBeNull()
  })
})

describe('usePersistedGraphSelection write-back', () => {
  it('persists a single selection merged onto the stored map', async () => {
    const { set, update } = setup({ 'R:/other': 'keep' })
    update({ result: { commits: [] }, effectiveRepo: REPO })
    await flush()
    update({ result: { commits: [] }, effectiveRepo: REPO, selection: ['h1'] })
    await flush()
    expect(set).toHaveBeenCalledWith(
      KEY,
      { 'R:/other': 'keep', [REPO]: 'h1' },
      StorageScope.WORKSPACE,
    )
  })

  it('clears only the current repo entry on deselect', async () => {
    const { set, update } = setup({ 'R:/other': 'keep', [REPO]: 'h1' })
    update({ result: { commits: [] }, effectiveRepo: REPO, selection: ['h1'] })
    await flush()
    update({ result: { commits: [] }, effectiveRepo: REPO, selection: [] })
    await flush()
    expect(set).toHaveBeenLastCalledWith(KEY, { 'R:/other': 'keep' }, StorageScope.WORKSPACE)
  })

  it('leaves the persisted focus untouched for a compare selection', async () => {
    const { set, update } = setup({})
    update({ result: { commits: [] }, effectiveRepo: REPO })
    await flush()
    update({ result: { commits: [] }, effectiveRepo: REPO, selection: ['a', 'b'] })
    await flush()
    expect(set).not.toHaveBeenCalled()
  })

  it('never persists the synthetic uncommitted/pending row', async () => {
    const { set, update } = setup({})
    update({ result: { commits: [] }, effectiveRepo: REPO, selection: ['*'] })
    await flush()
    expect(set).not.toHaveBeenCalled()
  })

  it('does not write before the storage read settles', async () => {
    const { set, update } = setup(undefined)
    // Selection arrives in the same tick as the mount, before get() resolves.
    update({ result: { commits: [] }, effectiveRepo: REPO, selection: ['h1'] })
    expect(set).not.toHaveBeenCalled()
    await flush()
    // After the read settled, the next selection change writes.
    update({ result: { commits: [] }, effectiveRepo: REPO, selection: ['h2'] })
    await flush()
    expect(set).toHaveBeenCalledWith(KEY, { [REPO]: 'h2' }, StorageScope.WORKSPACE)
  })
})
