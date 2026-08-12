/*---------------------------------------------------------------------------------------------
 *  Tests for WebviewService: custom-editor provider registration, panel open →
 *  host resolve, html/options/message plumbing, host reset teardown, and the
 *  extension-owned `createWebviewPanel` lifecycle (create/reveal/title/dispose).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI, type IEditorGroup, type IEditorGroupsService } from '@universe-editor/platform'
import type { IExtHostWebviews } from '@universe-editor/extensions-common'
import { WebviewService } from '../WebviewService.js'
import { WebviewPanelInput } from '../../editor/WebviewPanelInput.js'

function fakeExtHost(): IExtHostWebviews & {
  resolves: Array<{ providerHandle: number; panelHandle: number; viewType: string }>
  messages: Array<{ panelHandle: number; message: unknown }>
  disposed: number[]
  acceptedDisposed: number[]
  viewStates: Array<{ panelHandle: number; active: boolean; visible: boolean }>
} {
  const resolves: Array<{ providerHandle: number; panelHandle: number; viewType: string }> = []
  const messages: Array<{ panelHandle: number; message: unknown }> = []
  const disposed: number[] = []
  const acceptedDisposed: number[] = []
  const viewStates: Array<{ panelHandle: number; active: boolean; visible: boolean }> = []
  return {
    resolves,
    messages,
    disposed,
    acceptedDisposed,
    viewStates,
    $resolveCustomEditor: (providerHandle, panelHandle, viewType) => {
      resolves.push({ providerHandle, panelHandle, viewType })
      return Promise.resolve()
    },
    $onDidReceiveMessage: (panelHandle, message) => {
      messages.push({ panelHandle, message })
      return Promise.resolve()
    },
    $disposeWebviewPanel: (panelHandle) => {
      disposed.push(panelHandle)
      return Promise.resolve()
    },
    $acceptPanelDisposed: (panelHandle) => {
      acceptedDisposed.push(panelHandle)
      return Promise.resolve()
    },
    $acceptPanelViewState: (panelHandle, active, visible) => {
      viewStates.push({ panelHandle, active, visible })
      return Promise.resolve()
    },
  }
}

/** Minimal group that tracks open/close/contains/setActive for one input set. */
function fakeGroup(): IEditorGroup & {
  opened: WebviewPanelInput[]
  closed: WebviewPanelInput[]
  activated: WebviewPanelInput[]
} {
  const opened: WebviewPanelInput[] = []
  const closed: WebviewPanelInput[] = []
  const activated: WebviewPanelInput[] = []
  const group = {
    opened,
    closed,
    activated,
    isActive: true,
    openEditor: (input: WebviewPanelInput) => {
      opened.push(input)
    },
    closeEditor: (input: WebviewPanelInput) => {
      if (!opened.includes(input)) return false
      closed.push(input)
      // The real group disposes the input via its store; mirror that so the
      // input's onWillDispose (which reports $acceptPanelDisposed) fires.
      input.dispose()
      return true
    },
    contains: (input: WebviewPanelInput) => opened.includes(input) && !closed.includes(input),
    setActive: (input: WebviewPanelInput) => {
      activated.push(input)
    },
  }
  return group as unknown as IEditorGroup & {
    opened: WebviewPanelInput[]
    closed: WebviewPanelInput[]
    activated: WebviewPanelInput[]
  }
}

/** Fake IEditorGroupsService exposing the one group createWebviewPanel opens into. */
function fakeEditorGroups(
  group: ReturnType<typeof fakeGroup>,
): IEditorGroupsService & { activateGroupCalls: number } {
  const state = { activateGroupCalls: 0 }
  return Object.assign(state, {
    activeGroupForOpen: group,
    groups: [group],
    activateGroup: () => {
      state.activateGroupCalls++
      return group
    },
  }) as unknown as IEditorGroupsService & { activateGroupCalls: number }
}

