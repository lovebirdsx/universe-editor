/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for downloading remote (http/https) JSON schemas.
 *  Monaco's JSON worker can't fetch schemas itself (schemaRequest: 'ignore'), so
 *  remote schemas referenced by `contributes.jsonValidation` or the user
 *  `json.schemas` setting are downloaded here in main and handed back as text for
 *  the renderer to inline. This service is a pure downloader + on-disk cache (with
 *  ETag + offline fallback); trust/enable policy lives in the renderer.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

export type RemoteSchemaResult = { ok: true; content: string } | { ok: false; error: string }

export interface IRemoteSchemaService {
  readonly _serviceBrand: undefined
  /** Download (or serve from cache) the schema at `url`. Never throws. */
  fetchSchema(url: string): Promise<RemoteSchemaResult>
}

export const IRemoteSchemaService = createDecorator<IRemoteSchemaService>('remoteSchemaService')
