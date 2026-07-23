/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Port of VSCode's LargeFileOptimizationsWarner
 *  (src/vs/workbench/contrib/codeEditor/browser/largeFileOptimizations.ts).
 *
 *  The feature shut-off itself lives in Monaco core: a model created while
 *  `editor.largeFileOptimizations` is on (the default) and exceeding 20 MB /
 *  300K lines is flagged `isTooLargeForTokenization()` at construction, which
 *  permanently disables tokenization, wrapping, folding, codelens, word
 *  highlighting and sticky scroll for that model. This contribution is the
 *  workbench half Monaco does not ship — it surfaces the notification and the
 *  "forcefully enable" escape hatch. The flag is a construction-time decision,
 *  so toggling the setting only affects models created afterwards; the user
 *  must reopen the file (same as VSCode).
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  Disposable,
  IConfigurationService,
  INotificationService,
  Severity,
  basename,
  createNamedLogger,
  localize,
  ILoggerService,
  type ILogger,
  type IWorkbenchContribution,
  type URI,
} from '@universe-editor/platform'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import type { monaco } from '../workbench/editor/monaco/MonacoLoader.js'

/** Present at runtime on every Monaco TextModel but absent from the public d.ts. */
interface ILargeFileAwareModel extends monaco.editor.ITextModel {
  isTooLargeForTokenization(): boolean
}

export class LargeFileOptimizationsContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _logger: ILogger

  constructor(
    @INotificationService private readonly _notification: INotificationService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'largeFileOptimizations',
      name: 'Large File Optimizations',
    })
    // Fires once per model instance, which doubles as dedup: reopening a file
    // after its model was disposed re-creates the model and warns again,
    // matching VSCode's per-open prompt.
    this._register(MonacoModelRegistry.onDidAddModel((resource) => this._warnIfOptimized(resource)))
  }

  private _warnIfOptimized(resource: URI): void {
    const model = MonacoModelRegistry.peek(resource) as ILargeFileAwareModel | undefined
    if (!model || model.isDisposed() || !model.isTooLargeForTokenization()) return

    this._logger.debug(
      `large file optimizations active for ${resource.toString()} ` +
        `(${model.getValueLength()} chars, ${model.getLineCount()} lines)`,
    )
    const fileName = basename(resource.path)
    void this._notification.prompt(
      Severity.Info,
      localize(
        'largeFileOptimizations.warning',
        '{file}: tokenization, wrapping, folding, codelens, word highlighting and sticky scroll have been turned off for this large file in order to reduce memory usage and avoid freezing or crashing.',
        { file: fileName },
      ),
      [
        {
          label: localize('largeFileOptimizations.forceEnable', 'Forcefully Enable Features'),
          run: () => this._forceEnable(),
        },
      ],
      // Same id as VSCode's LargeFileOptimizationsWarner.
      { neverShowAgain: { id: 'editor.contrib.largeFileOptimizationsWarner' } },
    )
  }

  private _forceEnable(): void {
    this._configuration.update('editor.largeFileOptimizations', false, ConfigurationTarget.User)
    this._logger.debug('editor.largeFileOptimizations set to false by user')
    this._notification.notify({
      severity: Severity.Info,
      message: localize(
        'largeFileOptimizations.reopenPrompt',
        'Please reopen the file for this setting to take effect.',
      ),
    })
  }
}
