/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CustomEditorInput — a read-only EditorInput backed by an extension-contributed
 *  custom editor (`contributes.customEditors`). Rendered by CustomEditorHost,
 *  which mounts a sandboxed webview iframe the owning extension fills over RPC.
 *
 *  Identity is namespaced by `viewType` (like ImageEditorInput namespaces `image:`)
 *  so the same file can be open in its text view and a custom editor at once, and
 *  "Reopen With…" can switch between competing custom editors. `resource` still
 *  returns the real `file:` URI (tab icon / SCM decorations need it). Serialisable
 *  so an open custom-editor tab survives a window restore.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, type UriComponents } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
import { WebviewFocusRegistry } from './WebviewFocusRegistry.js'

interface ISerializedCustomEditor {
  readonly viewType: string
  readonly resource: UriComponents
}

export class CustomEditorInput extends EditorInput {
  static readonly TYPE_ID = 'customEditor'

  constructor(
    private readonly _viewType: string,
    private readonly _resource: URI,
  ) {
    super()
  }

  get viewType(): string {
    return this._viewType
  }

  override get typeId(): string {
    return CustomEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  /** Namespaced by viewType + resource so competing editors stay distinct tabs. */
  override get id(): string {
    return `customEditor:${this._viewType}:${this._resource.toString()}`
  }

  override getName(): string {
    return basenameOfResource(this._resource)
  }

  /**
   * Move keyboard focus into the webview iframe. Without this, `focusEditorInput`
   * falls back to focusing the editor-group body (outside the iframe), so the
   * webview never gets focus on open — the user has to click it. Routed through
   * the registry because the live iframe (WebviewElement) is a React component,
   * and the provider registers async so the controller may not exist yet (the
   * registry queues the request until it does).
   */
  override focus(): boolean {
    return WebviewFocusRegistry.requestFocus(this._viewType, this._resource)
  }

  override serialize(): ISerializedCustomEditor {
    return { viewType: this._viewType, resource: this._resource.toJSON() }
  }

  static deserialize(data: unknown): CustomEditorInput | null {
    const d = data as ISerializedCustomEditor | null
    if (!d || !d.viewType || !d.resource) return null
    const resource = URI.revive(d.resource) as URI
    return new CustomEditorInput(d.viewType, resource)
  }
}
