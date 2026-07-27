/*---------------------------------------------------------------------------------------------
 *  Tests for DiffLiveContentSyncContribution — a working-tree diff's modified
 *  side mirrors the file's live model, but a snapshot diff (a git-commit or
 *  depot-revision comparison) must NOT be clobbered with the working-tree
 *  content just because the file happens to have an open model.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupModelChangeEvent,
  type IEditorGroupsService,
  URI,
} from '@universe-editor/platform'

interface FakeModel {
  value: string
  getValue(): string
  isDisposed(): boolean
  onDidChangeContent: import('@universe-editor/platform').Event<void>
  set(v: string): void
}

const liveModels = new Map<string, FakeModel>()
const addModelEmitter = new Emitter<void>()

vi.mock('../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: {
    peek: (uri: { toString: () => string }) => liveModels.get(uri.toString()),
    onDidAddModel: (listener: () => void) => addModelEmitter.event(listener),
  },
}))

import { DiffLiveContentSyncContribution } from '../DiffLiveContentSyncContribution.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'

function makeModel(initial: string): FakeModel {
  const emitter = new Emitter<void>()
  const model: FakeModel = {
    value: initial,
    getValue: () => model.value,
    isDisposed: () => false,
    onDidChangeContent: emitter.event,
    set(v: string) {
      model.value = v
      emitter.fire()
    },
  }
  return model
}

function makeGroups(editors: EditorInput[]): IEditorGroupsService & {
  openEditor(editor: EditorInput): void
} {
  const modelEmitter = new Emitter<IEditorGroupModelChangeEvent>()
  const addGroupEmitter = new Emitter<IEditorGroup>()
  const removeGroupEmitter = new Emitter<IEditorGroup>()
  const group = {
    id: 1,
    editors,
    onDidChangeModel: modelEmitter.event,
  } as unknown as IEditorGroup
  return {
    groups: [group],
    onDidAddGroup: addGroupEmitter.event,
    onDidRemoveGroup: removeGroupEmitter.event,
    openEditor(editor: EditorInput) {
      editors.push(editor)
      modelEmitter.fire({ kind: 'open', editor })
    },
  } as unknown as IEditorGroupsService & { openEditor(editor: EditorInput): void }
}

describe('DiffLiveContentSyncContribution', () => {
  it('mirrors the live model into a working-tree diff (liveModified)', () => {
    const uri = URI.file('/ws/a.txt')
    liveModels.set(uri.toString(), makeModel('working'))
    const diff = new DiffEditorInput(uri, 'head', 'stale', undefined, undefined, true)
    const groups = makeGroups([diff])
    const contribution = new DiffLiveContentSyncContribution(groups)

    expect(diff.modifiedContent).toBe('working')

    liveModels.get(uri.toString())!.set('edited')
    expect(diff.modifiedContent).toBe('edited')
    expect(diff.originalContent).toBe('head')

    contribution.dispose()
    liveModels.clear()
  })

  it('picks up a working-tree diff whose model appears after the diff opened', () => {
    const uri = URI.file('/ws/a.txt')
    const diff = new DiffEditorInput(uri, 'head', 'stale', undefined, undefined, true)
    const groups = makeGroups([diff])
    const contribution = new DiffLiveContentSyncContribution(groups)

    expect(diff.modifiedContent).toBe('stale') // no model yet — untouched
    liveModels.set(uri.toString(), makeModel('working'))
    addModelEmitter.fire()
    expect(diff.modifiedContent).toBe('working')

    contribution.dispose()
    liveModels.clear()
  })

  // Regression (git graph): opening a commit's file diff mounts a DiffEditorInput
  // keyed by the file URI. The file also being open in an editor means a shared
  // model exists — the initial sync then overwrote the right (commit) side with
  // the working-tree text, so the diff always showed the latest file version.
  it('never touches a snapshot diff (commit-to-commit), even with a live model', () => {
    const uri = URI.file('/ws/a.txt')
    liveModels.set(uri.toString(), makeModel('working'))
    const diff = new DiffEditorInput(uri, 'parent-blob', 'commit-blob')
    const groups = makeGroups([diff])
    const contribution = new DiffLiveContentSyncContribution(groups)

    expect(diff.modifiedContent).toBe('commit-blob')

    liveModels.get(uri.toString())!.set('edited')
    expect(diff.modifiedContent).toBe('commit-blob')

    contribution.dispose()
    liveModels.clear()
  })

  // Re-opening the same file as a different diff kind reuses the tab
  // (OpenDiffAction): the flag must flip with the new payload so a working-tree
  // diff promoted over a snapshot tab (or vice versa) syncs correctly.
  it('adopts the liveModified flag when content is refreshed with one', () => {
    const uri = URI.file('/ws/a.txt')
    const diff = new DiffEditorInput(uri, 'parent-blob', 'commit-blob')
    diff.update('head', 'working', true)
    expect(diff.liveModified).toBe(true)
    expect(diff.modifiedContent).toBe('working')

    diff.update('head', 'working') // no flag → keeps current mode
    expect(diff.liveModified).toBe(true)

    diff.update('parent-blob', 'commit-blob', false)
    expect(diff.liveModified).toBe(false)
  })
})
