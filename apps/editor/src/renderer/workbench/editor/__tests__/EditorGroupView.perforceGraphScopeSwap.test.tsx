/*---------------------------------------------------------------------------------------------
 *  Repro for: two scoped Perforce Graph tabs (file history of A and of B) live in
 *  the same group, so activating one after the other swaps the `input` prop on
 *  the same slot. PerforceGraphEditor keeps its per-input state in `useState`
 *  initializers seeded from the input's view-state bucket — those only run on
 *  mount, so a reused instance would show A's changes under B's tab and then
 *  mirror A's result/selection into B's bucket.
 *
 *  The fix is the per-input React `key` in EditorGroupView, same as the markdown
 *  preview case.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, type ComponentType } from 'react'
import {
  ContextKeyService,
  EditorRegistry,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  type IConfirmResult,
  type ICommandService as ICommandServiceType,
  type IDialogService as IDialogServiceType,
  type IEditorInput,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { PerforceGraphEditorInput } from '../../../services/editor/PerforceGraphEditorInput.js'
import { ServicesContext } from '../../useService.js'

const stubDialog: IDialogServiceType = {
  _serviceBrand: undefined,
  confirm: async (): Promise<IConfirmResult> => ({ confirmed: true, choice: 'primary' }),
  prompt: async () => undefined,
}

const stubCommand: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand() {
    return undefined
  },
}

function renderWithServices(node: React.ReactNode) {
  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, new ContextKeyService())
  const inst = new InstantiationService(services)
  return render(<ServicesContext.Provider value={inst}>{node}</ServicesContext.Provider>)
}

// Records, per input id, how many times the graph component mounted.
const mountsByInputId = new Map<string, number>()

function ProbeGraph({ input }: { input: IEditorInput }) {
  const id = input.id
  // Empty deps: runs on a real mount only, not on a prop swap of a reused
  // instance — exactly the distinction the fix is about.
  useEffect(() => {
    mountsByInputId.set(id, (mountsByInputId.get(id) ?? 0) + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div data-testid="probe-graph">{id}</div>
}

const componentMap = new Map<string, ComponentType<{ input: IEditorInput }>>([
  [PerforceGraphEditorInput.TYPE_ID, ProbeGraph],
])

afterEach(() => {
  cleanup()
  mountsByInputId.clear()
})

describe('EditorGroupView — scoped Perforce Graph tabs in one group', () => {
  it('remounts the editor component when activating a differently scoped history tab', () => {
    EditorRegistry.registerEditorProvider({
      typeId: PerforceGraphEditorInput.TYPE_ID,
      componentKey: PerforceGraphEditorInput.TYPE_ID,
    })

    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const a = new PerforceGraphEditorInput({
      path: 'X:/p4ws/main/src/a.ts',
      isDirectory: false,
      label: 'a.ts',
    })
    const b = new PerforceGraphEditorInput({
      path: 'X:/p4ws/main/src/b.ts',
      isDirectory: false,
      label: 'b.ts',
    })
    group.openEditor(a, { activate: true, pinned: true })

    renderWithServices(
      <EditorGroupView
        group={group}
        groupsService={svc}
        resolveComponent={((k: string) => (componentMap as Map<string, unknown>).get(k)) as never}
      />,
    )
    expect(mountsByInputId.get(a.id)).toBe(1)

    // Second "View File History", this time on b.ts: a new tab that takes over
    // the slot while a.ts stays open.
    act(() => {
      group.openEditor(b, { activate: true, pinned: true })
    })

    // Without a per-input React key the instance is reused and B never mounts,
    // so it would render A's state under B's tab.
    expect(mountsByInputId.get(b.id)).toBe(1)
  })
})
