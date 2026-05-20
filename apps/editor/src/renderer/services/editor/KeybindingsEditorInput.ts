/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const KEYBINDINGS_URI = URI.from({ scheme: 'universe', path: '/keybindings' })

export class KeybindingsEditorInput extends EditorInput {
  static readonly TYPE_ID = 'keybindings'

  static deserialize(): KeybindingsEditorInput {
    return new KeybindingsEditorInput()
  }

  override get typeId(): string {
    return KeybindingsEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return KEYBINDINGS_URI
  }

  override getName(): string {
    return 'Keyboard Shortcuts'
  }
}
