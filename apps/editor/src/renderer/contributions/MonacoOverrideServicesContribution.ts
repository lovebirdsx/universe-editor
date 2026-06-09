/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Installs Monaco standalone override services on MonacoLoader before any editor
 *  is created (overrides lock in on first init). Both replacements exist because
 *  the standalone defaults only know about already-open models:
 *    - FileBulkEditService: cross-file F2 rename can write files the user hasn't
 *      opened (the default throws "bad edit - model not found").
 *    - FileTextModelService: the references peek tree can resolve previews for
 *      files the user hasn't opened (the default rejects "Model not found").
 *  Runs at BlockStartup — earlier than the first `editor.create` during restore.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IInstantiationService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { FileBulkEditService } from '../services/languageFeatures/typescript/fileBulkEditService.js'
import { FileTextModelService } from '../services/editor/fileTextModelService.js'

export class MonacoOverrideServicesContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(@IInstantiationService instantiation: IInstantiationService) {
    super()
    MonacoLoader.setBulkEditService(instantiation.createInstance(FileBulkEditService))
    MonacoLoader.setTextModelService(instantiation.createInstance(FileTextModelService))
  }
}
