/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiModelStatusContribution — a status-bar entry showing the active AI model,
 *  click to open the model picker (ai.pickModel). Refreshes when the available
 *  models change (a key was configured) or the active selection changes.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IAiModelService,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
  localize,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { PickModelAction } from '../actions/aiActions.js'

export class AiModelStatusContribution extends Disposable implements IWorkbenchContribution {
  private _entry: IStatusBarEntryAccessor | undefined

  constructor(
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
  ) {
    super()
    this._render()
    this._register(this._aiModel.onDidChangeModels(() => void this._render()))
    this._register(this._aiModel.onDidChangeActiveModel(() => void this._render()))
    this._register({ dispose: () => this._entry?.dispose() })
  }

  private async _render(): Promise<void> {
    const [models, active] = await Promise.all([
      this._aiModel.getModels(),
      this._aiModel.getActiveModelId(),
    ])
    const current = (active && models.find((m) => m.id === active)) || models[0]
    const text = current
      ? `$(sparkle) ${current.name}`
      : `$(sparkle) ${localize('aiStatus.select', 'Select AI Model')}`

    const entry = {
      text,
      tooltip: localize('aiStatus.tooltip', 'Select the active AI model'),
      command: PickModelAction.ID,
      alignment: StatusBarAlignment.Right,
      priority: 50,
    }
    if (!this._entry) this._entry = this._statusBarService.addEntry(entry)
    else this._entry.update(entry)
  }
}
