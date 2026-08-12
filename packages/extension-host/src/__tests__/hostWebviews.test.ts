/*---------------------------------------------------------------------------------------------
 *  Tests for HostWebviewManager's extension-owned `createWebviewPanel` path:
 *  negative handle allocation, create RPC carrying options, title/reveal/dispose
 *  write-through, and the idempotent accept-side state callbacks.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it, vi } from 'vitest'
import type { IMainThreadWebviews } from '@universe-editor/extensions-common'
import { HostWebviewManager } from '../hostWebviews.js'

function fakeMainThread() {
  return {
    $registerCustomEditorProvider: vi.fn(() => Promise.resolve()),
    $unregisterCustomEditorProvider: vi.fn(() => Promise.resolve()),
    $setWebviewOptions: vi.fn(() => Promise.resolve()),
    $setWebviewHtml: vi.fn(() => Promise.resolve()),
    $postMessageToWebview: vi.fn(() => Promise.resolve(true)),
    $createWebviewPanel: vi.fn(() => Promise.resolve()),
    $disposeWebviewPanel: vi.fn(() => Promise.resolve()),
    $revealWebviewPanel: vi.fn(() => Promise.resolve()),
    $setWebviewTitle: vi.fn(() => Promise.resolve()),
  } satisfies IMainThreadWebviews
}

describe('HostWebviewManager.createWebviewPanel', () => {
  it('allocates a negative handle, returns the panel synchronously, and fires the create RPC', () => {
    const mainThread = fakeMainThread()
    const manager = new HostWebviewManager(mainThread)

    const panel = manager.createWebviewPanel(
      'cat.view',
      'Kitty',
      { enableScripts: true },
      undefined,
    )

    expect(panel.viewType).toBe('cat.view')
    expect(panel.title).toBe('Kitty')
    expect(mainThread.$createWebviewPanel).toHaveBeenCalledWith(
      -1,
      'cat.view',
      'Kitty',
      { enableScripts: true },
      undefined,
    )
    // A second panel gets the next negative handle (disjoint space).
    const panel2 = manager.createWebviewPanel('cat.view', 'Two', undefined, undefined)
    expect(mainThread.$createWebviewPanel).toHaveBeenLastCalledWith(
      -2,
      'cat.view',
      'Two',
      {},
      undefined,
    )
    expect(panel2.title).toBe('Two')
  })

  it('extension-owned panels start inactive/invisible until a view state arrives', () => {
    const manager = new HostWebviewManager(fakeMainThread())
    const panel = manager.createWebviewPanel('cat.view', 'A', undefined, undefined)
    expect(panel.active).toBe(false)
    expect(panel.visible).toBe(false)
  })

  it('title setter writes through $setWebviewTitle for extension-owned panels', () => {
    const mainThread = fakeMainThread()
    const manager = new HostWebviewManager(mainThread)
    const panel = manager.createWebviewPanel('cat.view', 'Old', undefined, undefined)

    panel.title = 'New'
    expect(panel.title).toBe('New')
    expect(mainThread.$setWebviewTitle).toHaveBeenCalledWith(-1, 'New')
  })

  it('reveal forwards $revealWebviewPanel with preserveFocus for extension-owned panels', () => {
    const mainThread = fakeMainThread()
    const manager = new HostWebviewManager(mainThread)
    const panel = manager.createWebviewPanel('cat.view', 'A', undefined, undefined)

    panel.reveal(true)
    expect(mainThread.$revealWebviewPanel).toHaveBeenCalledWith(-1, true)
  })

  it('dispose fires onDidDispose, tells the renderer, and drops the panel (idempotent)', () => {
    const mainThread = fakeMainThread()
    const manager = new HostWebviewManager(mainThread)
    const panel = manager.createWebviewPanel('cat.view', 'A', undefined, undefined)
    let disposed = 0
    panel.onDidDispose(() => disposed++)

    panel.dispose()
    panel.dispose()
    expect(disposed).toBe(1)
    expect(mainThread.$disposeWebviewPanel).toHaveBeenCalledTimes(1)
    expect(mainThread.$disposeWebviewPanel).toHaveBeenCalledWith(-1)
  })

  it('acceptPanelDisposed fires onDidDispose WITHOUT echoing $disposeWebviewPanel', () => {
    const mainThread = fakeMainThread()
    const manager = new HostWebviewManager(mainThread)
    const panel = manager.createWebviewPanel('cat.view', 'A', undefined, undefined)
    let disposed = 0
    panel.onDidDispose(() => disposed++)

    manager.acceptPanelDisposed(-1)
    expect(disposed).toBe(1)
    expect(mainThread.$disposeWebviewPanel).not.toHaveBeenCalled()
  })

  it('acceptPanelViewState updates active/visible and fires onDidChangeViewState once', () => {
    const manager = new HostWebviewManager(fakeMainThread())
    const panel = manager.createWebviewPanel('cat.view', 'A', undefined, undefined)
    const events: Array<{ active: boolean; visible: boolean }> = []
    panel.onDidChangeViewState((e) =>
      events.push({ active: e.webviewPanel.active, visible: e.webviewPanel.visible }),
    )

    manager.acceptPanelViewState(-1, true, true)
    manager.acceptPanelViewState(-1, true, true) // no change → no event
    manager.acceptPanelViewState(-1, false, false)
    expect(panel.active).toBe(false)
    expect(panel.visible).toBe(false)
    expect(events).toEqual([
      { active: true, visible: true },
      { active: false, visible: false },
    ])
  })

  it('accept callbacks for an unknown handle are ignored', () => {
    const manager = new HostWebviewManager(fakeMainThread())
    expect(() => {
      manager.acceptPanelDisposed(-99)
      manager.acceptPanelViewState(-99, true, true)
    }).not.toThrow()
  })
})
