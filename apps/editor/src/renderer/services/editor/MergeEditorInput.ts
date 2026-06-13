/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  MergeEditorInput — a transient EditorInput driving the 3-way merge editor.
 *  Holds the three git merge stages of a single conflicted file (base / current
 *  / incoming) plus their labels and the working-tree path to write the resolved
 *  result back to. Unlike DiffEditorInput it is editable: the Result pane's text
 *  is owned by the mounted MergeEditor, which calls `setResult` as the user
 *  edits and `save()` to write the file + stage it via the git extension.
 *--------------------------------------------------------------------------------------------*/

import {
  EditorInput,
  Emitter,
  ICommandService,
  IFileService,
  URI,
  type Event,
} from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'

export interface MergeEditorContents {
  /** Absolute working-tree path of the conflicted file. */
  readonly path: string
  /** Common ancestor (git stage :1:), or '' when the file was added on both sides. */
  readonly base: string
  /** Our version (git stage :2:, HEAD). */
  readonly current: string
  /** Their version (git stage :3:, MERGE_HEAD). */
  readonly incoming: string
  /** The working-tree content with git conflict markers — the Result pane's seed. */
  readonly merged: string
  /** Short label for the current side (e.g. `HEAD: <subject>`). */
  readonly currentLabel: string
  /** Short label for the incoming side (e.g. `<branch>: <subject>`). */
  readonly incomingLabel: string
}

export class MergeEditorInput extends EditorInput {
  static readonly TYPE_ID = 'merge'

  private readonly _resource: URI
  private _result: string

  private readonly _onDidChangeContents = this._register(new Emitter<void>())
  /** Fires when the three stages are refreshed in place (e.g. status changed). */
  readonly onDidChangeContents: Event<void> = this._onDidChangeContents.event

  constructor(
    private _contents: MergeEditorContents,
    @IFileService private readonly _fileService: IFileService,
    @ICommandService private readonly _commandService: ICommandService,
  ) {
    super()
    this._resource = URI.from({ scheme: 'merge', path: this._contents.path })
    this._result = this._contents.merged
  }

  override get typeId(): string {
    return MergeEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override get id(): string {
    return `merge:${this._contents.path}`
  }

  override getName(): string {
    return `${basenameOfResource(URI.file(this._contents.path))} (Merge)`
  }

  get contents(): MergeEditorContents {
    return this._contents
  }

  /** A `file:` URI for the conflicted file, used for language detection / labels. */
  get fileUri(): URI {
    return URI.file(this._contents.path)
  }

  /** Track the Result pane's live text so `save()` and dirty state stay in sync. */
  setResult(text: string): void {
    if (this._result === text) return
    this._result = text
    this.setDirty(true)
  }

  get result(): string {
    return this._result
  }

  update(contents: MergeEditorContents): void {
    this._contents = contents
    this._onDidChangeContents.fire()
  }

  override async save(): Promise<boolean> {
    await this._fileService.writeFile(this.fileUri, this._result)
    // Staging the resolved file clears its unmerged state in git.
    await this._commandService.executeCommand('git.stage', {
      resourceUri: this._contents.path,
    })
    this.setDirty(false)
    return true
  }
}
