/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Installs the FileBulkEditService override on MonacoLoader before any editor is
 *  created, so Monaco's rename contribution resolves our cross-file writer
 *  instead of the standalone one (which can't touch unopened files). Runs at
 *  BlockStartup — earlier than the first `editor.create` during restore.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IInstantiationService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { FileBulkEditService } from '../services/languageFeatures/typescript/fileBulkEditService.js'

export class BulkEditServiceContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IInstantiationService instantiation: IInstantiationService) {
    super()
    MonacoLoader.setBulkEditService(instantiation.createInstance(FileBulkEditService))
  }
}
