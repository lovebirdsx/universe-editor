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
  ICommandService,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
  configureNls,
  registerAction2,
  type Action2,
} from '@universe-editor/platform'
import {
  __resetVimSurfacesForTests,
  registerVimSurface,
  type IVimSurfaceActions,
} from '@universe-editor/workbench-ui'
import { ZH_CN_MESSAGES } from '../../../shared/i18n/messages/zh-CN.js'
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
  ListFindAction,
  ListPageDownAction,
  ListPageUpAction,
  ListScrollViewportDownAction,
  ListScrollViewportUpAction,
  ListToggleAction,
  SurfaceEscapeAction,
  SurfaceNextAction,
  SurfacePreviousAction,
  VIM_SURFACE_ACTIONS,
} from '../vimSurfaceActions.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  __resetVimSurfacesForTests()
})

type ActionClass = { readonly ID: string; new (): Action2 }

function invoke(action: ActionClass, ...args: unknown[]): void {
  invokeWith(new ServiceCollection(), action, ...args)
}

function invokeWith(services: ServiceCollection, action: ActionClass, ...args: unknown[]): void {
  const registration = registerAction2(action)
  cleanups.push(() => registration.dispose())
  const instantiation = new InstantiationService(services)
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

  describe('Escape with nothing left to escape', () => {
    function services(focusedView: string) {
      const executeCommand = vi.fn(async () => undefined)
      const collection = new ServiceCollection()
      collection.set(ICommandService, { executeCommand } as never)
      collection.set(IContextKeyService, {
        get: (key: string) => (key === 'focusedView' ? focusedView : undefined),
      } as never)
      return { collection, executeCommand }
    }

    it('hands focus back to the editor from a view list', () => {
      for (const actions of [{ escape: () => false }, {}]) {
        focusSurface(actions)
        const { collection, executeCommand } = services('workbench.explorer.fileView')
        invokeWith(collection, SurfaceEscapeAction)
        expect(executeCommand).toHaveBeenCalledWith('workbench.action.focusActiveEditorGroup')
        __resetVimSurfacesForTests()
      }
    })

    it('stays put when the surface escaped something or is not a view', () => {
      focusSurface({ escape: () => true })
      const handled = services('workbench.explorer.fileView')
      invokeWith(handled.collection, SurfaceEscapeAction)
      expect(handled.executeCommand).not.toHaveBeenCalled()
      __resetVimSurfacesForTests()

      // A list inside the editor area (settings, graph) already is the editor.
      focusSurface({ escape: () => false })
      const editorList = services('')
      invokeWith(editorList.collection, SurfaceEscapeAction)
      expect(editorList.executeCommand).not.toHaveBeenCalled()
    })
  })

  it('forwards the command count from the dispatcher args', () => {
    const move = vi.fn()
    focusSurface({ move })
    invoke(ListFocusDownAction, { count: 3 })
    expect(move).toHaveBeenCalledWith('down', 3)
  })

  it('sends first/last 0 unless a count was typed', () => {
    const first = vi.fn()
    const last = vi.fn()
    focusSurface({ first, last })
    invoke(ListFocusFirstAction, { count: 1 })
    invoke(ListFocusFirstAction, { count: 1, hasCount: true })
    invoke(ListFocusLastAction, { count: 1 })
    invoke(ListFocusLastAction, { count: 4, hasCount: true })
    // A direct call without the dispatcher's flag still honours a count above 1.
    invoke(ListFocusLastAction, { count: 3 })
    expect(first).toHaveBeenNthCalledWith(1, 0)
    expect(first).toHaveBeenNthCalledWith(2, 1)
    expect(last).toHaveBeenNthCalledWith(1, 0)
    expect(last).toHaveBeenNthCalledWith(2, 4)
    expect(last).toHaveBeenNthCalledWith(3, 3)
  })

  it('opens the surface filter box on list.find', () => {
    const find = vi.fn()
    focusSurface({ find })
    invoke(ListFindAction)
    expect(find).toHaveBeenCalledTimes(1)
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

describe('Vim surface command titles', () => {
  // The titles use a dynamic `action.vim.<id>.title` key, which the literal-key zh-CN
  // coverage scan cannot see: a missing entry would silently show English.
  it('has a zh-CN title for every action, and uses it', () => {
    const missing = VIM_SURFACE_ACTIONS.map((action) => `action.vim.${action.ID}.title`).filter(
      (key) => ZH_CN_MESSAGES[key] === undefined,
    )
    expect(missing).toEqual([])

    configureNls({ locale: 'zh-CN', messages: ZH_CN_MESSAGES })
    cleanups.push(() => configureNls({ locale: 'en-US' }))
    for (const Action of VIM_SURFACE_ACTIONS) {
      const { title, category } = new Action().desc
      expect(typeof title === 'string' ? title : title.value).toBe(
        ZH_CN_MESSAGES[`action.vim.${Action.ID}.title`],
      )
      expect(category).toBeDefined()
    }
  })

  it('keeps VIM_SURFACE_ACTIONS ids distinct', () => {
    const ids = VIM_SURFACE_ACTIONS.map((action) => action.ID)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
