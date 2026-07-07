import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  EditorInput,
  PartId,
  URI,
  observableValue,
  type IEditorGroup,
  type IEditorGroupsService,
  type ILayoutService,
} from '@universe-editor/platform'
import {
  EXPLORER_TREE_VIEW_ID,
  restoreWorkbenchFocus,
  syncTerminalFocusContext,
} from '../workbenchFocusRestorer.js'

class SelfFocusingInput extends EditorInput {
  constructor(private readonly _target: HTMLElement) {
    super()
  }

  override get typeId(): string {
    return 'test.selfFocus'
  }

  override get resource(): URI {
    return URI.from({ scheme: 'test', path: '/self-focus' })
  }

  override getName(): string {
    return 'Self Focus'
  }

  override focus(): boolean {
    this._target.focus()
    return true
  }
}

function makeGroup(id: number, activeEditor?: EditorInput): IEditorGroup {
  return {
    id,
    activeEditor,
  } as unknown as IEditorGroup
}

function makeGroupsService(
  activeGroup: IEditorGroup,
  groups: readonly IEditorGroup[] = [activeGroup],
): IEditorGroupsService {
  return {
    activeGroup,
    groups,
    activateGroup: vi.fn((group: IEditorGroup | number) =>
      typeof group === 'number'
        ? (groups.find((candidate) => candidate.id === group) ?? activeGroup)
        : group,
    ),
  } as unknown as IEditorGroupsService
}

function makeLayoutService() {
  const explorer = document.createElement('div')
  explorer.tabIndex = 0
  explorer.setAttribute('data-view-id', EXPLORER_TREE_VIEW_ID)
  document.body.appendChild(explorer)

  const focusView = vi.fn(async (viewId: string) => {
    if (viewId === EXPLORER_TREE_VIEW_ID) explorer.focus()
    return true
  })
  const focusPart = vi.fn(async (partId: PartId) => {
    const body = document.querySelector<HTMLElement>('[data-testid="editor-group-body"]')
    if (partId === PartId.EditorArea && body) {
      body.focus()
      return true
    }
    return false
  })
  const layout = {
    visible: observableValue('test.layout.visible', {
      [PartId.ActivityBar]: true,
      [PartId.SideBar]: true,
      [PartId.SecondarySideBar]: false,
      [PartId.EditorArea]: true,
      [PartId.Panel]: false,
      [PartId.StatusBar]: true,
    }),
    getVisible: (partId: PartId) => partId !== PartId.Panel,
    focusView,
    focusPart,
  } as unknown as ILayoutService

  return { layout, explorer, focusView, focusPart }
}

function focusTerminalHost(): HTMLElement {
  const panel = document.createElement('div')
  panel.setAttribute('data-testid', 'part-panel')
  const terminal = document.createElement('div')
  terminal.tabIndex = 0
  terminal.setAttribute('data-terminal-id', 't1')
  panel.appendChild(terminal)
  document.body.appendChild(panel)
  terminal.focus()
  return terminal
}

describe('restoreWorkbenchFocus', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focuses Explorer and clears stale terminalFocus when no editor is open', async () => {
    const context = new ContextKeyService()
    context.set('terminalFocus', true)
    const terminal = focusTerminalHost()
    const { layout, explorer, focusView } = makeLayoutService()

    expect(document.activeElement).toBe(terminal)

    const result = await restoreWorkbenchFocus(makeGroupsService(makeGroup(1)), layout, context)

    expect(result).toEqual({ target: 'explorer', ok: true })
    expect(focusView).toHaveBeenCalledWith(EXPLORER_TREE_VIEW_ID, { source: 'restore' })
    expect(document.activeElement).toBe(explorer)
    expect(context.get('terminalFocus')).toBe(false)
  })

  it('focuses the active editor instead of Explorer when one exists', async () => {
    const context = new ContextKeyService()
    context.set('terminalFocus', true)
    focusTerminalHost()
    const editorTarget = document.createElement('button')
    document.body.appendChild(editorTarget)
    const editor = new SelfFocusingInput(editorTarget)
    const group = makeGroup(7, editor)
    const { layout, focusView } = makeLayoutService()

    const result = await restoreWorkbenchFocus(makeGroupsService(group), layout, context)

    expect(result).toEqual({
      target: 'editor',
      ok: true,
      groupId: 7,
      editorId: editor.id,
    })
    expect(focusView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(editorTarget)
    expect(context.get('terminalFocus')).toBe(false)
  })
})

describe('syncTerminalFocusContext', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('does not keep terminalFocus true for a hidden panel terminal', () => {
    const context = new ContextKeyService()
    focusTerminalHost()

    const { layout } = makeLayoutService()
    syncTerminalFocusContext(context, layout)

    expect(context.get('terminalFocus')).toBe(false)
  })
})
