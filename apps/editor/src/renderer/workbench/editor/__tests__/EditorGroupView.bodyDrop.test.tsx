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
            <EditorGroupView group={g} groupsService={svc} componentMap={componentMap} />
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

  it("dropping a group's only editor back onto itself is a no-op", () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)

    renderTwoGroups(svc)
    const bodyA = stubBodyRect(groupA, { left: 0, top: 0, width: 100, height: 100 } as DOMRect)

    const addGroupSpy = vi.spyOn(svc, 'addGroup')
    const moveEditorSpy = vi.spyOn(svc, 'moveEditor')

    const tabA = within(screen.getByTestId(`group-wrapper-${groupA.id}`)).getByRole('tab')
    fireEvent.dragStart(tabA)
    fireDragWithCoords('dragOver', bodyA, { clientX: 5, clientY: 50 }) // left edge
    fireDragWithCoords('drop', bodyA, { clientX: 5, clientY: 50 })

    expect(addGroupSpy).not.toHaveBeenCalled()
    expect(moveEditorSpy).not.toHaveBeenCalled()
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

  it('dropping a single-editor source on its own body does not show overlay during dragOver', () => {
    const svc = new EditorGroupsService()
    const a = new BodyDropInput('A', URI.file('/a.txt'))
    const groupA = svc.activeGroup
    groupA.openEditor(a)

    renderTwoGroups(svc)
    const bodyA = stubBodyRect(groupA, { left: 0, top: 0, width: 100, height: 100 } as DOMRect)

    const tabA = within(screen.getByTestId(`group-wrapper-${groupA.id}`)).getByRole('tab')
    fireEvent.dragStart(tabA)
    fireDragWithCoords('dragOver', bodyA, { clientX: 5, clientY: 50 })

    expect(screen.queryByTestId('editor-group-drop-overlay')).toBeNull()
    svc.dispose()
  })
})
