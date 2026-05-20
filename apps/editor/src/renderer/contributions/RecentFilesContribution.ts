import {
  Disposable,
  IEditorGroupsService,
  IWorkbenchContribution,
  type IEditorGroup,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { IRecentFilesService } from '../services/recentFiles/recentFilesService.js'

export class RecentFilesContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IRecentFilesService private readonly _recentFilesService: IRecentFilesService,
    @IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
  ) {
    super()

    // Warm up the in-memory cache on startup.
    void this._recentFilesService.getAll()

    this._trackGroup(this._editorGroupsService.activeGroup)
    this._checkAndRecord()

    this._register(
      this._editorGroupsService.onDidActiveGroupChange((group) => {
        this._trackGroup(group)
        this._checkAndRecord()
      }),
    )
  }

  private _trackGroup(group: IEditorGroup): void {
    this._register(group.onDidActiveEditorChange(() => this._checkAndRecord()))
  }

  private _checkAndRecord(): void {
    const active = this._editorGroupsService.activeGroup.activeEditor
    if (active instanceof FileEditorInput) {
      this._recentFilesService.add(active.resource, active.getName())
    }
  }
}