describe('WebviewService', () => {
  it('registers a provider, opens a panel, and asks the owning host to resolve it', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')

    void mainThread.$registerCustomEditorProvider(7, 'pdf.view')
    expect(svc.hasProviderForViewType('pdf.view')).toBe(true)

    const uri = URI.file('/docs/a.pdf')
    const panel = svc.openPanel('pdf.view', uri)
    expect(panel).toBeTruthy()
    expect(extHost.resolves).toEqual([
      { providerHandle: 7, panelHandle: panel!.panelHandle, viewType: 'pdf.view' },
    ])
  })

  it('returns undefined opening a panel for an unregistered viewType', () => {
    const svc = new WebviewService()
    svc.setExtHost('local', fakeExtHost())
    expect(svc.openPanel('missing.view', URI.file('/a.pdf'))).toBeUndefined()
  })

  it('flows html/options from the host into the panel observables', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!

    void mainThread.$setWebviewOptions(panel.panelHandle, {
      enableScripts: true,
      localResourceRoots: ['/ext/pdf'],
    })
    void mainThread.$setWebviewHtml(panel.panelHandle, '<html>pdf</html>')
    expect(panel.html.get()).toBe('<html>pdf</html>')
    expect(panel.options.get().enableScripts).toBe(true)
    expect(panel.options.get().localResourceRoots).toEqual(['/ext/pdf'])
  })

  it('relays messages both ways', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!

    const received: unknown[] = []
    panel.onMessageToWebview((m) => received.push(m))
    void mainThread.$postMessageToWebview(panel.panelHandle, { hello: 1 })
    expect(received).toEqual([{ hello: 1 }])

    panel.postMessageFromWebview({ open: 'x' })
    expect(extHost.messages).toEqual([{ panelHandle: panel.panelHandle, message: { open: 'x' } }])
  })

  it('closing a panel notifies the host and drops it', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!

    svc.closePanel(panel.panelHandle)
    expect(extHost.disposed).toEqual([panel.panelHandle])
  })

  it('reset(kind) drops the host’s providers and panels', () => {
    const svc = new WebviewService()
    svc.setExtHost('local', fakeExtHost())
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    svc.openPanel('pdf.view', URI.file('/a.pdf'))

    svc.reset('local')
    expect(svc.hasProviderForViewType('pdf.view')).toBe(false)
    expect(svc.openPanel('pdf.view', URI.file('/a.pdf'))).toBeUndefined()
  })

  it('shows an error page in the panel when the host fails to resolve the editor', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const svc = new WebviewService()
      const extHost = fakeExtHost()
      extHost.$resolveCustomEditor = () => Promise.reject(new Error('resolver exploded'))
      svc.setExtHost('local', extHost)
      const mainThread = svc.createMainThread('local')
      void mainThread.$registerCustomEditorProvider(0, 'pdf.view')

      const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!
      expect(panel.html.get()).toBe('')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(panel.html.get()).toContain('Failed to open this editor: resolver exploded')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('escapes html in the resolve failure message', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const svc = new WebviewService()
      const extHost = fakeExtHost()
      extHost.$resolveCustomEditor = () => Promise.reject(new Error('bad <input> & more'))
      svc.setExtHost('local', extHost)
      const mainThread = svc.createMainThread('local')
      void mainThread.$registerCustomEditorProvider(0, 'pdf.view')

      const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!
      await new Promise((resolve) => setTimeout(resolve, 0))

      const html = panel.html.get()
      expect(html).toContain('Failed to open this editor: bad &lt;input> &amp; more')
      expect(html).not.toContain('<input>')
    } finally {
      consoleError.mockRestore()
    }
  })

  // ---- Extension-owned panels (window.createWebviewPanel) --------------------

  it('createWebviewPanel before the editor-groups wiring drops the panel with no residue', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const svc = new WebviewService()
      svc.setExtHost('local', fakeExtHost())
      const mainThread = svc.createMainThread('local')
      // No setEditorGroupsAccessor — the service can't open a tab yet.

      void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)
      expect(svc.getPanel(-1)).toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('before editor groups are ready'),
      )
      // A retry after wiring must not trip the duplicate-handle guard.
      const group = fakeGroup()
      svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
      void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)
      expect(group.opened).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('createWebviewPanel builds the model, opens a tab, and reports view state', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))

    void mainThread.$createWebviewPanel(-1, 'cat.view', 'Kitty', { enableScripts: true }, undefined)

    const panel = svc.getPanel(-1)
    expect(panel).toBeTruthy()
    expect(panel!.viewType).toBe('cat.view')
    expect(panel!.options.get().enableScripts).toBe(true)
    expect(group.opened).toHaveLength(1)
    const input = group.opened[0]!
    expect(input.id).toBe('webviewPanel:-1')
    expect(input.getName()).toBe('Kitty')
    expect(input.typeId).toBe('webviewPanel')
    expect(input.resource).toBeUndefined()
  })

  it('createWebviewPanel with preserveFocus opens the tab without activating it', () => {
    const svc = new WebviewService()
    svc.setExtHost('local', fakeExtHost())
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    const activations: boolean[] = []
    const origOpen = group.openEditor.bind(group)
    group.openEditor = ((input: WebviewPanelInput, options?: { activate?: boolean }) => {
      activations.push(options?.activate !== false)
      origOpen(input)
    }) as unknown as typeof group.openEditor
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))

    void mainThread.$createWebviewPanel(-2, 'cat.view', 'Bg', {}, { preserveFocus: true })
    expect(activations).toEqual([false])
  })

  it('ignores a duplicate createWebviewPanel for the same handle', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const svc = new WebviewService()
      svc.setExtHost('local', fakeExtHost())
      const mainThread = svc.createMainThread('local')
      const group = fakeGroup()
      svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))

      void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)
      void mainThread.$createWebviewPanel(-1, 'cat.view', 'B', {}, undefined)
      expect(group.opened).toHaveLength(1)
      expect(svc.getPanel(-1)).toBeTruthy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('host $setWebviewTitle retitles the tab via the input label', () => {
    const svc = new WebviewService()
    svc.setExtHost('local', fakeExtHost())
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'Old', {}, undefined)

    const input = group.opened[0]!
    let labelFired = 0
    input.onDidChangeLabel(() => labelFired++)
    void mainThread.$setWebviewTitle(-1, 'New')
    expect(input.getName()).toBe('New')
    expect(labelFired).toBe(1)
  })

  it('user closing the tab reports $acceptPanelDisposed and drops the model', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)

    // Simulate the workbench closing the tab: the input's dispose drives closePanel.
    group.opened[0]!.dispose()
    expect(extHost.acceptedDisposed).toEqual([-1])
    expect(svc.getPanel(-1)).toBeUndefined()
  })

  it('host $disposeWebviewPanel closes the tab without echoing $acceptPanelDisposed', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)

    void mainThread.$disposeWebviewPanel(-1)
    expect(group.closed).toHaveLength(1)
    // suppressDisposeNotify prevented the round-trip back to the host.
    expect(extHost.acceptedDisposed).toEqual([])
    expect(svc.getPanel(-1)).toBeUndefined()
  })

  it('host $revealWebviewPanel re-activates the existing tab', () => {
    const svc = new WebviewService()
    svc.setExtHost('local', fakeExtHost())
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)

    void mainThread.$revealWebviewPanel(-1, undefined)
    expect(group.activated).toHaveLength(1)
  })

  it('reportPanelViewState relays mount/unmount to the host', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)

    svc.reportPanelViewState(-1, true, true)
    svc.reportPanelViewState(-1, false, false)
    expect(extHost.viewStates).toEqual([
      { panelHandle: -1, active: true, visible: true },
      { panelHandle: -1, active: false, visible: false },
    ])
  })

  it('reset(kind) closes extension-owned panel tabs without notifying the dying host', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)

    svc.reset('local')
    expect(group.closed).toHaveLength(1)
    expect(extHost.acceptedDisposed).toEqual([])
    expect(svc.getPanel(-1)).toBeUndefined()
  })
})
