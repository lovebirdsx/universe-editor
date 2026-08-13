/*---------------------------------------------------------------------------------------------
 *  Tests for WebviewService: custom-editor provider registration, panel open →
 *  host resolve, html/options/message plumbing, host reset teardown, and the
 *  extension-owned `createWebviewPanel` lifecycle (create/reveal/title/dispose).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  Emitter,
  GroupDirection,
  URI,
  type IEditorGroup,
  type IEditorGroupsService,
} from '@universe-editor/platform'
import type { IExtHostWebviews } from '@universe-editor/extensions-common'
import { WebviewService } from '../WebviewService.js'
import { WebviewPanelInput } from '../../editor/WebviewPanelInput.js'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import { CustomEditorInput } from '../../editor/CustomEditorInput.js'

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
  const activeEditorChange = new Emitter<void>()
  let activeEditor: WebviewPanelInput | undefined
  const group = {
    opened,
    closed,
    activated,
    isActive: true,
    onDidActiveEditorChange: activeEditorChange.event,
    get activeEditor() {
      return activeEditor
    },
    openEditor: (input: WebviewPanelInput, options?: { activate?: boolean }) => {
      opened.push(input)
      // Mirror EditorGroupModel: open activates unless told not to; the first
      // editor in an empty group is implicitly active.
      if (options?.activate !== false || activeEditor === undefined) {
        activeEditor = input
        activeEditorChange.fire()
      }
    },
    closeEditor: (input: WebviewPanelInput) => {
      if (!opened.includes(input)) return false
      closed.push(input)
      if (activeEditor === input) {
        activeEditor = undefined
        activeEditorChange.fire()
      }
      // The real group disposes the input via its store; mirror that so the
      // input's onWillDispose (which reports $acceptPanelDisposed) fires.
      input.dispose()
      return true
    },
    contains: (input: WebviewPanelInput) => opened.includes(input) && !closed.includes(input),
    findEditor: (editor: EditorInput) =>
      opened.find((o) => !closed.includes(o) && o.matches(editor)),
    setActive: (input: WebviewPanelInput) => {
      activated.push(input)
      if (activeEditor !== input) {
        activeEditor = input
        activeEditorChange.fire()
      }
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
  const activeGroupChange = new Emitter<IEditorGroup>()
  const addGroup = new Emitter<IEditorGroup>()
  const removeGroup = new Emitter<IEditorGroup>()
  return Object.assign(state, {
    activeGroup: group,
    activeGroupForOpen: group,
    groups: [group],
    onDidActiveGroupChange: activeGroupChange.event,
    onDidAddGroup: addGroup.event,
    onDidRemoveGroup: removeGroup.event,
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

  it('createWebviewPanel before the editor-groups wiring is queued and replays once wired', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const svc = new WebviewService()
      svc.setExtHost('local', fakeExtHost())
      const mainThread = svc.createMainThread('local')
      // No setEditorGroupsAccessor yet — the create must queue (with a warn),
      // never silently produce a "live" panel whose tab can never exist.
      void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)
      void mainThread.$setWebviewHtml(-1, '<html>early</html>')
      expect(svc.getPanel(-1)).toBeUndefined()
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('$createWebviewPanel'))

      const group = fakeGroup()
      svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
      // The queued ops replay in order once the wiring lands; flush microtasks.
      await Promise.resolve()
      await Promise.resolve()

      expect(group.opened).toHaveLength(1)
      expect(svc.getPanel(-1)?.html.get()).toBe('<html>early</html>')
      svc.dispose()
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('host panel ops received after dispose during the unwired window become no-ops', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const svc = new WebviewService()
      svc.setExtHost('local', fakeExtHost())
      const mainThread = svc.createMainThread('local')
      void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)
      svc.dispose()

      const group = fakeGroup()
      svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
      await Promise.resolve()
      await Promise.resolve()

      expect(group.opened).toHaveLength(0)
    } finally {
      consoleWarn.mockRestore()
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

  it('reports the initial view state once the panel tab opens', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    const group = fakeGroup()
    svc.setEditorGroupsAccessor(() => fakeEditorGroups(group))
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, undefined)
    expect(extHost.viewStates).toEqual([{ panelHandle: -1, active: true, visible: true }])
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

/** Trivial non-webview competitor tab used to push a webview tab into the background. */
class TestFileInput extends EditorInput {
  constructor(private readonly _key: string) {
    super()
  }
  override get typeId(): string {
    return 'testFile'
  }
  override get resource(): URI | undefined {
    return undefined
  }
  override getName(): string {
    return this._key
  }
  override get id(): string {
    return `testFile:${this._key}`
  }
}

