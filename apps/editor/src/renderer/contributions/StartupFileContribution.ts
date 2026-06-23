import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  URI,
} from '@universe-editor/platform'
import type { IWorkbenchContribution } from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import type { IpcBridge } from '../../preload/index.js'

/**
 * Opens a file that was passed via CLI argv at cold-launch (e.g. double-click in
 * Windows Explorer) or pushed from the main process when a second-instance launches
 * with a file path (app already running).
 */
export class StartupFileContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
  ) {
    super()
    const ipc = (window as { ipc?: IpcBridge }).ipc
    if (!ipc) return

    if (ipc.openFilePath) {
      this._openFile(ipc.openFilePath)
    }

    this._register({ dispose: ipc.onOpenFile((path) => this._openFile(path)) })
  }

  private _openFile(filePath: string): void {
    console.log(`[StartupFileContribution] opening file: ${filePath}`)
    const input = this._instantiation.createInstance(FileEditorInput, URI.file(filePath))
    void this._editorGroups.activeGroup.openEditor(input, { activate: true })
  }
}
