/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WebviewFocusRegistry — tracks the live WebviewElement backing each open
 *  CustomEditorInput, addressed by `viewType + resource`. A custom editor is a
 *  sandboxed iframe (no Monaco instance), so `focusEditorInput` can't reach it
 *  through FileEditorRegistry and would fall back to focusing the editor-group
 *  body — which sits *outside* the iframe, leaving the webview without keyboard
 *  focus (the user has to click it). This registry is the equivalent handle, so
 *  `CustomEditorInput.focus()` can move focus into the iframe.
 *
 *  The provider registers asynchronously, so the group's focus pass can run
 *  before the WebviewElement has mounted and registered its controller. A
 *  pending-focus set records the request and applies it when the controller
 *  arrives (mirrors MarkdownPreviewRegistry's pending-anchor handling).
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'

export interface IWebviewFocusController {
  /** Move keyboard focus into the webview iframe. */
  focus(): void
}

class WebviewFocusRegistryImpl {
  private readonly _map = new Map<string, IWebviewFocusController>()
  /** Focus requests that arrived before the controller registered. */
  private readonly _pending = new Set<string>()

  private _key(viewType: string, resource: URI): string {
    return `${viewType}::${resource.toString()}`
  }

  register(viewType: string, resource: URI, controller: IWebviewFocusController): void {
    const key = this._key(viewType, resource)
    this._map.set(key, controller)
    if (this._pending.delete(key)) controller.focus()
  }

  unregister(viewType: string, resource: URI, controller: IWebviewFocusController): void {
    const key = this._key(viewType, resource)
    if (this._map.get(key) === controller) this._map.delete(key)
  }

  /**
   * Request focus for a custom editor. If its controller is live, focus now;
   * otherwise remember the request so a controller that mounts later picks it up.
   * Always returns true so `focusEditorInput` treats the input as handled and
   * doesn't fall back to the group body.
   */
  requestFocus(viewType: string, resource: URI): boolean {
    const key = this._key(viewType, resource)
    const controller = this._map.get(key)
    if (controller) {
      controller.focus()
      return true
    }
    this._pending.add(key)
    return true
  }

  _resetForTests(): void {
    this._map.clear()
    this._pending.clear()
  }
}

export const WebviewFocusRegistry = new WebviewFocusRegistryImpl()
