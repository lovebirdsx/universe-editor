/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ReleaseNotesInput — a virtual EditorInput holding pre-rendered markdown (no
 *  disk file). `key` distinguishes the "what's new" tab (opened on upgrade) from
 *  the "all versions" tab (opened via command), so each reuses its own tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

interface ISerializedReleaseNotes {
  readonly markdown: string
  readonly title: string
  readonly key: string
}

export class ReleaseNotesInput extends EditorInput {
  static readonly TYPE_ID = 'releaseNotes'

  constructor(
    private readonly _markdown: string,
    private readonly _title: string,
    private readonly _key: string,
  ) {
    super()
  }

  override get typeId(): string {
    return ReleaseNotesInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'release-notes', path: `/${this._key}` })
  }

  override get id(): string {
    return `release-notes:${this._key}`
  }

  override getName(): string {
    return this._title
  }

  get markdown(): string {
    return this._markdown
  }

  get title(): string {
    return this._title
  }

  override serialize(): ISerializedReleaseNotes {
    return { markdown: this._markdown, title: this._title, key: this._key }
  }

  static deserialize(data: unknown): ReleaseNotesInput | null {
    const d = data as ISerializedReleaseNotes | null
    if (!d || typeof d.markdown !== 'string') return null
    return new ReleaseNotesInput(d.markdown, d.title, d.key)
  }
}
