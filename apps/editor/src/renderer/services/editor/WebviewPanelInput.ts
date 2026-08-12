/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WebviewPanelInput — an EditorInput for an extension-owned webview panel
 *  (`window.createWebviewPanel`). Unlike CustomEditorInput the lifecycle is
 *  reversed: the extension creates/reveals/disposes the tab, and no file backs
 *  it (`resource` is undefined, so no file icon / SCM decoration attaches).
 *
 *  Identity is the (globally unique, negative) panelHandle — without overriding
 *  `id` every panel would collapse onto `webviewPanel:anonymous` and dedupe into
 *  one tab. Transient: no `serialize`, so a window restore drops the tab (the
 *  extension can simply recreate it on next activation).
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, type URI } from '@universe-editor/platform'

export class WebviewPanelInput extends EditorInput {
  static readonly TYPE_ID = 'webviewPanel'

  private _title: string

  constructor(
    readonly panelHandle: number,
    private readonly _viewType: string,
    title: string,
    /** Synthetic identity URI shared with the panel model, for focus routing. */
    private readonly _focusResource: URI,
  ) {
    super()
    this._title = title
  }

  get viewType(): string {
    return this._viewType
  }

  get focusResource(): URI {
    return this._focusResource
  }

  override get typeId(): string {
    return WebviewPanelInput.TYPE_ID
  }

  override get resource(): URI | undefined {
    return undefined
  }

  override get id(): string {
    return `webviewPanel:${this.panelHandle}`
  }

  override getName(): string {
    return this._title
  }

  /** `WebviewPanel.title = …` retitles the tab (host → $setWebviewTitle → here). */
  setTitle(title: string): void {
    if (this._title === title) return
    this._title = title
    this._onDidChangeLabel.fire()
  }
}
