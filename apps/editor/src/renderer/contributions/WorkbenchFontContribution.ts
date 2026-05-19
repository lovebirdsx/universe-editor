import {
  Disposable,
  IConfigurationService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  normalizeFontFamily,
  WORKBENCH_FONT_FAMILY_DEFAULT,
} from '../workbench/configuration/fontDefaults.js'

function getWorkbenchFontFamily(config: IConfigurationService): string {
  return normalizeFontFamily(config.get('workbench.fontFamily'), WORKBENCH_FONT_FAMILY_DEFAULT)
}

export class WorkbenchFontContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IConfigurationService private readonly _configuration: IConfigurationService) {
    super()

    this._applyFontFamily()
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.fontFamily')) this._applyFontFamily()
      }),
    )
  }

  private _applyFontFamily(): void {
    document.documentElement.style.setProperty(
      '--font-ui',
      getWorkbenchFontFamily(this._configuration),
    )
  }
}
