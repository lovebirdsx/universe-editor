/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  openSwarmFileDiff — the shared entry both the review detail editor and the
 *  Swarm Changes sidebar open diffs through. Guards the two semantics that must
 *  never drift between them: immutable-both-sides tab reuse, and preview/pin
 *  open options.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { NullLogger, observableValue, type IEditorInput } from '@universe-editor/platform'
import type { SwarmReviewFileDto } from '@universe-editor/extensions-common'
import { swarmDiffEditorId } from '../../editor/SwarmDiffEditorInput.js'
import { openSwarmFileDiff, type OpenSwarmFileDiffRequest } from '../openSwarmFileDiff.js'

const FILE: SwarmReviewFileDto = {
  status: 'M',
  path: 'src/editor/a.ts',
  depotFile: '//depot/branch_x/src/editor/a.ts',
  baseRevision: '3',
  localPath: 'X:/p4ws/main/src/editor/a.ts',
}

/** The Swarm Changes view's comparison: latest archive shelf vs the depot base —
 *  both sides immutable, which is what unlocks the tab-reuse fast path. */
const REQUEST: OpenSwarmFileDiffRequest = {
  reviewId: '1001',
  file: FILE,
  rightChange: '2999',
  rightRev: 2,
  leftChange: null,
  leftVersion: 0,
  rightImmutable: true,
  leftImmutable: false,
}

function createDeps(
  openEditors: readonly IEditorInput[] = [],
  content: { content: string; error?: string } = { content: 'text' },
) {
  const executeCommand = vi.fn(async () => content)
  const openEditor = vi.fn()
  const createInstance = vi.fn(() => ({ id: 'created' }) as unknown as IEditorInput)
  return {
    executeCommand,
    openEditor,
    createInstance,
    deps: {
      commands: { _serviceBrand: undefined, executeCommand } as never,
      editorService: {
        _serviceBrand: undefined,
        openEditor,
        openEditors: observableValue<readonly IEditorInput[]>('test.openEditors', openEditors),
      } as never,
      inst: { _serviceBrand: undefined, createInstance } as never,
      logger: new NullLogger(),
      notifications: { _serviceBrand: undefined, notify: vi.fn() } as never,
      onError: vi.fn(),
    },
  }
}

describe('openSwarmFileDiff', () => {
  it('reuses an open tab without re-fetching when both sides are immutable', async () => {
    const id = swarmDiffEditorId({
      reviewId: '1001',
      depotFile: FILE.depotFile,
      displayPath: FILE.path,
      localPath: FILE.localPath,
      leftVersion: 0,
      rightVersion: 2,
      leftChange: null,
      rightChange: '2999',
    })
    const existing = { id } as unknown as IEditorInput
    const { executeCommand, openEditor, createInstance, deps } = createDeps([existing])

    await openSwarmFileDiff(REQUEST, deps)

    expect(openEditor).toHaveBeenCalledWith(existing, { pinned: true })
    expect(executeCommand).not.toHaveBeenCalled()
    expect(createInstance).not.toHaveBeenCalled()
  })

  it('opens the reused tab into the preview slot without stealing focus', async () => {
    const id = swarmDiffEditorId({
      reviewId: '1001',
      depotFile: FILE.depotFile,
      displayPath: FILE.path,
      localPath: FILE.localPath,
      leftVersion: 0,
      rightVersion: 2,
      leftChange: null,
      rightChange: '2999',
    })
    const existing = { id } as unknown as IEditorInput
    const { openEditor, deps } = createDeps([existing])

    await openSwarmFileDiff({ ...REQUEST, preview: true }, deps)

    expect(openEditor).toHaveBeenCalledWith(existing, { pinned: false, preserveFocus: true })
  })

  it('fetches both sides and honors the preview flag on a fresh diff', async () => {
    const { executeCommand, openEditor, createInstance, deps } = createDeps()

    await openSwarmFileDiff({ ...REQUEST, preview: true }, deps)

    // Left is the depot base (`#3`), right the immutable archive shelf.
    expect(executeCommand.mock.calls.map((c) => (c as unknown as [string, unknown])[1])).toEqual([
      { depotFile: FILE.depotFile, revision: '#3' },
      { depotFile: FILE.depotFile, revision: '@=2999', immutable: true },
    ])
    expect(createInstance).toHaveBeenCalled()
    expect(openEditor.mock.calls[0]?.[1]).toEqual({ pinned: false, preserveFocus: true })
  })

  it('surfaces a fetch failure through onError instead of opening an empty diff', async () => {
    const { openEditor, deps } = createDeps([], { content: '', error: 'p4 print failed' })

    await openSwarmFileDiff(REQUEST, deps)

    expect(deps.onError).toHaveBeenCalledWith('p4 print failed')
    expect(openEditor).not.toHaveBeenCalled()
  })
})
