/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const SETTINGS_URI = URI.from({ scheme: 'universe', path: '/settings' })

export class SettingsEditorInput extends EditorInput {
  static readonly TYPE_ID = 'settings'

  static deserialize(): SettingsEditorInput {
    return new SettingsEditorInput()
  }

  override get typeId(): string {
    return SettingsEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return SETTINGS_URI
  }

  override getName(): string {
    return 'Settings'
  }
}
