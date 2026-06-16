/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InlineCompletionStatusContribution — a status-bar entry reflecting the AI
 *  inline-completion state: enabled ($(sparkle)), disabled ($(circle-slash)), or
 *  requesting ($(loading~spin)). Click toggles the feature. The tooltip shows the
 *  configured completion model. Mirrors AiModelStatusContribution.
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
import { IInlineCompletionService } from '../services/ai/InlineCompletionService.js'
import { ToggleInlineCompletionAction } from '../actions/inlineCompletionActions.js'

export class InlineCompletionStatusContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private _entry: IStatusBarEntryAccessor | undefined

  constructor(
    @IInlineCompletionService private readonly _inline: IInlineCompletionService,
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
  ) {
    super()
    void this._render()
    this._register(this._inline.onDidChange(() => void this._render()))
    this._register({ dispose: () => this._entry?.dispose() })
  }

  private async _render(): Promise<void> {
    const modelId = await this._inline.getModelId()
    const modelName = modelId
      ? (await this._aiModel.getModels()).find((m) => m.id === modelId)?.name
      : undefined

    const icon = this._inline.requesting
      ? '$(loading~spin)'
      : this._inline.enabled
        ? '$(sparkle)'
        : '$(circle-slash)'

    const tooltip = this._inline.enabled
      ? modelName
        ? localize('inlineStatus.tooltip.model', 'Inline completions: {0} (click to disable)', {
            0: modelName,
          })
        : localize(
            'inlineStatus.tooltip.noModel',
            'Inline completions on, but no model selected (click to disable)',
          )
      : localize('inlineStatus.tooltip.off', 'Inline completions off (click to enable)')

    const entry = {
      text: `${icon} ${localize('inlineStatus.label', 'Completions')}`,
      tooltip,
      command: ToggleInlineCompletionAction.ID,
      alignment: StatusBarAlignment.Right,
      priority: 49,
    }
    if (!this._entry) this._entry = this._statusBarService.addEntry(entry)
    else this._entry.update(entry)
  }
}
