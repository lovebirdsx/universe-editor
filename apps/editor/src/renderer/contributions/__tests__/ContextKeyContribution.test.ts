import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  IFileService,
  LifecyclePhase,
  LifecycleService,
  observableValue,
  PartId,
  URI,
  type HostPlatform,
} from '@universe-editor/platform'
import { ContextKeyContribution } from '../ContextKeyContribution.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'

function makeLayoutStub(initial?: Partial<Record<PartId, boolean>>) {
  const visible = observableValue<Readonly<Record<PartId, boolean>>>('layout', {
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.SecondarySideBar]: false,
    [PartId.EditorArea]: true,
    [PartId.Panel]: false,
    [PartId.StatusBar]: true,
    ...initial,
  })
  return { visible }
}

function makeEditorStub() {
  const activeEditor = observableValue<{ id: string } | undefined>('activeEditor', undefined)
  return { activeEditor }
}

function makeFileEditorStub() {
  const activeEditor = observableValue<FileEditorInput | undefined>('activeEditor', undefined)
  return { activeEditor }
}

function makeFileService(): IFileService {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileHead() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

interface FakeModel {
  language: string
  emitter: Emitter<{ newLanguage: string }>
  getLanguageId(): string
  onDidChangeLanguage(cb: (e: { newLanguage: string }) => void): { dispose(): void }
}

function makeFakeModel(language: string): FakeModel {
  const emitter = new Emitter<{ newLanguage: string }>()
  return {
    language,
    emitter,
    getLanguageId() {
      return this.language
    },
    onDidChangeLanguage: (cb) => emitter.event(cb),
  }
}

function bindModel(input: FileEditorInput, model: FakeModel): void {
  ;(input as unknown as { _bindModelLanguage(m: unknown): void })._bindModelLanguage(model)
}

function makeHostStub(platform: HostPlatform) {
  return { platform }
}

function makeLanguageFeaturesStub() {
  const onDidChangeProviders = new Emitter<void>()
  return {
    onDidChangeProviders: onDidChangeProviders.event,
    hasImplementationProvider: () => false,
    hasDefinitionProvider: () => false,
    hasReferenceProvider: () => false,
    _providersEmitter: onDidChangeProviders,
  }
}

interface FakeFolder {
  scheme: string
  authority?: string
}

function makeWorkspaceStub() {
  const change = new Emitter<{ folder: FakeFolder } | null>()
  let current: { folder: FakeFolder } | null = null
  return {
    get current() {
      return current
    },
    onDidChangeWorkspace: change.event,
    setCurrent(next: { folder: FakeFolder } | null) {
      current = next
      change.fire(next)
    },
  }
}

interface FakeEditor {
  id: string
  isDirty?: boolean
}

interface FakeGroup {
  index: number
  count: number
  activeEditor: FakeEditor | undefined
  editors: FakeEditor[]
  isFirst(e: FakeEditor): boolean
  isLast(e: FakeEditor): boolean
  onDidChangeModel: Emitter<void>['event']
  onDidActiveEditorChange: Emitter<void>['event']
  _modelEmitter: Emitter<void>
  _activeEmitter: Emitter<void>
}

function makeGroup(index: number, editors: FakeEditor[]): FakeGroup {
  const modelEmitter = new Emitter<void>()
  const activeEmitter = new Emitter<void>()
  const arr = [...editors]
  return {
    index,
    get count() {
      return arr.length
    },
    get editors() {
      return arr
    },
    get activeEditor() {
      return arr[0]
    },
    isFirst: (e: FakeEditor) => arr.indexOf(e) === 0,
    isLast: (e: FakeEditor) => arr.indexOf(e) === arr.length - 1,
    onDidChangeModel: modelEmitter.event,
    onDidActiveEditorChange: activeEmitter.event,
    _modelEmitter: modelEmitter,
    _activeEmitter: activeEmitter,
  }
}

function makeGroupsStub(groups: FakeGroup[] = [makeGroup(0, [])]) {
  const activeGroupChange = new Emitter<unknown>()
  const addGroup = new Emitter<unknown>()
  const removeGroup = new Emitter<unknown>()
  const moveGroup = new Emitter<unknown>()
  let active = groups[0]!
  return {
    get activeGroup() {
      return active
    },
    get groups() {
      return groups
    },
    setActive(g: FakeGroup) {
      active = g
      activeGroupChange.fire(g)
    },
    onDidActiveGroupChange: activeGroupChange.event,
    onDidAddGroup: addGroup.event,
    onDidRemoveGroup: removeGroup.event,
    onDidMoveGroup: moveGroup.event,
    _addGroup: addGroup,
    _removeGroup: removeGroup,
    _moveGroup: moveGroup,
  }
}

describe('ContextKeyContribution', () => {
  let contribution: ContextKeyContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('seeds platform keys: exactly one of isWindows/isMac/isLinux is true', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('darwin') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('isWindows')).toBe(false)
    expect(ctx.get('isMac')).toBe(true)
    expect(ctx.get('isLinux')).toBe(false)
    ctx.dispose()
  })

  it('reflects initial Part visibility', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub({ [PartId.SideBar]: true, [PartId.Panel]: false }) as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('activityBarVisible')).toBe(true)
    expect(ctx.get('sideBarVisible')).toBe(true)
    expect(ctx.get('panelVisible')).toBe(false)
    ctx.dispose()
  })

  it('synchronises activityBarVisible when LayoutService.visible changes', () => {
    const ctx = new ContextKeyService()
    const layout = makeLayoutStub({ [PartId.ActivityBar]: true })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('linux') as never,
      layout as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('activityBarVisible')).toBe(true)
    layout.visible.set({ ...layout.visible.get(), [PartId.ActivityBar]: false }, undefined)
    expect(ctx.get('activityBarVisible')).toBe(false)
    ctx.dispose()
  })

  it('synchronises sideBarVisible when LayoutService.visible changes', () => {
    const ctx = new ContextKeyService()
    const layout = makeLayoutStub({ [PartId.SideBar]: true })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('linux') as never,
      layout as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('sideBarVisible')).toBe(true)
    layout.visible.set({ ...layout.visible.get(), [PartId.SideBar]: false }, undefined)
    expect(ctx.get('sideBarVisible')).toBe(false)
    ctx.dispose()
  })

  it('synchronises activeEditorId / hasActiveEditor on editor change', () => {
    const ctx = new ContextKeyService()
    const editor = makeEditorStub()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      editor as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('hasActiveEditor')).toBe(false)
    expect(ctx.get('activeEditorId')).toBeUndefined()
    editor.activeEditor.set({ id: 'file:///a.lua' }, undefined)
    expect(ctx.get('hasActiveEditor')).toBe(true)
    expect(ctx.get('activeEditorId')).toBe('file:///a.lua')
    ctx.dispose()
  })

  it('exposes diffEditorHasOpenableFile on the root service for keybindings', () => {
    // The per-group scoped service sets this key too, but keybinding `when` and
    // Action2 preconditions resolve against the root one — a scoped-only key
    // reads as unset there and the shortcut silently never fires.
    const ctx = new ContextKeyService()
    const editor = makeEditorStub()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      editor as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('diffEditorHasOpenableFile')).toBe(false)

    const openable = URI.file('/repo/a.ts')
    editor.activeEditor.set(
      new DiffEditorInput(openable, 'head', 'work', undefined, openable, true, makeFileService()),
      undefined,
    )
    expect(ctx.get('isInDiffEditor')).toBe(true)
    expect(ctx.get('diffEditorHasOpenableFile')).toBe(true)
    ctx.dispose()
  })

  it('leaves diffEditorHasOpenableFile false for a diff with no source file', () => {
    // Depot / revision blob diffs and Explorer cross-file compares have no
    // openable resource — "Open File" must stay unavailable for them.
    const ctx = new ContextKeyService()
    const editor = makeEditorStub()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      editor as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )

    const blob = URI.parse('perforce://depot/a.ts@3')
    editor.activeEditor.set(
      new DiffEditorInput(blob, 'r3', 'r4', undefined, undefined, false, makeFileService()),
      undefined,
    )
    expect(ctx.get('isInDiffEditor')).toBe(true)
    expect(ctx.get('diffEditorHasOpenableFile')).toBe(false)

    // Switching back to a plain file clears it rather than leaving it stuck on.
    editor.activeEditor.set({ id: 'file:///repo/a.ts' }, undefined)
    expect(ctx.get('isInDiffEditor')).toBe(false)
    expect(ctx.get('diffEditorHasOpenableFile')).toBe(false)
    ctx.dispose()
  })

  it('seeds VSCode-parity editor keys with defaults', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('editorTextFocus')).toBe(false)
    expect(ctx.get('editorLangId')).toBe('')
    expect(ctx.get('editorReadonly')).toBe(false)
    expect(ctx.get('editorHasDefinitionProvider')).toBe(false)
    expect(ctx.get('editorHasImplementationProvider')).toBe(false)
    expect(ctx.get('editorHasReferenceProvider')).toBe(false)
    expect(ctx.get('editorHasCodeActionsProvider')).toBe(false)
    expect(ctx.get('isInEmbeddedEditor')).toBe(false)
    expect(ctx.get('inReferenceSearchEditor')).toBe(false)
    ctx.dispose()
  })

  it('editorLangId follows the active FileEditorInput language change', () => {
    const ctx = new ContextKeyService()
    const editor = makeFileEditorStub()
    const input = new FileEditorInput(URI.file('/ws/a.md'), makeFileService())
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      editor as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    editor.activeEditor.set(input, undefined)
    expect(ctx.get('editorLangId')).toBe('markdown')
    const model = makeFakeModel('markdown')
    bindModel(input, model)
    model.language = 'python'
    model.emitter.fire({ newLanguage: 'python' })
    expect(ctx.get('editorLangId')).toBe('python')
    ctx.dispose()
    input.dispose()
  })

  it('editorLangId stops following a previous input after switching editors', () => {
    const ctx = new ContextKeyService()
    const editor = makeFileEditorStub()
    const first = new FileEditorInput(URI.file('/ws/a.md'), makeFileService())
    const second = new FileEditorInput(URI.file('/ws/b.json'), makeFileService())
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      editor as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    editor.activeEditor.set(first, undefined)
    editor.activeEditor.set(second, undefined)
    expect(ctx.get('editorLangId')).toBe('json')
    const model = makeFakeModel('markdown')
    bindModel(first, model)
    model.language = 'python'
    model.emitter.fire({ newLanguage: 'python' })
    expect(ctx.get('editorLangId')).toBe('json')
    ctx.dispose()
    first.dispose()
    second.dispose()
  })

  it('sets workbenchReady once the Ready phase is reached', async () => {
    const ctx = new ContextKeyService()
    const lifecycle = new LifecycleService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      lifecycle,
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('workbenchReady')).toBe(false)
    lifecycle.setPhase(LifecyclePhase.Ready)
    await lifecycle.when(LifecyclePhase.Ready)
    expect(ctx.get('workbenchReady')).toBe(true)
    ctx.dispose()
  })

  it('sets workbenchRestored once the Restored phase is reached', async () => {
    const ctx = new ContextKeyService()
    const lifecycle = new LifecycleService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      lifecycle,
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('workbenchRestored')).toBe(false)
    lifecycle.setPhase(LifecyclePhase.Restored)
    await lifecycle.when(LifecyclePhase.Restored)
    expect(ctx.get('workbenchRestored')).toBe(true)
    ctx.dispose()
  })

  // ---- group-level keys --------------------------------------------------

  it('editorPartMultipleEditorGroups reflects group count', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('editorPartMultipleEditorGroups')).toBe(false)
    groups.groups.push(makeGroup(1, []))
    groups._addGroup.fire({})
    expect(ctx.get('editorPartMultipleEditorGroups')).toBe(true)
    ctx.dispose()
  })

  it('editorIsOpen reflects any group having editors', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('editorIsOpen')).toBe(false)
    g0.editors.push({ id: 'a' })
    g0._modelEmitter.fire()
    expect(ctx.get('editorIsOpen')).toBe(true)
    ctx.dispose()
  })

  it('groupEditorsCount reflects active group count', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [{ id: 'a' }, { id: 'b' }])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('groupEditorsCount')).toBe(2)
    ctx.dispose()
  })

  it('activeEditorGroupIndex reflects active group index', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [])
    const g1 = makeGroup(1, [])
    const groups = makeGroupsStub([g0, g1])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('activeEditorGroupIndex')).toBe(0)
    groups.setActive(g1)
    expect(ctx.get('activeEditorGroupIndex')).toBe(1)
    ctx.dispose()
  })

  it('activeEditorIsFirstInGroup / activeEditorIsLastInGroup reflect position', () => {
    const ctx = new ContextKeyService()
    const a = { id: 'a' }
    const g0 = makeGroup(0, [a])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('activeEditorIsFirstInGroup')).toBe(true)
    expect(ctx.get('activeEditorIsLastInGroup')).toBe(true)
    ctx.dispose()
  })

  it('activeEditorIsDirty reflects dirty state', () => {
    const ctx = new ContextKeyService()
    const a = { id: 'a', isDirty: true }
    const g0 = makeGroup(0, [a])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('activeEditorIsDirty')).toBe(true)
    ctx.dispose()
  })

  // ---- remote workspace keys -------------------------------------------

  it('seeds remote workspace keys as false for a local / empty workspace', () => {
    const ctx = new ContextKeyService()
    const workspace = makeWorkspaceStub()
    workspace.setCurrent({ folder: { scheme: 'file', authority: '' } })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      workspace as never,
    )
    expect(ctx.get('isRemoteWorkspace')).toBe(false)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(false)
    ctx.dispose()
  })

  it('seeds remote workspace keys as false when no workspace is open', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      makeWorkspaceStub() as never,
    )
    expect(ctx.get('isRemoteWorkspace')).toBe(false)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(false)
    ctx.dispose()
  })

  it('sets both keys for a WSL remote workspace on a Windows client', () => {
    const ctx = new ContextKeyService()
    const workspace = makeWorkspaceStub()
    workspace.setCurrent({ folder: { scheme: 'remote-ssh', authority: 'wsl+ubuntu-24.04' } })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      workspace as never,
    )
    expect(ctx.get('isRemoteWorkspace')).toBe(true)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(true)
    ctx.dispose()
  })

  it('keeps remoteRevealInOsSupported false for a WSL remote on a non-Windows client', () => {
    const ctx = new ContextKeyService()
    const workspace = makeWorkspaceStub()
    workspace.setCurrent({ folder: { scheme: 'remote-ssh', authority: 'wsl+ubuntu-24.04' } })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('linux') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      workspace as never,
    )
    expect(ctx.get('isRemoteWorkspace')).toBe(true)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(false)
    ctx.dispose()
  })

  it('keeps remoteRevealInOsSupported false for a non-WSL remote authority', () => {
    const ctx = new ContextKeyService()
    const workspace = makeWorkspaceStub()
    workspace.setCurrent({ folder: { scheme: 'remote-ssh', authority: 'user@host:22' } })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      workspace as never,
    )
    expect(ctx.get('isRemoteWorkspace')).toBe(true)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(false)
    ctx.dispose()
  })

  it('updates the remote workspace keys when the workspace changes', () => {
    const ctx = new ContextKeyService()
    const workspace = makeWorkspaceStub()
    workspace.setCurrent({ folder: { scheme: 'file', authority: '' } })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
      makeLanguageFeaturesStub() as never,
      workspace as never,
    )
    expect(ctx.get('isRemoteWorkspace')).toBe(false)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(false)

    workspace.setCurrent({ folder: { scheme: 'remote-ssh', authority: 'wsl+debian' } })
    expect(ctx.get('isRemoteWorkspace')).toBe(true)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(true)

    workspace.setCurrent(null)
    expect(ctx.get('isRemoteWorkspace')).toBe(false)
    expect(ctx.get('remoteRevealInOsSupported')).toBe(false)
    ctx.dispose()
  })
})
