/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  ReleaseNotesInput — a virtual EditorInput holding release notes (no disk file).
 *  Each note carries the version markdown source; the editor renders one section per
 *  version. `key` distinguishes the "what's new" tab (opened on upgrade) from the
 *  "all versions" tab (opened via command), so each reuses its own tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'
import type { IReleaseNote } from '../../../shared/ipc/releaseNotesService.js'

export const RELEASE_NOTES_SCHEMA = 2

interface ISerializedReleaseNotes {
  readonly schema: number
  readonly notes: readonly IReleaseNote[]
  readonly title: string
  readonly key: string
}

/** Pre-schema-2 tab: the caller had already rendered the notes to markdown. */
interface ILegacySerializedReleaseNotes {
  readonly markdown: string
  readonly title: string
  readonly key: string
}

/** Shape check for a note that came back from persisted editor state. */
function toReleaseNote(value: unknown): IReleaseNote | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const note = value as Record<string, unknown>
  if (typeof note['version'] !== 'string') return undefined
  if (typeof note['title'] !== 'string') return undefined
  if (typeof note['summary'] !== 'string') return undefined
  if (typeof note['body'] !== 'string') return undefined
  if (note['date'] !== undefined && typeof note['date'] !== 'string') return undefined
  return note['date'] === undefined
    ? {
        version: note['version'],
        title: note['title'],
        summary: note['summary'],
        body: note['body'],
      }
    : {
        version: note['version'],
        date: note['date'] as string,
        title: note['title'],
        summary: note['summary'],
        body: note['body'],
      }
}

export class ReleaseNotesInput extends EditorInput {
  static readonly TYPE_ID = 'releaseNotes'

  constructor(
    private readonly _notes: readonly IReleaseNote[],
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

  get notes(): readonly IReleaseNote[] {
    return this._notes
  }

  get title(): string {
    return this._title
  }

  override serialize(): ISerializedReleaseNotes {
    return { schema: RELEASE_NOTES_SCHEMA, notes: this._notes, title: this._title, key: this._key }
  }

  static deserialize(data: unknown): ReleaseNotesInput | null {
    const d = data as
      | (Partial<ISerializedReleaseNotes> & Partial<ILegacySerializedReleaseNotes>)
      | null
    if (d === null || typeof d !== 'object') return null
    if (typeof d.title !== 'string' || typeof d.key !== 'string') return null
    if (d.schema === RELEASE_NOTES_SCHEMA && Array.isArray(d.notes)) {
      const notes = d.notes.map(toReleaseNote).filter((note): note is IReleaseNote => !!note)
      return new ReleaseNotesInput(notes, d.title, d.key)
    }
    // Legacy tabs (schema 1) persisted pre-rendered markdown — never read it as
    // the new structure. Degrade to one opaque note so a restored tab still renders.
    if (typeof d.markdown === 'string') {
      return new ReleaseNotesInput(
        [{ version: '', title: '', summary: '', body: d.markdown }],
        d.title,
        d.key,
      )
    }
    return null
  }
}
