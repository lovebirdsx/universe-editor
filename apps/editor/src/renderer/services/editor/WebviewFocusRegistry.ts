/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WebviewFocusRegistry — tracks the live WebviewElement backing each open
 *  CustomEditorInput, addressed by `viewType + resource`, with the group and
 *  document that mounted it. A custom editor is a sandboxed iframe (no Monaco
 *  instance), so `focusEditorInput` can't reach it through FileEditorRegistry
 *  and would fall back to focusing the editor-group body — which sits *outside*
 *  the iframe, leaving the webview without keyboard focus (the user has to
 *  click it). This registry is the equivalent handle, so `CustomEditorInput.focus()`
 *  can move focus into the iframe.
 *
 *  The same custom editor can be open in several groups/windows, so callers that
 *  know the group must resolve through it rather than the most recent mount.
 *
 *  The provider registers asynchronously, so the group's focus pass can run
 *  before the WebviewElement has mounted and registered its controller. A
 *  pending-focus queue records the request (including its group) and applies it
 *  when the matching controller arrives.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'
import { currentWorkbenchDocumentOrUndefined } from '../windows/workbenchDocuments.js'

export interface IWebviewFocusController {
  /** Move keyboard focus into the webview iframe. */
  focus(): void
}

export interface IWebviewFocusRegistrationOptions {
  readonly groupId?: number | undefined
  readonly ownerDocument?: Document | undefined
}

interface WebviewFocusRegistration {
  readonly controller: IWebviewFocusController
  readonly groupId: number | undefined
  readonly ownerDocument: Document | undefined
}

interface PendingFocus {
  readonly key: string
  readonly groupId: number | undefined
}

class WebviewFocusRegistryImpl {
  private readonly _map = new Map<string, WebviewFocusRegistration[]>()
  /** Focus requests that arrived before the controller registered. */
  private readonly _pending: PendingFocus[] = []

  private _key(viewType: string, resource: URI): string {
    return `${viewType}::${resource.toString()}`
  }

  register(
    viewType: string,
    resource: URI,
    controller: IWebviewFocusController,
    options?: IWebviewFocusRegistrationOptions,
  ): void {
    const key = this._key(viewType, resource)
    const list = this._map.get(key) ?? []
    list.push({
      controller,
      groupId: options?.groupId,
      ownerDocument: options?.ownerDocument,
    })
    this._map.set(key, list)
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const pending = this._pending[i]
      if (!pending || pending.key !== key) continue
      if (pending.groupId !== undefined && pending.groupId !== options?.groupId) continue
      this._pending.splice(i, 1)
      controller.focus()
    }
  }

  unregister(viewType: string, resource: URI, controller: IWebviewFocusController): void {
    const key = this._key(viewType, resource)
    const list = this._map.get(key)
    if (!list) return
    const index = list.findIndex((r) => r.controller === controller)
    if (index === -1) return
    list.splice(index, 1)
    if (list.length === 0) this._map.delete(key)
  }

  private _resolve(
    list: readonly WebviewFocusRegistration[],
    groupId: number | undefined,
  ): WebviewFocusRegistration | undefined {
    if (groupId !== undefined) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.groupId === groupId) return list[i]
      }
    }
    const activeDocument = currentWorkbenchDocumentOrUndefined()
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.ownerDocument === activeDocument) return list[i]
    }
    return list[list.length - 1]
  }

  /**
   * Request focus for a custom editor. If its controller is live, focus now;
   * otherwise remember the request so a controller that mounts later picks it
   * up. Always returns true so `focusEditorInput` treats the input as handled and
   * doesn't fall back to the group body.
   */
  requestFocus(viewType: string, resource: URI, groupId?: number): boolean {
    const key = this._key(viewType, resource)
    const list = this._map.get(key)
    const registration = list && list.length > 0 ? this._resolve(list, groupId) : undefined
    if (registration) {
      registration.controller.focus()
      return true
    }
    if (!this._pending.some((p) => p.key === key && p.groupId === groupId)) {
      this._pending.push({ key, groupId })
    }
    return true
  }

  _resetForTests(): void {
    this._map.clear()
    this._pending.length = 0
  }
}

export const WebviewFocusRegistry = new WebviewFocusRegistryImpl()
