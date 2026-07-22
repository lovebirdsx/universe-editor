import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  IHostService,
  ILayoutService,
  IWorkspaceService,
  InstantiationService,
  PartId,
  ServiceCollection,
  URI,
  constObservable,
  type IWorkspace,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { IUpdateService } from '../../../../shared/ipc/updateService.js'
import { ServicesContext } from '../../useService.js'
import { TitleBar } from '../TitleBar.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFs(): IFileService {
  return {
    _serviceBrand: undefined,
    readFileText: async () => '',
    writeFile: async () => {},
    stat: async () => ({
      resource: URI.file('/'),
      isFile: true,
      isDirectory: false,
      size: 0,
      mtime: 0,
    }),
    exists: async () => false,
    list: async () => [],
    createDirectory: async () => {},
    delete: async () => {},
    rename: async () => {},
  } as unknown as IFileService
}

function makeHostService(platform: 'win32' | 'darwin' | 'linux' = 'win32'): IHostService {
  return {
    _serviceBrand: undefined,
    platform,
    onDidChangeMaximized: () => ({ dispose: () => {} }),
    isMaximized: async () => false,
    minimizeWindow: async () => {},
    toggleMaximizeWindow: async () => {},
    closeWindow: async () => {},
    toggleDevTools: async () => {},
    showOpenFileDialog: async () => null,
    showSaveFileDialog: async () => null,
  } as unknown as IHostService
}

function makeWorkspaceService(workspace: IWorkspace | null = null): IWorkspaceService {
  return {
    _serviceBrand: undefined,
    current: workspace,
    onDidChangeWorkspace: () => ({ dispose: () => {} }),
    recent: [],
    onDidChangeRecent: () => ({ dispose: () => {} }),
    openFolder: async () => {},
    closeFolder: async () => {},
    clearRecent: async () => {},
  } as unknown as IWorkspaceService
}

function makeLayoutService(): ILayoutService {
  const allVisible = {
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.SecondarySideBar]: false,
    [PartId.EditorArea]: true,
    [PartId.Panel]: false,
    [PartId.StatusBar]: true,
  }
  return {
    _serviceBrand: undefined,
    visible: constObservable(allVisible),
    toggleVisible: () => {},
    getVisible: () => true,
    setVisible: () => {},
  } as unknown as ILayoutService
}

function makeContainer(
  groupsService: EditorGroupsService,
  opts: { platform?: 'win32' | 'darwin' | 'linux'; workspace?: IWorkspace | null } = {},
): InstantiationService {
  const sc = new ServiceCollection()
  sc.set(IHostService, makeHostService(opts.platform ?? 'win32'))
  sc.set(IWorkspaceService, makeWorkspaceService(opts.workspace ?? null))
  sc.set(IEditorGroupsService, groupsService)
  sc.set(IFileService, makeFs())
  sc.set(IContextKeyService, new ContextKeyService())
  sc.set(ILayoutService, makeLayoutService())
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  } as unknown as ICommandService)
  sc.set(IUpdateService, {
    _serviceBrand: undefined,
    onDidChangeState: () => ({ dispose: () => {} }),
    getState: async () => ({ type: 'idle', currentVersion: '0.0.0' }),
    checkForUpdates: async () => {},
    downloadUpdate: async () => {},
    quitAndInstall: async () => {},
  } as unknown as IUpdateService)
  return new InstantiationService(sc)
}

function titleText(): string {
  return screen.getByTestId('titlebar-title').textContent ?? ''
}

