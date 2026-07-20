/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for update-config.json (the deployment config that
 *  overrides the auto-update feed / marketplace gallery urls), so editing it gets
 *  completion + validation + hover docs in Monaco. The file is pinned to
 *  <userData>/update-config.json and does not follow a relocated config dir, so
 *  its exact fileMatch is resolved once at startup.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IDisposable,
  IUserDataFilesService,
  IWorkbenchContribution,
  JSONContributionRegistry,
  MutableDisposable,
  UserDataFile,
  type IJSONSchema,
} from '@universe-editor/platform'
import { schemaFileMatchForUri } from '../services/preferences/schemaFileMatch.js'

const UPDATE_CONFIG_SCHEMA_URI = 'universe-editor://schemas/updateConfig'

// Fields mirror the file-source config items declared in
// apps/editor/src/main/environment/configItems.ts (those with a `filePath`).
const UPDATE_CONFIG_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    updateUrl: {
      type: 'string',
      format: 'uri',
      description:
        'Override the auto-update server URL (packaged builds only). Overrides the url only; the release channel stays the packaged default.',
    },
    galleryUrl: {
      type: 'string',
      format: 'uri',
      description:
        'Override the extension marketplace gallery URL (packaged builds only). An empty value disables the marketplace.',
    },
  },
}

export class UpdateConfigurationContribution extends Disposable implements IWorkbenchContribution {
  private readonly _schema = this._register(new MutableDisposable<IDisposable>())

  constructor(@IUserDataFilesService private readonly _userDataFiles: IUserDataFilesService) {
    super()
    void this._refresh()
  }

  private async _refresh(): Promise<void> {
    const components = await this._userDataFiles.getFileUri(UserDataFile.UpdateConfig)
    if (!components) {
      this._schema.clear()
      return
    }
    const fileMatch = schemaFileMatchForUri(components)
    this._schema.value = JSONContributionRegistry.registerSchema({
      uri: UPDATE_CONFIG_SCHEMA_URI,
      fileMatch: [fileMatch],
      schema: UPDATE_CONFIG_SCHEMA,
    })
  }
}
