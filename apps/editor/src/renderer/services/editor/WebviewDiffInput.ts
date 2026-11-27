/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WebviewDiffInput — a read-only EditorInput backed by an extension's custom
 *  editor, opened as a two-content comparison (via the internal command
 *  `_workbench.openWebviewDiff`) rather than a single file. Rendered by
 *  CustomEditorHost, which opens a webview panel carrying the two sides' bytes and
 *  hands them to the owning extension's `resolveCustomEditor` as `panel.diffContext`.
 *
 *  Both sides' bytes are persisted as base64 (a Git HEAD blob / Perforce
 *  have-revision may not exist on disk), so history (Alt+←), Ctrl+Shift+T and
 *  workspace restore can rebuild the comparison. CustomEditorHost re-activates
 *  the owning extension on mount, the same path a restored CustomEditorInput
 *  takes. Oversized payloads degrade to contentDropped for workspace
 *  persistence only; same-session reopen keeps the full bytes.
 *
 *  Identity is namespaced by `viewType` + both URIs so a diff stays distinct from
 *  the single-file custom editor of the same resource and from other comparisons.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, type UriComponents } from '@universe-editor/platform'
import { WebviewFocusRegistry } from './WebviewFocusRegistry.js'

export const WEBVIEW_DIFF_PERSIST_BUDGET_BYTES = 256 * 1024

export interface ISerializedWebviewDiff {
  readonly viewType: string
  readonly title: string
  readonly leftUri: UriComponents
  readonly rightUri: UriComponents
  readonly leftBase64: string
  readonly rightBase64: string
  /** Set when workspace persistence dropped the bytes (budget); deserialize
   *  rejects these entries. */
  readonly contentDropped?: boolean
}

/** Chunked so a multi-MB side cannot blow the argument limit of
 *  `String.fromCharCode(...bytes)`. */
const BASE64_CHUNK = 0x8000

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encoded length of one base64 side without building the string. */
function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

export class WebviewDiffInput extends EditorInput {
  static readonly TYPE_ID = 'webviewDiff'

  private _leftBase64: string | undefined
  private _rightBase64: string | undefined

  constructor(
    private readonly _viewType: string,
    private readonly _leftUri: URI,
    private readonly _rightUri: URI,
    private readonly _left: Uint8Array,
    private readonly _right: Uint8Array,
    private readonly _title: string,
  ) {
    super()
  }

  get viewType(): string {
    return this._viewType
  }

  get leftUri(): URI {
    return this._leftUri
  }

  get rightUri(): URI {
    return this._rightUri
  }

  get left(): Uint8Array {
    return this._left
  }

  get right(): Uint8Array {
    return this._right
  }

  get title(): string {
    return this._title
  }

  override get typeId(): string {
    return WebviewDiffInput.TYPE_ID
  }

  /** The right-hand (modified) side is the resource the tab represents (icon, decorations). */
  override get resource(): URI {
    return this._rightUri
  }

  /** Namespaced by viewType + both URIs so the diff stays a distinct tab. */
  override get id(): string {
    return `webviewDiff:${this._viewType}:${this._leftUri.toString()}↔${this._rightUri.toString()}`
  }

  override getName(): string {
    return this._title
  }

  override serialize(): ISerializedWebviewDiff {
    this._leftBase64 ??= bytesToBase64(this._left)
    this._rightBase64 ??= bytesToBase64(this._right)
    return {
      viewType: this._viewType,
      title: this._title,
      leftUri: this._leftUri.toJSON(),
      rightUri: this._rightUri.toJSON(),
      leftBase64: this._leftBase64,
      rightBase64: this._rightBase64,
    }
  }

  serializeForPersistence(maxBytes = WEBVIEW_DIFF_PERSIST_BUDGET_BYTES): ISerializedWebviewDiff {
    // Estimate before encoding so oversized panels never pay the base64 cost
    // just to have the payload dropped by the persistence budget.
    if (base64Length(this._left.byteLength) + base64Length(this._right.byteLength) > maxBytes) {
      return {
        viewType: this._viewType,
        title: this._title,
        leftUri: this._leftUri.toJSON(),
        rightUri: this._rightUri.toJSON(),
        leftBase64: '',
        rightBase64: '',
        contentDropped: true,
      }
    }
    return this.serialize()
  }

  static deserialize(data: unknown): WebviewDiffInput | null {
    const d = data as ISerializedWebviewDiff | null
    if (!d || d.contentDropped) return null
    if (typeof d.viewType !== 'string' || d.viewType.length === 0) return null
    if (typeof d.title !== 'string') return null
    if (typeof d.leftBase64 !== 'string' || typeof d.rightBase64 !== 'string') return null
    const leftUri = URI.revive(d.leftUri)
    const rightUri = URI.revive(d.rightUri)
    if (!leftUri || !rightUri) return null
    try {
      return new WebviewDiffInput(
        d.viewType,
        leftUri,
        rightUri,
        base64ToBytes(d.leftBase64),
        base64ToBytes(d.rightBase64),
        d.title,
      )
    } catch {
      return null
    }
  }

  /** Move keyboard focus into the webview iframe (see CustomEditorInput.focus). */
  override focus(groupId?: number): boolean {
    return WebviewFocusRegistry.requestFocus(this._viewType, this._rightUri, groupId)
  }
}
