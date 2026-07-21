/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupView body drop-zone behaviour (VSCode-style split-on-drop).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import {
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  GroupDirection,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IDisposable,
  type IEditorInput,
} from '@universe-editor/platform'
import { DragSessionProvider } from '@universe-editor/workbench-ui'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { EditorGroupView, detectBodyDropZone } from '../EditorGroupView.js'
import { ServicesContext } from '../../useService.js'

const TYPE_ID = 'body-drop-test'
const COMPONENT_KEY = 'bodyDropEditor'

class BodyDropInput extends EditorInput {
  constructor(
    private readonly _name: string,
    private readonly _uri: URI,
  ) {
    super()
  }
  get typeId() {
    return TYPE_ID
  }
  get resource() {
    return this._uri
  }
  getName() {
    return this._name
  }
}

const FakeEditor: ComponentType<{ input: IEditorInput }> = ({ input }) => (
  <div data-testid="active-editor">{input.label}</div>
)
const componentMap = new Map([[COMPONENT_KEY, FakeEditor]])

function makeInstantiation(): InstantiationService {
  const sc = new ServiceCollection()
  sc.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: () => Promise.resolve({ confirmed: false, choice: 'cancel' as const }),
    prompt: () => Promise.resolve(undefined),
  } as IDialogService)
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  } as ICommandService)
  sc.set(IContextKeyService, new ContextKeyService())
  return new InstantiationService(sc)
}

function renderTwoGroups(svc: EditorGroupsService) {
  const inst = makeInstantiation()
  const result = render(
    <ServicesContext.Provider value={inst}>
      <DragSessionProvider>
        {svc.groups.map((g) => (
          <div key={g.id} data-testid={`group-wrapper-${g.id}`}>
            <EditorGroupView
              group={g}
              groupsService={svc}
              resolveComponent={(k) => componentMap.get(k)}
            />
          </div>
        ))}
      </DragSessionProvider>
    </ServicesContext.Provider>,
  )
  return result
}

/** Fire a drag event with clientX/clientY set — happy-dom ignores those in init dicts. */
function fireDragWithCoords(
  type: 'dragOver' | 'drop' | 'dragLeave',
  target: HTMLElement,
  coords: { clientX?: number; clientY?: number; relatedTarget?: EventTarget | null } = {},
): void {
  const event = createEvent[type](target)
  if (coords.clientX !== undefined)
    Object.defineProperty(event, 'clientX', { value: coords.clientX })
  if (coords.clientY !== undefined)
    Object.defineProperty(event, 'clientY', { value: coords.clientY })
  if (coords.relatedTarget !== undefined)
    Object.defineProperty(event, 'relatedTarget', { value: coords.relatedTarget })
  fireEvent(target, event)
}

/** Stub getBoundingClientRect for the body element so detectBodyDropZone has real geometry. */
function stubBodyRect(group: { id: number }, rect: DOMRect) {
  const root = screen.getByTestId(`group-wrapper-${group.id}`)
  const body = root.querySelector<HTMLElement>('[data-testid="editor-group-body"]')
  if (!body) throw new Error('body element not found')
  body.getBoundingClientRect = () => rect
  return body
}

let providerDisposable: IDisposable

beforeEach(() => {
  providerDisposable = EditorRegistry.registerEditorProvider({
    typeId: TYPE_ID,
    componentKey: COMPONENT_KEY,
  })
})

afterEach(() => {
  providerDisposable.dispose()
  vi.restoreAllMocks()
})

