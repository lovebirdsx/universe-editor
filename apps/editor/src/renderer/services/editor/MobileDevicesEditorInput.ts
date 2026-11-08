/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Virtual editor input for the Mobile Devices settings page. Carries no state —
 *  the page reads everything live from IMobileGatewayService and
 *  IConfigurationService.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, localize } from '@universe-editor/platform'

const MOBILE_DEVICES_SETTINGS_URI = URI.from({
  scheme: 'universe',
  path: '/mobileDevicesSettings',
})

export class MobileDevicesEditorInput extends EditorInput {
  static readonly TYPE_ID = 'mobileDevicesSettings'

  override serialize(): string {
    return ''
  }

  static deserialize(): MobileDevicesEditorInput {
    return new MobileDevicesEditorInput()
  }

  override get typeId(): string {
    return MobileDevicesEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return MOBILE_DEVICES_SETTINGS_URI
  }

  override getName(): string {
    return localize('mobileDevices.editorName', 'Mobile Devices')
  }
}