class VirtualEditorInput extends EditorInput {
  override get typeId(): string {
    return 'virtual'
  }
  override get resource(): undefined {
    return undefined
  }
  override getName(): string {
    return 'Settings'
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let svc: EditorGroupsService

beforeEach(() => {
  svc = new EditorGroupsService()
})

afterEach(() => {
  svc.dispose()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TitleBar — title text', () => {
  it('shows an empty title when there is no workspace and no open file', () => {
    render(
      <ServicesContext.Provider value={makeContainer(svc)}>
        <TitleBar />
      </ServicesContext.Provider>,
    )
    expect(titleText()).toBe('')
  })

  it('shows workspace name when a workspace is open but no file', () => {
    const workspace: IWorkspace = { folder: URI.file('/my/project'), name: 'project' }
    render(
      <ServicesContext.Provider value={makeContainer(svc, { workspace })}>
        <TitleBar />
      </ServicesContext.Provider>,
    )
    expect(titleText()).toBe('project')
  })

  it('shows the full path when a file is open without a workspace', () => {
    const inst = makeContainer(svc)
    const input = inst.createInstance(FileEditorInput, URI.file('/home/user/project/src/main.ts'))
    svc.activeGroup.openEditor(input)

    render(
      <ServicesContext.Provider value={inst}>
        <TitleBar />
      </ServicesContext.Provider>,
    )

    expect(titleText()).toBe('/home/user/project/src/main.ts')
  })

  it('shows the workspace-relative path and workspace path for an in-workspace file', () => {
    const workspace: IWorkspace = { folder: URI.file('/my/project'), name: 'project' }
    const inst = makeContainer(svc, { workspace })
    const input = inst.createInstance(FileEditorInput, URI.file('/my/project/src/main.ts'))
    svc.activeGroup.openEditor(input)

    render(
      <ServicesContext.Provider value={inst}>
        <TitleBar />
      </ServicesContext.Provider>,
    )

    expect(titleText()).toBe('src/main.ts — /my/project')
  })

  it('shows the full path and workspace path for a file outside the workspace', () => {
    const workspace: IWorkspace = { folder: URI.file('/my/project'), name: 'project' }
    const inst = makeContainer(svc, { workspace })
    const input = inst.createInstance(FileEditorInput, URI.file('/other/place/foo.txt'))
    svc.activeGroup.openEditor(input)

    render(
      <ServicesContext.Provider value={inst}>
        <TitleBar />
      </ServicesContext.Provider>,
    )

    expect(titleText()).toBe('/other/place/foo.txt — /my/project')
  })

  it('shows the editor name and workspace path for a non-file editor', () => {
    const workspace: IWorkspace = { folder: URI.file('/my/project'), name: 'project' }
    const inst = makeContainer(svc, { workspace })
    svc.activeGroup.openEditor(new VirtualEditorInput())

    render(
      <ServicesContext.Provider value={inst}>
        <TitleBar />
      </ServicesContext.Provider>,
    )

    expect(titleText()).toBe('Settings — /my/project')
  })

  it('prefixes a dirty dot when the active editor has unsaved changes', () => {
    const workspace: IWorkspace = { folder: URI.file('/my/project'), name: 'project' }
    const inst = makeContainer(svc, { workspace })
    const input = inst.createInstance(FileEditorInput, URI.file('/my/project/file.ts'))
    svc.activeGroup.openEditor(input)

    render(
      <ServicesContext.Provider value={inst}>
        <TitleBar />
      </ServicesContext.Provider>,
    )

    expect(titleText()).toBe('file.ts — /my/project')

    act(() => {
      input.setDirty(true)
    })

    expect(titleText()).toBe('● file.ts — /my/project')

    act(() => {
      input.setDirty(false)
    })

    expect(titleText()).toBe('file.ts — /my/project')
  })

  it('updates the title when the active editor changes', () => {
    const workspace: IWorkspace = { folder: URI.file('/my/project'), name: 'project' }
    const inst = makeContainer(svc, { workspace })
    const a = inst.createInstance(FileEditorInput, URI.file('/my/project/alpha.ts'))
    const b = inst.createInstance(FileEditorInput, URI.file('/other/beta.ts'))
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)

    render(
      <ServicesContext.Provider value={inst}>
        <TitleBar />
      </ServicesContext.Provider>,
    )

    expect(titleText()).toBe('/other/beta.ts — /my/project')

    act(() => {
      svc.activeGroup.setActive(a)
    })

    expect(titleText()).toBe('alpha.ts — /my/project')
  })

  it('falls back to workspace name when the last file is closed', () => {
    const workspace: IWorkspace = { folder: URI.file('/my/project'), name: 'project' }
    const inst = makeContainer(svc, { workspace })
    const input = inst.createInstance(FileEditorInput, URI.file('/my/project/file.ts'))
    svc.activeGroup.openEditor(input)

    render(
      <ServicesContext.Provider value={inst}>
        <TitleBar />
      </ServicesContext.Provider>,
    )

    expect(titleText()).toBe('file.ts — /my/project')

    act(() => {
      svc.activeGroup.closeEditor(input)
    })

    expect(titleText()).toBe('project')
  })
})
