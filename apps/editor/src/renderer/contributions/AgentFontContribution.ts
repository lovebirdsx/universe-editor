import {
  Disposable,
  IConfigurationService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  AGENT_FONT_SIZE_DEFAULT,
  normalizeFontFamily,
} from '../services/configuration/fontDefaults.js'

const FONT_SIZE_KEY = 'acp.fontSize'
const FONT_FAMILY_KEY = 'acp.fontFamily'

export class AgentFontContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IConfigurationService private readonly _configuration: IConfigurationService) {
    super()

    this._apply()
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(FONT_SIZE_KEY) || e.affectsConfiguration(FONT_FAMILY_KEY)) {
          this._apply()
        }
      }),
    )
  }

  private _apply(): void {
    const root = document.documentElement.style
    const size = this._configuration.get<number>(FONT_SIZE_KEY)
    const px = typeof size === 'number' && size > 0 ? size : AGENT_FONT_SIZE_DEFAULT
    root.setProperty('--agent-font-size', `${px}px`)
    root.setProperty(
      '--agent-font-family',
      normalizeFontFamily(this._configuration.get(FONT_FAMILY_KEY), 'inherit'),
    )
  }
}
