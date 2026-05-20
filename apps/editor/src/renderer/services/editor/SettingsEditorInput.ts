/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationTarget, EditorInput, URI } from '@universe-editor/platform'

const SETTINGS_URI = URI.from({ scheme: 'universe', path: '/settings' })

export class SettingsEditorInput extends EditorInput {
  static readonly TYPE_ID = 'settings'

  private _target: ConfigurationTarget.User | ConfigurationTarget.Project = ConfigurationTarget.User

  get target(): ConfigurationTarget.User | ConfigurationTarget.Project {
    return this._target
  }

  switchTarget(t: ConfigurationTarget.User | ConfigurationTarget.Project): void {
    this._target = t
  }

  override serialize(): string {
    return JSON.stringify({ target: this._target })
  }

  static deserialize(data?: string): SettingsEditorInput {
    const input = new SettingsEditorInput()
    if (data) {
      try {
        const parsed = JSON.parse(data) as { target?: number }
        if (parsed.target === ConfigurationTarget.Project) {
          input._target = ConfigurationTarget.Project
        }
      } catch {
        // ignore malformed state
      }
    }
    return input
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
