/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Welcome editor input.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const WELCOME_URI = URI.from({ scheme: 'universe', path: '/welcome' })

export class WelcomeEditorInput extends EditorInput {
  static readonly TYPE_ID = 'welcome'

  static deserialize(): WelcomeEditorInput {
    return new WelcomeEditorInput()
  }

  get typeId(): string {
    return WelcomeEditorInput.TYPE_ID
  }

  get resource(): URI {
    return WELCOME_URI
  }

  getName(): string {
    return 'Welcome'
  }
}
