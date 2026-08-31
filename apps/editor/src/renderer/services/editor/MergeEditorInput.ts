/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  MergeEditorInput — a transient EditorInput driving the 3-way merge editor.
 *  Holds the three merge stages of a single conflicted file (base / current /
 *  incoming) plus their labels and the working-tree path to write the resolved
 *  result back to. Unlike DiffEditorInput it is editable: the Result pane's text
 *  is owned by the mounted MergeEditor, which calls `setResult` as the user
 *  edits and `save()` to write the file + hand off to the provider's
 *  resolve-completion command.
 *--------------------------------------------------------------------------------------------*/

import {
  EditorInput,
  Emitter,
  ICommandService,
  IFileService,
  IWorkspaceService,
  URI,
  absolutePathToWorkspaceUri,
  type Event,
} from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
import { DidSaveNotification } from '../extensions/DidSaveNotification.js'

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
  /** Provider-side follow-up after the merged result is written (e.g. git stage /
   *  p4 resolve -ay). Falls back to git.stage when unset. */
  readonly saveCommand?: { readonly command: string; readonly arguments?: readonly unknown[] }
}

export class MergeEditorInput extends EditorInput {
  static readonly TYPE_ID = 'merge'

  private readonly _resource: URI
  private readonly _fileUri: URI
  private _result: string

  private readonly _onDidChangeContents = this._register(new Emitter<void>())
  /** Fires when the three stages are refreshed in place (e.g. status changed). */
  readonly onDidChangeContents: Event<void> = this._onDidChangeContents.event

  constructor(
    private _contents: MergeEditorContents,
    @IFileService private readonly _fileService: IFileService,
    @ICommandService private readonly _commandService: ICommandService,
    @IWorkspaceService workspaceService: IWorkspaceService,
  ) {
    super()
    this._resource = URI.from({ scheme: 'merge', path: this._contents.path })
    this._fileUri = absolutePathToWorkspaceUri(
      this._contents.path,
      workspaceService.current?.folder,
    )
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

  /** The conflicted file as a workspace resource URI: `file:` for a local
   *  workspace, `remote-ssh://…` when remote so `save()` writes to the right
   *  machine. Used for language detection / labels. */
  get fileUri(): URI {
    return this._fileUri
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
    // The merge editor works on its own staged models; the written file itself
    // typically has no document in the mirror pipeline, so an open will never
    // arrive to order this notification behind.
    DidSaveNotification.notify(this.fileUri, { expectMirrorOpen: false })
    // Let the provider clear the file's unmerged state its own way: git stages
    // the resolved file, p4 accepts it with `resolve -ay`.
    const follow = this._contents.saveCommand
    if (follow) {
      await this._commandService.executeCommand(follow.command, ...(follow.arguments ?? []))
    } else {
      await this._commandService.executeCommand('git.stage', {
        resourceUri: this._contents.path,
      })
    }
    this.setDirty(false)
    return true
  }
}
