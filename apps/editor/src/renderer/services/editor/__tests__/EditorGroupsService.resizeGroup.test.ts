/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for EditorGroupsService.resizeGroup() — the keyboard resize path into
 *  the editor grid (the grid renders flex weights, so sizes are asserted in
 *  pixels through `Grid.getViewSize`).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Event,
  GroupDirection,
  LogLevel,
  type IEditorGroup,
  type ILogger,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'

function makeLogger(): ILogger {
  return {
    level: LogLevel.Info,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
}

function setup() {
  const service = new EditorGroupsService()
  const grid = service.grid
  grid.setContainerSize({ width: 1000, height: 600 })
  return { service, grid }
}

function widthOf(service: EditorGroupsService, group: IEditorGroup): number {
  return service.grid.getViewSize(group as never)?.width ?? 0
}

function flexSizeOf(service: EditorGroupsService, group: IEditorGroup): number {
  return service.grid.getLeafSize(group as never)
}

describe('EditorGroupsService.resizeGroup', () => {
  it('trades width between two side-by-side groups', () => {
    const { service } = setup()
    const first = service.activeGroup
    const second = service.addGroup(first, GroupDirection.Right)
    const beforeFirst = widthOf(service, first)
    const beforeSecond = widthOf(service, second)

    expect(service.resizeGroup(first, 'width', 50)).toBe(true)

    expect(widthOf(service, first)).toBeCloseTo(beforeFirst + 50)
    expect(widthOf(service, second)).toBeCloseTo(beforeSecond - 50)
  })

  it('shares space with the previous sibling for the last group in the row', () => {
    const { service } = setup()
    const first = service.activeGroup
    const second = service.addGroup(first, GroupDirection.Right)
    const beforeFirst = widthOf(service, first)
    const beforeSecond = widthOf(service, second)

    expect(service.resizeGroup(second, 'width', 50)).toBe(true)

    expect(widthOf(service, second)).toBeCloseTo(beforeSecond + 50)
    expect(widthOf(service, first)).toBeCloseTo(beforeFirst - 50)
  })

  it('resizes stacked groups along the height axis', () => {
    const { service, grid } = setup()
    const first = service.activeGroup
    const second = service.addGroup(first, GroupDirection.Down)
    const before = grid.getViewSize(first as never)?.height ?? 0

    expect(service.resizeGroup(first, 'height', 60)).toBe(true)

    expect(grid.getViewSize(first as never)?.height).toBeCloseTo(before + 60)
    expect(grid.getViewSize(second as never)?.height).toBeCloseTo(600 - before - 60)
  })

  it('reports false for an axis the groups are not split along', () => {
    const { service } = setup()
    const first = service.activeGroup
    service.addGroup(first, GroupDirection.Right)

    expect(service.resizeGroup(first, 'height', 50)).toBe(false)
  })

  it('claims the axis but moves nothing while the grid has not been measured', () => {
    const service = new EditorGroupsService()
    const first = service.activeGroup
    const second = service.addGroup(first, GroupDirection.Right)
    const before = flexSizeOf(service, first)

    // Handled (the row split exists) so the caller must not fall back to the
    // chrome, yet there is no pixel anchor to convert the step with.
    expect(service.resizeGroup(first, 'width', 50)).toBe(true)
    expect(flexSizeOf(service, first)).toBe(before)
    expect(flexSizeOf(service, second)).toBe(before)
  })

  it('warns once per request while the grid has no measurement', () => {
    const logger = makeLogger()
    const service = new EditorGroupsService(logger)
    const first = service.activeGroup
    service.addGroup(first, GroupDirection.Right)

    // Silent no-op is the trap: claiming the axis without a pixel anchor looks
    // exactly like a dead shortcut, so the path has to say so.
    expect(service.resizeGroup(first, 'width', 50)).toBe(true)
    expect(logger.warn).toHaveBeenCalledOnce()
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      'no usable width',
    )

    service.grid.setContainerSize({ width: 1000, height: 600 })
    expect(service.resizeGroup(first, 'width', 50)).toBe(true)
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('reports false for a lone group', () => {
    const { service } = setup()
    expect(service.resizeGroup(service.activeGroup, 'width', 50)).toBe(false)
  })

  it('reports false for a group that is not in the grid', () => {
    const { service } = setup()
    service.addGroup(service.activeGroup, GroupDirection.Right)
    expect(service.resizeGroup({ id: 999 } as IEditorGroup, 'width', 50)).toBe(false)
  })
})