describe('detectBodyDropZone', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 }
  it('returns "center" inside the central 60% region', () => {
    expect(detectBodyDropZone(rect, 50, 50)).toBe('center')
    expect(detectBodyDropZone(rect, 25, 25)).toBe('center') // edge of band
  })
  it('returns "left" near the left edge', () => {
    expect(detectBodyDropZone(rect, 5, 50)).toBe('left')
  })
  it('returns "right" near the right edge', () => {
    expect(detectBodyDropZone(rect, 95, 50)).toBe('right')
  })
  it('returns "top" near the top edge', () => {
    expect(detectBodyDropZone(rect, 50, 5)).toBe('top')
  })
  it('returns "bottom" near the bottom edge', () => {
    expect(detectBodyDropZone(rect, 50, 95)).toBe('bottom')
  })
  it('returns "center" for a degenerate (zero-area) rect instead of NaN-driven edge', () => {
    // Observed transiently on headless CI right after a split: the body has not
    // been laid out yet and getBoundingClientRect reports 0 width/height. A
    // center drop must move the editor, not split into a new group.
    expect(detectBodyDropZone({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe('center')
    expect(detectBodyDropZone({ left: 10, top: 20, width: 0, height: 100 }, 10, 70)).toBe('center')
    expect(detectBodyDropZone({ left: 10, top: 20, width: 100, height: 0 }, 60, 20)).toBe('center')
  })
})

describe('EditorGroupView body drop', () => {
  it('dropping on the right edge of a cross-group target creates a new group via addGroup(Right) and moves the editor', () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const b = new BodyDropInput('B', URI.file('/b.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)
    const groupB = svc.addGroup(groupA, GroupDirection.Right)
    groupB.openEditor(b)
    expect(svc.groups.length).toBe(2)

    renderTwoGroups(svc)
    const bodyB = stubBodyRect(groupB, { left: 200, top: 0, width: 100, height: 100 } as DOMRect)

    const addGroupSpy = vi.spyOn(svc, 'addGroup')
    const moveEditorSpy = vi.spyOn(svc, 'moveEditor')

    // Drag tab A from group A's tab bar
    const groupAWrapper = screen.getByTestId(`group-wrapper-${groupA.id}`)
    const tabA = within(groupAWrapper).getByRole('tab')
    fireEvent.dragStart(tabA)

    // Hover then drop near the right edge of group B (clientX in last 20% of width)
    fireDragWithCoords('dragOver', bodyB, { clientX: 290, clientY: 50 })
    fireDragWithCoords('drop', bodyB, { clientX: 290, clientY: 50 })

    expect(addGroupSpy).toHaveBeenCalledWith(groupB, GroupDirection.Right)
    expect(moveEditorSpy).toHaveBeenCalled()
    // The newly created group should contain editor A
    const newGroup = svc.groups[svc.groups.length - 1]!
    expect(newGroup.editors).toContain(a)
    svc.dispose()
  })

  it('dropping on the center of a different group moves the editor into that group (no new group)', () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const b = new BodyDropInput('B', URI.file('/b.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)
    const groupB = svc.addGroup(groupA, GroupDirection.Right)
    groupB.openEditor(b)

    renderTwoGroups(svc)
    const bodyB = stubBodyRect(groupB, { left: 200, top: 0, width: 100, height: 100 } as DOMRect)

    const addGroupSpy = vi.spyOn(svc, 'addGroup')

    const groupAWrapper = screen.getByTestId(`group-wrapper-${groupA.id}`)
    const tabA = within(groupAWrapper).getByRole('tab')
    fireEvent.dragStart(tabA)
    fireDragWithCoords('dragOver', bodyB, { clientX: 250, clientY: 50 }) // center
    fireDragWithCoords('drop', bodyB, { clientX: 250, clientY: 50 })

    expect(addGroupSpy).not.toHaveBeenCalled()
    expect(groupB.editors).toContain(a)
    // Empty source group is auto-removed via the EditorGroupsService watcher.
    // Either way, no *new* group was added.
    svc.dispose()
  })

  it("splitting a group's only editor onto an edge clones it into a new group", () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)

    renderTwoGroups(svc)
    const bodyA = stubBodyRect(groupA, { left: 0, top: 0, width: 100, height: 100 } as DOMRect)

    const addGroupSpy = vi.spyOn(svc, 'addGroup')
    const copyEditorSpy = vi.spyOn(svc, 'copyEditor')
    const moveEditorSpy = vi.spyOn(svc, 'moveEditor')

    const tabA = within(screen.getByTestId(`group-wrapper-${groupA.id}`)).getByRole('tab')
    fireEvent.dragStart(tabA)
    fireDragWithCoords('dragOver', bodyA, { clientX: 5, clientY: 50 }) // left edge
    fireDragWithCoords('drop', bodyA, { clientX: 5, clientY: 50 })

    // A plain move would empty (and auto-remove) the source — split must clone.
    expect(addGroupSpy).toHaveBeenCalledWith(groupA, GroupDirection.Left)
    expect(copyEditorSpy).toHaveBeenCalled()
    expect(moveEditorSpy).not.toHaveBeenCalled()
    expect(svc.groups.length).toBe(2)
    // Both groups stay populated.
    expect(groupA.editors).toContain(a)
    expect(svc.groups[svc.groups.length - 1]!.editors.length).toBe(1)
    svc.dispose()
  })

  it("dropping a group's only editor on its own center is a no-op", () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)

    renderTwoGroups(svc)
    const bodyA = stubBodyRect(groupA, { left: 0, top: 0, width: 100, height: 100 } as DOMRect)

    const addGroupSpy = vi.spyOn(svc, 'addGroup')
    const moveEditorSpy = vi.spyOn(svc, 'moveEditor')
    const copyEditorSpy = vi.spyOn(svc, 'copyEditor')

    const tabA = within(screen.getByTestId(`group-wrapper-${groupA.id}`)).getByRole('tab')
    fireEvent.dragStart(tabA)
    fireDragWithCoords('dragOver', bodyA, { clientX: 50, clientY: 50 }) // center
    fireDragWithCoords('drop', bodyA, { clientX: 50, clientY: 50 })

    expect(addGroupSpy).not.toHaveBeenCalled()
    expect(moveEditorSpy).not.toHaveBeenCalled()
    expect(copyEditorSpy).not.toHaveBeenCalled()
    expect(svc.groups.length).toBe(1)
    svc.dispose()
  })

  it('dragging over an edge shows the overlay; leaving hides it', () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const b = new BodyDropInput('B', URI.file('/b.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)
    const groupB = svc.addGroup(groupA, GroupDirection.Right)
    groupB.openEditor(b)

    renderTwoGroups(svc)
    const bodyB = stubBodyRect(groupB, { left: 200, top: 0, width: 100, height: 100 } as DOMRect)

    const tabA = within(screen.getByTestId(`group-wrapper-${groupA.id}`)).getByRole('tab')
    fireEvent.dragStart(tabA)

    fireDragWithCoords('dragOver', bodyB, { clientX: 290, clientY: 50 })
    expect(screen.getByTestId('editor-group-drop-overlay').getAttribute('data-zone')).toBe('right')

    fireDragWithCoords('dragOver', bodyB, { clientX: 250, clientY: 50 })
    expect(screen.getByTestId('editor-group-drop-overlay').getAttribute('data-zone')).toBe('center')

    fireDragWithCoords('dragLeave', bodyB, { relatedTarget: null })
    expect(screen.queryByTestId('editor-group-drop-overlay')).toBeNull()
    svc.dispose()
  })

  it('single-editor self-drag shows the edge split preview but suppresses center', () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)

    renderTwoGroups(svc)
    const bodyA = stubBodyRect(groupA, { left: 0, top: 0, width: 100, height: 100 } as DOMRect)

    const tabA = within(screen.getByTestId(`group-wrapper-${groupA.id}`)).getByRole('tab')
    fireEvent.dragStart(tabA)

    fireDragWithCoords('dragOver', bodyA, { clientX: 5, clientY: 50 }) // left edge
    expect(screen.getByTestId('editor-group-drop-overlay').getAttribute('data-zone')).toBe('left')

    fireDragWithCoords('dragOver', bodyA, { clientX: 50, clientY: 50 }) // center
    expect(screen.queryByTestId('editor-group-drop-overlay')).toBeNull()
    svc.dispose()
  })

  // Regression (drag-and-drop-context): a full-screen session hosts the prompt
  // input inside the body. Dragging a resource over that input must NOT leave the
  // body's "open here" overlay glowing — the input owns the drop there.
  it('suppresses the body overlay while a resource drag is over the prompt input host', () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)

    renderTwoGroups(svc)
    const bodyA = stubBodyRect(groupA, { left: 0, top: 0, width: 100, height: 100 } as DOMRect)

    // Plant a prompt-input drop host inside the body (as AcpSessionEditor would).
    const promptHost = document.createElement('div')
    promptHost.setAttribute('data-testid', 'acp-prompt-drop-host')
    bodyA.appendChild(promptHost)

    // A resource drag over the chat area lights the "center" overlay…
    const dt = new DataTransfer()
    dt.setData('text/uri-list', 'file:///x/a.txt')
    const over = createEvent.dragOver(bodyA, { dataTransfer: dt })
    Object.defineProperty(over, 'clientX', { value: 50 })
    Object.defineProperty(over, 'clientY', { value: 50 })
    fireEvent(bodyA, over)
    expect(screen.getByTestId('editor-group-drop-overlay').getAttribute('data-zone')).toBe('center')

    // …then the pointer moves onto the prompt host. The dragover bubbles to the
    // body handler, which must recognise the host target and drop the overlay.
    const overHost = createEvent.dragOver(promptHost, { dataTransfer: dt })
    Object.defineProperty(overHost, 'clientX', { value: 50 })
    Object.defineProperty(overHost, 'clientY', { value: 90 })
    fireEvent(promptHost, overHost)
    expect(screen.queryByTestId('editor-group-drop-overlay')).toBeNull()
    svc.dispose()
  })

  // Regression (drag-and-drop-context): if the gesture ends without a drop/leave
  // on the body (drop consumed by the nested prompt input which stopPropagation()s
  // it, or an Esc-cancel), only a window-level `dragend` fires. The overlay must
  // still clear rather than lingering until the next drag.
  it('clears a stuck body overlay on a window-level dragend', () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const b = new BodyDropInput('B', URI.file('/b.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)
    const groupB = svc.addGroup(groupA, GroupDirection.Right)
    groupB.openEditor(b)

    renderTwoGroups(svc)
    const bodyB = stubBodyRect(groupB, { left: 200, top: 0, width: 100, height: 100 } as DOMRect)

    const tabA = within(screen.getByTestId(`group-wrapper-${groupA.id}`)).getByRole('tab')
    fireEvent.dragStart(tabA)
    fireDragWithCoords('dragOver', bodyB, { clientX: 290, clientY: 50 }) // right edge → overlay
    expect(screen.getByTestId('editor-group-drop-overlay')).toBeTruthy()

    // No drop/leave reaches the body; the browser fires a window `dragend`.
    fireEvent(window, createEvent.dragEnd(window))
    expect(screen.queryByTestId('editor-group-drop-overlay')).toBeNull()
    svc.dispose()
  })
})
