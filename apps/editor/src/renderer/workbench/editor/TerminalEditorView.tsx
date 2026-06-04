import { IConfigurationService, IEditorInput } from '@universe-editor/platform'
import { TerminalEditorInput } from '../../services/editor/TerminalEditorInput.js'
import { TerminalInstance } from '../panel/terminal/TerminalInstance.js'
import { ITerminalManagerService } from '../../services/terminal/TerminalManagerService.js'
import { useService } from '../useService.js'
import styles from './TerminalEditorView.module.css'

export function TerminalEditorView({ input }: { input: IEditorInput }) {
  const manager = useService(ITerminalManagerService)
  const configService = useService(IConfigurationService)
  const isDark = configService.get<string>('workbench.colorTheme') !== 'light'

  if (!(input instanceof TerminalEditorInput)) return null

  return (
    <div className={styles['root']}>
      <TerminalInstance id={input.terminalId} active={true} isDark={isDark} manager={manager} />
    </div>
  )
}
