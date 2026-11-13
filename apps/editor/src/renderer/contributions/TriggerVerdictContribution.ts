/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Installs the trigger verdict parser / action executor as the automated
 *  session service's resolver. Runs at AfterRestore so it is in place before any
 *  trigger run can start (the run host is registered in the same phase).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ICommandService,
  ILoggerService,
  IWorkbenchContribution,
} from '@universe-editor/platform'
import { IAutomatedSessionService } from '../services/triggers/automatedSessionService.js'
import { createTriggerActionExecutor } from '../services/triggers/triggerActionExecutor.js'

export class TriggerVerdictContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IAutomatedSessionService sessions: IAutomatedSessionService,
    @ICommandService commands: ICommandService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    sessions.setVerdictResolver(
      createTriggerActionExecutor({
        commands,
        logger: loggerService.createLogger({ id: 'triggerVerdict', name: 'Triggers' }),
      }),
    )
    this._register({ dispose: () => sessions.setVerdictResolver(undefined) })
  }
}
