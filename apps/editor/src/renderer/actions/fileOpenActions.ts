/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Open / OpenRecent / OpenWithDefaultApp / ClearRecent / Refresh actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorGroupsService,
  IFileSearchService,
  IFileService,
  IHostService,
  IInstantiationService,
  IQuickInputService,
  IWorkspaceService,
  MenuId,
  URI,
  localize,
  DisposableStore,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IRecentFilesService } from '../services/recentFiles/recentFilesService.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { confirmLargeFile } from '../services/editor/largeFileGuard.js'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { IExcludeService } from '../services/exclude/ExcludeService.js'
import { parentOf } from '../services/explorer/explorerTreeUtils.js'
import { reviveUri, type ITargetArg } from './fileActionsCommon.js'

export class OpenFileAction extends Action2 {
  static readonly ID = 'workbench.action.files.openFile'
  constructor() {
    super({
      id: OpenFileAction.ID,
      title: localize('action.openFile.title', 'Open File…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+o' },
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 0 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const host = accessor.get(IHostService)
    const workspace = accessor.get(IWorkspaceService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const fileService = accessor.get(IFileService)
    const dialog = accessor.get(IDialogService)

    const picked = reviveUri(
      await host.showOpenFileDialog({
        ...(workspace.current ? { defaultPath: workspace.current.folder.fsPath } : {}),
      }),
    )
    if (!picked) return
    if (!(await confirmLargeFile(picked, fileService, dialog))) return
    const input = inst.createInstance(FileEditorInput, picked)
    groups.activeGroup.openEditor(input, { activate: true })
  }
}

export class OpenRecentFilesAction extends Action2 {
  static readonly ID = 'workbench.action.openRecentFile'
  constructor() {
    super({
      id: OpenRecentFilesAction.ID,
      title: localize('action.openRecentFile.title', 'Open Recent File…'),
      category: localize('command.category.file', 'File'),
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 3 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const recentFiles = accessor.get(IRecentFilesService)
    const quickInput = accessor.get(IQuickInputService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)

    const items = await recentFiles.getAll()
    if (items.length === 0) return

    const pickItems = items.map((f) => ({
      id: f.uri.toString(),
      label: f.name,
      description: f.uri.fsPath,
    }))

    const pick = await quickInput.pick(pickItems, {
      id: 'workbench.recentFiles',
      placeholder: localize('quickInput.openRecentFile.placeholder', 'Open Recent File…'),
      matchOnDescription: true,
    })
    if (!pick) return

    const uri = URI.parse(pick.id)

    // Activate if already open in any group.
    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput && editor.resource.toString() === uri.toString()) {
          groups.activateGroup(group)
          group.setActive(editor)
          return
        }
      }
    }

    const input = inst.createInstance(FileEditorInput, uri)
    groups.activeGroup.openEditor(input, { activate: true })
  }
}

export class ClearRecentFilesAction extends Action2 {
  static readonly ID = 'workbench.action.clearRecentFiles'
  constructor() {
    super({
      id: ClearRecentFilesAction.ID,
      title: localize('action.clearRecentFiles.title', 'Clear Recently Opened Files'),
      category: localize('command.category.file', 'File'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IRecentFilesService).clear()
  }
}

export class OpenWithDefaultAppAction extends Action2 {
  static readonly ID = 'workbench.files.action.openWithDefaultApp'
  constructor() {
    super({
      id: OpenWithDefaultAppAction.ID,
      title: localize('action.openWithDefaultApplication.title', 'Open with Default Application'),
      category: localize('command.category.file', 'File'),
      f1: false,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const target = reviveUri((args[0] as ITargetArg | undefined)?.target ?? null)
    if (!target) return
    const host = accessor.get(IHostService)
    const err = await host.openWithDefaultApp(target.fsPath)
    if (err) {
      const dialog = accessor.get(IDialogService)
      await dialog.confirm({
        message: localize('dialog.file.open.error', 'Unable to open file'),
        detail: err,
        type: 'error',
      })
    }
  }
}

const GO_TO_FILE_MAX_RESULTS = 512
const GO_TO_FILE_SEARCH_DELAY_MS = 200

function workspaceRelativePath(root: URI, uri: URI): string {
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')
  const norm = uri.fsPath.replace(/\\/g, '/')
  return norm.startsWith(rootPath + '/') ? norm.slice(rootPath.length + 1) : uri.fsPath
}

function createFilePick(root: URI, uri: URI, labelOverride?: string): IQuickPickItem {
  const rel = workspaceRelativePath(root, uri)
  const label = labelOverride ?? rel.split(/[/\\]/).at(-1) ?? uri.fsPath
  return { id: uri.toString(), label, description: rel }
}

function isUriInsideRoot(root: URI, uri: URI): boolean {
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const path = uri.fsPath.replace(/\\/g, '/').toLowerCase()
  return path === rootPath || path.startsWith(rootPath + '/')
}

export class GoToFileAction extends Action2 {
  static readonly ID = 'workbench.action.quickOpen'
  constructor() {
    super({
      id: GoToFileAction.ID,
      title: localize('action.goToFile.title', 'Go to File…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+p', when: '!terminalFocus' },
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 1 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const workspace = accessor.get(IWorkspaceService)
    const fileSearch = accessor.get(IFileSearchService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const recentFiles = accessor.get(IRecentFilesService)
    const exclude = accessor.get(IExcludeService)

    const root = workspace.current?.folder

    // No workspace open — fall back to recent files.
    if (!root) {
      const all = await recentFiles.getAll()
      if (all.length === 0) return
      const items = all.map((f) => ({
        id: f.uri.toString(),
        label: f.name,
        description: f.uri.fsPath,
      }))
      const pick = await quickInput.pick(items, {
        id: 'workbench.recentFiles',
        placeholder: localize('quickInput.openRecentFile.placeholder', 'Open Recent File…'),
        matchOnDescription: true,
      })
      if (!pick) return
      const uri = URI.parse(pick.id)
      for (const group of groups.groups) {
        for (const editor of group.editors) {
          if (editor instanceof FileEditorInput && editor.resource.toString() === uri.toString()) {
            groups.activateGroup(group)
            group.setActive(editor)
            return
          }
        }
      }
      const input = inst.createInstance(FileEditorInput, uri)
      groups.activeGroup.openEditor(input, { activate: true })
      return
    }

    const recent = await recentFiles.getAll()
    const recentItems = recent
      .filter((f) => isUriInsideRoot(root, f.uri))
      .map((f) => createFilePick(root, f.uri, f.name))

    const picker = quickInput.createQuickPick<IQuickPickItem>()
    picker.placeholder = localize('quickInput.goToFile.placeholder', 'Go to File…')
    picker.filterExternally = true
    picker.items = recentItems

    await new Promise<void>((resolve) => {
      const store = new DisposableStore()
      let timer: ReturnType<typeof setTimeout> | undefined
      let requestSeq = 0
      let accepted = false
      let didResolve = false

      const cleanup = (): void => {
        requestSeq++
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        store.dispose()
        picker.dispose()
      }

      const resolveOnce = (): void => {
        if (didResolve) return
        didResolve = true
        cleanup()
        resolve()
      }

      const openPick = async (pick: IQuickPickItem): Promise<void> => {
        const uri = URI.parse(pick.id)
        recentFiles.add(uri, pick.label)
        for (const group of groups.groups) {
          for (const editor of group.editors) {
            if (
              editor instanceof FileEditorInput &&
              editor.resource.toString() === uri.toString()
            ) {
              groups.activateGroup(group)
              group.setActive(editor)
              return
            }
          }
        }
        const input = inst.createInstance(FileEditorInput, uri)
        groups.activeGroup.openEditor(input, { activate: true, pinned: true })
      }

      const runSearch = async (value: string): Promise<void> => {
        const seq = ++requestSeq
        const pattern = value.trim()
        if (pattern.length === 0) {
          picker.busy = false
          picker.items = recentItems
          return
        }

        picker.busy = true
        try {
          const complete = await fileSearch.search({
            root,
            pattern,
            excludes: exclude.getSearchExcludeGlobs(),
            ignore: exclude.getDirNameIgnores(),
            maxResults: GO_TO_FILE_MAX_RESULTS,
            includeExactPathMatches: true,
          })
          if (seq !== requestSeq) return
          picker.items = complete.results.map((match) => ({
            id: URI.revive(match.resource)!.toString(),
            label: match.basename,
            description: match.relativePath,
          }))
        } finally {
          if (seq === requestSeq) picker.busy = false
        }
      }

      const scheduleSearch = (value: string): void => {
        if (timer !== undefined) clearTimeout(timer)
        if (value.trim().length === 0) {
          void runSearch(value)
          return
        }
        timer = setTimeout(() => {
          timer = undefined
          void runSearch(value)
        }, GO_TO_FILE_SEARCH_DELAY_MS)
      }

      store.add(picker.onDidChangeValue(scheduleSearch))
      store.add(
        picker.onDidAccept((items) => {
          const pick = items[0]
          if (!pick) return
          accepted = true
          void openPick(pick).finally(resolveOnce)
        }),
      )
      store.add(
        picker.onDidHide(() => {
          if (!accepted) resolveOnce()
        }),
      )

      picker.show()
      scheduleSearch('')
    })
  }
}

export class RefreshExplorerAction extends Action2 {
  static readonly ID = 'workbench.files.action.refresh'
  constructor() {
    super({
      id: RefreshExplorerAction.ID,
      title: localize('action.refresh.title', 'Refresh Explorer'),
      category: localize('command.category.file', 'File'),
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const arg = args[0] as ITargetArg | undefined
    const resourceArg = reviveUri(arg?.resource ?? null)
    const parentArg = reviveUri(arg?.parent ?? null)
    const resource = resourceArg
      ? arg?.isDirectory === true
        ? resourceArg
        : (parentArg ?? parentOf(resourceArg) ?? resourceArg)
      : tree.root
    if (!resource) return
    await tree.refresh(resource)
  }
}
