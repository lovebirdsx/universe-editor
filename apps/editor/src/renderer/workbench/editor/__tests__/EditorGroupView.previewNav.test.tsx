/*---------------------------------------------------------------------------------------------
 *  Repro for: navigating between markdown previews via an in-place tab replace
 *  (link click / Alt+←) must REMOUNT the editor component, not reuse the same
 *  instance with a new `input` prop. Instance reuse leaves the old scroll
 *  position in place and breaks the preview's title-bar actions (find / open
 *  source), which register against the live DOM on mount.
 *
 *  The fix is a React `key` on the rendered editor component keyed by the active
 *  editor's id, so swapping A→B in the same slot tears down A and mounts B.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, type ComponentType } from 'react'
import {
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IConfirmResult,
  type ICommandService as ICommandServiceType,
  type IDialogService as IDialogServiceType,
  type IEditorInput,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
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

class FakePreviewInput extends EditorInput {
  constructor(private readonly _src: string) {
    super()
  }
  get typeId() {
    return 'markdown.preview'
  }
  override get id() {
    return `markdown-preview:${this._src}`
  }
  get resource() {
    return URI.from({ scheme: 'markdown-preview', path: `/${this._src}` })
  }
  getName() {
    return `预览 ${this._src}`
  }
  get src() {
    return this._src
  }
}

// Records, per source, how many times the preview component mounted.
const mountsBySource = new Map<string, number>()

function ProbePreview({ input }: { input: IEditorInput }) {
  const src = (input as FakePreviewInput).src
  // Empty deps: this runs only on a real mount, not on a prop/input change of a
  // reused instance. That is exactly the distinction the fix is about.
  useEffect(() => {
    mountsBySource.set(src, (mountsBySource.get(src) ?? 0) + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div data-testid="probe-preview">{src}</div>
}

const componentMap = new Map<string, ComponentType<{ input: IEditorInput }>>([
  ['markdown.preview', ProbePreview],
])

afterEach(() => {
  cleanup()
  mountsBySource.clear()
})

describe('EditorGroupView — markdown preview in-place navigation', () => {
  it('remounts the editor component when one preview replaces another in the same slot', () => {
    EditorRegistry.registerEditorProvider({
      typeId: 'markdown.preview',
      componentKey: 'markdown.preview',
    })

    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const a = new FakePreviewInput('a.md')
    group.openEditor(a, { activate: true, pinned: true })

    renderWithServices(
      <EditorGroupView group={group} groupsService={svc} componentMap={componentMap as never} />,
    )
    expect(mountsBySource.get('a.md')).toBe(1)

    // Navigate in place: open B at A's slot, close A — exactly what link-click /
    // history navigation does for markdown previews.
    const b = new FakePreviewInput('b.md')
    const index = group.indexOf(a)
    act(() => {
      group.openEditor(b, { activate: true, pinned: true, index })
      group.closeEditor(a)
    })

    // B must have mounted as a fresh instance. Without a per-input React key the
    // component instance is reused, so this stays 0 and the bug reproduces.
    expect(mountsBySource.get('b.md')).toBe(1)
  })
})
