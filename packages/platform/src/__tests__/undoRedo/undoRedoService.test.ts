/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/undoRedo/undoRedoService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import type { IDialogService } from '../../dialog/dialogService.js'
import type { INotificationService } from '../../notification/notificationService.js'
import { UndoRedoService } from '../../undoRedo/undoRedoService.js'
import {
  type IResourceUndoRedoElement,
  type IWorkspaceUndoRedoElement,
  UndoRedoElementType,
  UndoRedoGroup,
  UndoRedoSource,
} from '../../undoRedo/undoRedo.js'

function makeService(
  dialogConfirm: () => Promise<{
    confirmed: boolean
    choice: 'primary' | 'secondary' | 'cancel'
  }> = async () => ({
    confirmed: true,
    choice: 'primary',
  }),
): UndoRedoService {
  const dialog: IDialogService = {
    _serviceBrand: undefined,
    confirm: dialogConfirm as IDialogService['confirm'],
    prompt: async () => undefined,
  }
  const notification: INotificationService = {
    notify: () => ({ dispose() {} }) as never,
  } as unknown as INotificationService
  return new UndoRedoService(dialog, notification)
}

function resourceElement(resource: URI, log: string[], name: string): IResourceUndoRedoElement {
  return {
    type: UndoRedoElementType.Resource,
    resource,
    label: name,
    code: name,
    undo: () => {
      log.push(`undo:${name}`)
    },
    redo: () => {
      log.push(`redo:${name}`)
    },
  }
}

describe('UndoRedoService', () => {
  it('pushes a resource element and undoes/redoes it', async () => {
    const svc = makeService()
    const uri = URI.file('/ws/a.txt')
    const log: string[] = []
    svc.pushElement(resourceElement(uri, log, 'A'))

    expect(svc.canUndo(uri)).toBe(true)
    await svc.undo(uri)
    expect(log).toEqual(['undo:A'])
    expect(svc.canUndo(uri)).toBe(false)
    expect(svc.canRedo(uri)).toBe(true)

    await svc.redo(uri)
    expect(log).toEqual(['undo:A', 'redo:A'])
  })

  it('pushing a new element clears the redo stack', async () => {
    const svc = makeService()
    const uri = URI.file('/ws/a.txt')
    const log: string[] = []
    svc.pushElement(resourceElement(uri, log, 'A'))
    await svc.undo(uri)
    expect(svc.canRedo(uri)).toBe(true)

    svc.pushElement(resourceElement(uri, log, 'B'))
    expect(svc.canRedo(uri)).toBe(false)
    expect(svc.canUndo(uri)).toBe(true)
  })

  it('scopes undo/redo to an UndoRedoSource', async () => {
    const svc = makeService()
    const source = new UndoRedoSource()
    const uri = URI.file('/ws/a.txt')
    const log: string[] = []
    svc.pushElement(resourceElement(uri, log, 'A'), UndoRedoGroup.None, source)

    expect(svc.canUndo(source)).toBe(true)
    // A different, empty source has nothing to undo.
    expect(svc.canUndo(new UndoRedoSource())).toBe(false)

    await svc.undo(source)
    expect(log).toEqual(['undo:A'])
    expect(svc.canRedo(source)).toBe(true)
    await svc.redo(source)
    expect(log).toEqual(['undo:A', 'redo:A'])
  })

  it('undoes a workspace element spanning multiple resources', async () => {
    const svc = makeService()
    const a = URI.file('/ws/a.txt')
    const b = URI.file('/ws/b.txt')
    const log: string[] = []
    const element: IWorkspaceUndoRedoElement = {
      type: UndoRedoElementType.Workspace,
      resources: [a, b],
      label: 'W',
      code: 'W',
      undo: () => {
        log.push('undo:W')
      },
      redo: () => {
        log.push('redo:W')
      },
    }
    svc.pushElement(element)
    expect(svc.canUndo(a)).toBe(true)
    expect(svc.canUndo(b)).toBe(true)

    await svc.undo(a)
    expect(log).toEqual(['undo:W'])
    // Both resources move to the redo stack together.
    expect(svc.canUndo(a)).toBe(false)
    expect(svc.canUndo(b)).toBe(false)
    expect(svc.canRedo(a)).toBe(true)
  })

  it('removeElements drops a resource stack', async () => {
    const svc = makeService()
    const uri = URI.file('/ws/a.txt')
    const log: string[] = []
    svc.pushElement(resourceElement(uri, log, 'A'))
    svc.removeElements(uri)
    expect(svc.canUndo(uri)).toBe(false)
  })
})
