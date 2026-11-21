/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Generic Vim surface commands: active-surface resolution, count forwarding and
 *  the quiet no-op when focus is not inside a registered surface.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import {
  CommandsRegistry,
  InstantiationService,
  ServiceCollection,
  registerAction2,
  type Action2,
} from '@universe-editor/platform'
import {
  __resetVimSurfacesForTests,
  registerVimSurface,
  type IVimSurfaceActions,
} from '@universe-editor/workbench-ui'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../services/windows/workbenchDocuments.js'
import {
  ListActivateAction,
  ListActivatePreviewAction,
  ListCollapseAction,
  ListContextMenuAction,
  ListCopyAction,
  ListDeleteAction,
  ListExpandAction,
  ListFocusDownAction,
  ListFocusFirstAction,
  ListFocusLastAction,
  ListFocusLeftAction,
  ListFocusRightAction,
  ListFocusUpAction,
  ListPageDownAction,
  ListPageUpAction,
  ListScrollViewportDownAction,
  ListScrollViewportUpAction,
  ListToggleAction,
  SurfaceEscapeAction,
  SurfaceNextAction,
  SurfacePreviousAction,
} from '../vimSurfaceActions.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  __resetVimSurfacesForTests()
})

type ActionClass = { readonly ID: string; new (): Action2 }

function invoke(action: ActionClass, ...args: unknown[]): void {
  const registration = registerAction2(action)
  cleanups.push(() => registration.dispose())
  const instantiation = new InstantiationService(new ServiceCollection())
  instantiation.invokeFunction((accessor) => {
    const command = CommandsRegistry.getCommand(action.ID)
    expect(command).toBeDefined()
    command!.handler(accessor, ...args)
  })
}

function focusSurface(actions: IVimSurfaceActions): HTMLElement {
  const win = new Window()
  const doc = win.document as unknown as Document
  const element = doc.createElement('div')
  element.tabIndex = 0
  doc.body.appendChild(element)
  const documentRegistration = registerWorkbenchDocument(doc)
  setActiveWorkbenchDocument(doc)
  const surfaceRegistration = registerVimSurface(
    {
      id: 'tree-1',
      kind: 'list',
      focus: 'within',
      getElement: () => element,
      getSurfaceKey: () => 'list:tree-1',
      defaultMode: 'normal',
      actions,
    },
    doc,
  )
  cleanups.push(() => {
    surfaceRegistration.dispose()
    documentRegistration.dispose()
  })
  element.focus()
  return element
}

describe('Vim surface commands', () => {
  it('forwards every list/surface action with the default count', () => {
    const handlers = new Map<string, ReturnType<typeof vi.fn>>()
    const actions = new Proxy({} as IVimSurfaceActions, {
      get(_target, property: string) {
        let handler = handlers.get(property)
        if (handler === undefined) {
          handler = vi.fn()
          handlers.set(property, handler)
        }
        return handler
      },
    })
    focusSurface(actions)

    const cases: readonly [ActionClass, readonly unknown[]][] = [
      [ListFocusUpAction, ['move', 'up']],
      [ListFocusDownAction, ['move', 'down']],
      [ListFocusLeftAction, ['move', 'left']],
      [ListFocusRightAction, ['move', 'right']],
      [ListFocusFirstAction, ['first']],
      [ListFocusLastAction, ['last']],
      [ListPageUpAction, ['page', 'up']],
      [ListPageDownAction, ['page', 'down']],
      [ListScrollViewportUpAction, ['scrollViewport', 'up']],
      [ListScrollViewportDownAction, ['scrollViewport', 'down']],
      [ListExpandAction, ['expand']],
      [ListCollapseAction, ['collapse']],
      [ListToggleAction, ['toggle']],
      [ListActivateAction, ['activate']],
      [ListActivatePreviewAction, ['activate']],
      [ListContextMenuAction, ['contextMenu']],
      [ListCopyAction, ['copy']],
      [ListDeleteAction, ['remove']],
      [SurfaceNextAction, ['next']],
      [SurfacePreviousAction, ['previous']],
      [SurfaceEscapeAction, ['escape']],
    ]
    for (const [action] of cases) invoke(action, { count: 1 })
    const calls = new Map<string, number>()
    for (const [, expected] of cases) {
      const name = expected[0] as string
      calls.set(name, (calls.get(name) ?? 0) + 1)
    }
    expect(handlers.size).toBe(calls.size)
    for (const [name, count] of calls) {
      expect(handlers.get(name), name).toHaveBeenCalledTimes(count)
    }
    expect(handlers.get('move')).toHaveBeenCalledWith('up', 1)
    expect(handlers.get('move')).toHaveBeenCalledWith('down', 1)
    expect(handlers.get('move')).toHaveBeenCalledWith('left', 1)
    expect(handlers.get('move')).toHaveBeenCalledWith('right', 1)
  })

  it('forwards the command count from the dispatcher args', () => {
    const move = vi.fn()
    focusSurface({ move })
    invoke(ListFocusDownAction, { count: 3 })
    expect(move).toHaveBeenCalledWith('down', 3)
  })

  it('normalizes invalid counts to 1', () => {
    const move = vi.fn()
    focusSurface({ move })
    invoke(ListFocusDownAction, { count: 0 })
    invoke(ListFocusDownAction, { count: Number.NaN })
    invoke(ListFocusDownAction, { count: '2' })
    expect(move).toHaveBeenNthCalledWith(1, 'down', 1)
    expect(move).toHaveBeenNthCalledWith(2, 'down', 1)
    expect(move).toHaveBeenNthCalledWith(3, 'down', 1)
  })

  it('activates with preview false and preview with true', () => {
    const activate = vi.fn()
    focusSurface({ activate })
    invoke(ListActivateAction, { count: 2 })
    invoke(ListActivatePreviewAction)
    expect(activate).toHaveBeenNthCalledWith(1, 2, false)
    expect(activate).toHaveBeenNthCalledWith(2, 1, true)
  })

  it('is a quiet no-op when no surface is focused', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    cleanups.push(() => debug.mockRestore())
    const move = vi.fn()
    const element = focusSurface({ move })
    element.blur()
    invoke(ListFocusDownAction)
    expect(move).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(expect.stringContaining(ListFocusDownAction.ID))
  })

  it('is a quiet no-op when no surface is registered at all', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    cleanups.push(() => debug.mockRestore())
    const win = new Window()
    const doc = win.document as unknown as Document
    const documentRegistration = registerWorkbenchDocument(doc)
    setActiveWorkbenchDocument(doc)
    cleanups.push(() => documentRegistration.dispose())
    invoke(ListFocusDownAction)
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('no active surface'))
  })
})

describe('Vim surface command ids', () => {
  it('registers a distinct id for every action', () => {
    const ids = [
      ListFocusUpAction.ID,
      ListFocusDownAction.ID,
      ListFocusLeftAction.ID,
      ListFocusRightAction.ID,
      ListFocusFirstAction.ID,
      ListFocusLastAction.ID,
      ListPageUpAction.ID,
      ListPageDownAction.ID,
      ListScrollViewportUpAction.ID,
      ListScrollViewportDownAction.ID,
      ListExpandAction.ID,
      ListCollapseAction.ID,
      ListToggleAction.ID,
      ListActivateAction.ID,
      ListActivatePreviewAction.ID,
      ListContextMenuAction.ID,
      ListCopyAction.ID,
      ListDeleteAction.ID,
      SurfaceNextAction.ID,
      SurfacePreviousAction.ID,
      SurfaceEscapeAction.ID,
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
