/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { PartId, type IViewDescriptorService } from '@universe-editor/platform'
import { isViewAvailable, resolveHistoryLocation } from '../historyLocation.js'

interface FakeElement {
  readonly parentElement: FakeElement | null
  getAttribute(name: string): string | null
}

function el(attrs: Record<string, string>, parent: FakeElement | null = null): FakeElement {
  return { parentElement: parent, getAttribute: (name) => attrs[name] ?? null }
}

const allVisible = () => true

describe('resolveHistoryLocation', () => {
  it('returns undefined without an element', () => {
    expect(resolveHistoryLocation(null, allVisible)).toBeUndefined()
  })

  it('treats anything inside the editor area as the editor', () => {
    const area = el({ 'data-testid': 'part-editorArea' })
    // A view root's own testid must not stop the walk (acp-prompt, search-view, ...).
    const prompt = el({ 'data-testid': 'acp-prompt' }, area)
    expect(resolveHistoryLocation(el({}, prompt), allVisible)).toEqual({ kind: 'editor' })
  })

  it('resolves a focused view in a visible side bar or panel', () => {
    const sideBar = el({ 'data-testid': 'part-sidebar' })
    const view = el({ 'data-view-id': 'workbench.view.explorer.tree' }, sideBar)
    expect(resolveHistoryLocation(el({ role: 'treeitem' }, view), allVisible)).toEqual({
      kind: 'view',
      viewId: 'workbench.view.explorer.tree',
    })
    const panel = el({ 'data-testid': 'part-panel' })
    const output = el({ 'data-view-id': 'workbench.view.output.main' }, panel)
    expect(resolveHistoryLocation(output, allVisible)).toEqual({
      kind: 'view',
      viewId: 'workbench.view.output.main',
    })
  })

  it('ignores the activity bar and the status bar', () => {
    expect(
      resolveHistoryLocation(el({}, el({ 'data-testid': 'part-activitybar' })), allVisible),
    ).toBeUndefined()
    expect(
      resolveHistoryLocation(el({}, el({ 'data-testid': 'part-statusbar' })), allVisible),
    ).toBeUndefined()
  })

  it('ignores focus outside every part (Quick Input, menus)', () => {
    expect(resolveHistoryLocation(el({ 'data-testid': 'quick-input' }), allVisible)).toBeUndefined()
  })

  it('ignores a view inside a hidden part', () => {
    const panel = el({ 'data-testid': 'part-panel' })
    const terminal = el({ 'data-view-id': 'workbench.view.terminal' }, panel)
    const visible = (partId: PartId) => partId !== PartId.Panel
    expect(resolveHistoryLocation(terminal, visible)).toBeUndefined()
  })

  it('ignores part chrome that belongs to no view', () => {
    const sideBar = el({ 'data-testid': 'part-sidebar' })
    expect(resolveHistoryLocation(el({ role: 'tab' }, sideBar), allVisible)).toBeUndefined()
  })
})

describe('isViewAvailable', () => {
  function fakeViews(visibleViews: Record<string, string[]>, homes: Record<string, string>) {
    return {
      getViewContainerByViewId: (viewId: string) => {
        const id = homes[viewId]
        return id ? { id } : undefined
      },
      getViewsByContainer: (containerId: string) =>
        (visibleViews[containerId] ?? []).map((id) => ({ id })),
    } as unknown as IViewDescriptorService
  }

  it('is true for a registered view that its when clause shows', () => {
    const views = fakeViews({ explorer: ['explorer.tree'] }, { 'explorer.tree': 'explorer' })
    expect(isViewAvailable(views, 'explorer.tree')).toBe(true)
  })

  it('is false for an unregistered view', () => {
    expect(isViewAvailable(fakeViews({}, {}), 'gone')).toBe(false)
  })

  it('is false for a view hidden by its when clause', () => {
    const views = fakeViews({ scm: [] }, { 'scm.repos': 'scm' })
    expect(isViewAvailable(views, 'scm.repos')).toBe(false)
  })
})
