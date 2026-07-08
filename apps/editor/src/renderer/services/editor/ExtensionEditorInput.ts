/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Virtual editor input for the extension detail page (mirrors VSCode's Extension
 *  Editor). Carries only the extension id — the editor reads everything live from
 *  IExtensionsWorkbenchService. Each extension id is its own tab (the resource
 *  path carries the id, so the base input identity is already distinct).
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

export class ExtensionEditorInput extends EditorInput {
  static readonly TYPE_ID = 'extensionDetail'

  constructor(readonly extensionId: string) {
    super()
  }

  override serialize(): string {
    return this.extensionId
  }

  static deserialize(data: string): ExtensionEditorInput {
    return new ExtensionEditorInput(data)
  }

  override get typeId(): string {
    return ExtensionEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'universe', path: `/extension/${this.extensionId}` })
  }

  override getName(): string {
    return this.extensionId
  }
}