// View-state tracking against the real EditorGroupsService: the service derives
// each panel's active/visible from the editor groups (visible = the panel's tab
// is its group's active editor; active = and that group is the focused group),
// reporting only on change.
describe('WebviewService panel view state tracking', () => {
  function wired() {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    const groups = new EditorGroupsService()
    svc.setEditorGroupsAccessor(() => groups)
    return { svc, extHost, mainThread, groups }
  }

  function openWebviewPanel(
    mainThread: ReturnType<WebviewService['createMainThread']>,
    groups: EditorGroupsService,
    options?: { preserveFocus?: boolean },
  ): WebviewPanelInput {
    void mainThread.$createWebviewPanel(-1, 'cat.view', 'A', {}, options)
    const input = groups.groups.flatMap((g) => g.editors).find((e) => e.typeId === 'webviewPanel')
    expect(input).toBeInstanceOf(WebviewPanelInput)
    return input as WebviewPanelInput
  }

  it('an activated createWebviewPanel reports (active=true, visible=true)', () => {
    const { extHost, mainThread, groups } = wired()
    openWebviewPanel(mainThread, groups)
    expect(extHost.viewStates).toEqual([{ panelHandle: -1, active: true, visible: true }])
  })

  it('preserveFocus create never claims active while the tab stays background', () => {
    const { extHost, mainThread, groups } = wired()
    groups.activeGroup.openEditor(new TestFileInput('foreground'))
    const input = openWebviewPanel(mainThread, groups, { preserveFocus: true })

    // The tracker must not report (active=true, visible=true) for a tab that was
    // never activated (the old mount-driven report did).
    expect(extHost.viewStates).not.toContainEqual({ panelHandle: -1, active: true, visible: true })

    groups.activeGroup.setActive(input)
    expect(extHost.viewStates[extHost.viewStates.length - 1]).toEqual({
      panelHandle: -1,
      active: true,
      visible: true,
    })
  })

  it('switching to another tab reports visible=false and back reports visible=true', () => {
    const { extHost, mainThread, groups } = wired()
    const input = openWebviewPanel(mainThread, groups)
    expect(extHost.viewStates).toEqual([{ panelHandle: -1, active: true, visible: true }])

    groups.activeGroup.openEditor(new TestFileInput('other'))
    expect(extHost.viewStates[extHost.viewStates.length - 1]).toEqual({
      panelHandle: -1,
      active: false,
      visible: false,
    })

    groups.activeGroup.setActive(input)
    expect(extHost.viewStates).toEqual([
      { panelHandle: -1, active: true, visible: true },
      { panelHandle: -1, active: false, visible: false },
      { panelHandle: -1, active: true, visible: true },
    ])

    // Dedupe: while already hidden, more same-group tab churn must not resend.
    groups.activeGroup.openEditor(new TestFileInput('third'))
    expect(extHost.viewStates).toHaveLength(4)
    groups.activeGroup.openEditor(new TestFileInput('fourth'))
    expect(extHost.viewStates).toHaveLength(4)
  })

  it('focusing another (split) group drops active but keeps visible', () => {
    const { extHost, mainThread, groups } = wired()
    openWebviewPanel(mainThread, groups)
    const first = groups.groups[0]!
    const second = groups.addGroup(first, GroupDirection.Right)

    groups.activateGroup(second)
    expect(extHost.viewStates[extHost.viewStates.length - 1]).toEqual({
      panelHandle: -1,
      active: false,
      visible: true,
    })

    groups.activateGroup(first)
    expect(extHost.viewStates[extHost.viewStates.length - 1]).toEqual({
      panelHandle: -1,
      active: true,
      visible: true,
    })
  })

  it('custom editor panels track view state via their editor input', () => {
    const { svc, extHost, mainThread, groups } = wired()
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    const uri = URI.file('/docs/a.pdf')
    const input = new CustomEditorInput('pdf.view', uri)
    groups.activeGroup.openEditor(input)

    const panel = svc.openPanel('pdf.view', uri, undefined, input)!
    expect(extHost.viewStates).toEqual([
      { panelHandle: panel.panelHandle, active: true, visible: true },
    ])

    // Focus moves to a split group: still the selected tab there → visible, not active.
    const second = groups.addGroup(groups.groups[0]!, GroupDirection.Right)
    groups.activateGroup(second)
    expect(extHost.viewStates[extHost.viewStates.length - 1]).toEqual({
      panelHandle: panel.panelHandle,
      active: false,
      visible: true,
    })

    // A competitor tab in the same group hides it entirely.
    groups.activateGroup(groups.groups[0]!)
    groups.groups[0]!.openEditor(new TestFileInput('other'))
    expect(extHost.viewStates[extHost.viewStates.length - 1]).toEqual({
      panelHandle: panel.panelHandle,
      active: false,
      visible: false,
    })
  })
})
