/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmDiffEditorInput — a virtual EditorInput for one file's diff inside a Swarm
 *  review, carrying the review id, depot path, both diff sides' text, and the two
 *  version numbers being compared. Unlike the generic DiffEditorInput, this input
 *  keeps the review/version/file context that the inline-comment layer needs to
 *  anchor comments (Swarm context.leftLine/rightLine + version). The identity is
 *  keyed on review + file + version pair so distinct comparisons never dedupe into
 *  one tab (see memory `editor-input-identity-isolation`).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { DiffEditorInput } from './DiffEditorInput.js'

export interface SwarmDiffContext {
  readonly reviewId: string
  readonly depotFile: string
  readonly displayPath: string
  /** Current client workspace path, or null when the depot file is not mapped. */
  readonly localPath: string | null
  /** Left side: 0 = review base, 1+ = review version, null = file absent. */
  readonly leftVersion: number | null
  /** Right (target) side version number, or null for a deleted file. */
  readonly rightVersion: number | null
}

function swarmFileUri(context: SwarmDiffContext): URI {
  return URI.from({ scheme: 'swarm', path: `/${context.displayPath}` })
}

export class SwarmDiffEditorInput extends DiffEditorInput {
  static readonly TYPE_ID: string = 'swarmDiff'

  constructor(
    private readonly _context: SwarmDiffContext,
    originalContent: string,
    modifiedContent: string,
  ) {
    super(
      swarmFileUri(_context),
      originalContent,
      modifiedContent,
      undefined,
      _context.localPath ? URI.file(_context.localPath) : undefined,
    )
  }

  get context(): SwarmDiffContext {
    return this._context
  }

  /** A file: URI over the display path, used for language detection + labels. */
  get fileUri(): URI {
    return this.originalUri
  }

  override get typeId(): string {
    return SwarmDiffEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({
      scheme: 'swarm-diff',
      path: `/${this._context.reviewId}/${this._context.displayPath}`,
      query: `l=${this._context.leftVersion ?? ''}&r=${this._context.rightVersion ?? ''}`,
    })
  }

  override get id(): string {
    return `swarmDiff:${this._context.reviewId}:${this._context.depotFile}:${this._context.leftVersion ?? ''}-${this._context.rightVersion ?? ''}`
  }

  override getName(): string {
    const base = this._context.displayPath.split('/').pop() ?? this._context.displayPath
    const l =
      this._context.leftVersion === 0
        ? 'base'
        : this._context.leftVersion !== null
          ? `v${this._context.leftVersion}`
          : '∅'
    const r = this._context.rightVersion !== null ? `v${this._context.rightVersion}` : '∅'
    return `${base} (${l} ↔ ${r})`
  }
}
