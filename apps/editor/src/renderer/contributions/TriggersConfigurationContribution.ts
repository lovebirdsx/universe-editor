/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for `<workspace>/.universe-editor/triggers.json` and the
 *  machine-wide `triggers.maxConcurrentRuns` setting. The file lives in every
 *  workspace that opts into triggers, so a glob fileMatch is used (the same shape
 *  as `.vscode/settings.json`). The scheduler reads / writes the file in main; this
 *  contribution adds completion + validation and forwards setting changes to main.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  type IDisposable,
  type IWorkbenchContribution,
  JSONContributionRegistry,
  MutableDisposable,
  localize,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../shared/ipc/triggerService.js'
import { TRIGGERS_SCHEMA } from '../../shared/triggers/configParse.js'
import {
  TRIGGER_DEFAULTS,
  TRIGGERS_MAX_CONCURRENT_RUNS_KEY,
  TRIGGERS_WORKSPACE_CONFIG_FILE,
  TRIGGERS_WORKSPACE_DIR,
} from '../../shared/triggers/types.js'

const TRIGGERS_SCHEMA_URI = 'universe-editor://schemas/triggers'

/** Workspace-relative path; `makeGlobMatcher` matches it at any depth. */
export const TRIGGERS_SCHEMA_FILE_MATCH = `**/${TRIGGERS_WORKSPACE_DIR}/${TRIGGERS_WORKSPACE_CONFIG_FILE}`

// The schema itself lives next to the parser (shared/triggers/configParse.ts) so
// both stay one contract; re-exported here for the existing schema shape tests.
export { TRIGGERS_SCHEMA }

export class TriggersConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _schema = this._register(new MutableDisposable<IDisposable>())

  constructor(
    @IConfigurationService config: IConfigurationService,
    @ITriggerMainService triggers: ITriggerMainService,
  ) {
    super()
    this._schema.value = JSONContributionRegistry.registerSchema({
      uri: TRIGGERS_SCHEMA_URI,
      fileMatch: [TRIGGERS_SCHEMA_FILE_MATCH],
      schema: TRIGGERS_SCHEMA,
    })
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'triggers',
        title: localize('settings.triggers', 'Agent Triggers'),
        properties: {
          [TRIGGERS_MAX_CONCURRENT_RUNS_KEY]: {
            type: 'integer',
            default: TRIGGER_DEFAULTS.maxConcurrentRuns,
            minimum: 1,
            maximum: 10,
            description: localize(
              'settings.triggers.maxConcurrentRuns',
              'Maximum number of trigger-initiated agent runs that may execute at the same time on this machine. Individual triggers also have their own `concurrency` limit.',
            ),
          },
        },
      }),
    )
    this._register(
      config.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(TRIGGERS_MAX_CONCURRENT_RUNS_KEY)) return
        const value = config.get<number>(TRIGGERS_MAX_CONCURRENT_RUNS_KEY)
        void triggers.setMaxConcurrentRuns(value ?? TRIGGER_DEFAULTS.maxConcurrentRuns)
      }),
    )
  }
}
