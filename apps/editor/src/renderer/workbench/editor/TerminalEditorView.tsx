import { IConfigurationService, IEditorInput, IWorkspaceService } from '@universe-editor/platform'
import { TerminalEditorInput } from '../../services/editor/TerminalEditorInput.js'
import { TerminalInstance } from '../panel/terminal/TerminalInstance.js'
import { ITerminalManagerService } from '../../services/terminal/TerminalManagerService.js'
import { useService } from '../useService.js'
import {
  useResolveTerminalFile,
  useOpenTerminalFile,
} from '../panel/terminal/useTerminalOpenFile.js'
import styles from './TerminalEditorView.module.css'

export function TerminalEditorView({ input }: { input: IEditorInput }) {
  const manager = useService(ITerminalManagerService)
  const configService = useService(IConfigurationService)
  const workspaceService = useService(IWorkspaceService)
  const isDark = configService.get<string>('workbench.colorTheme') !== 'light'

  const resolveFile = useResolveTerminalFile()
  const openFile = useOpenTerminalFile()

  if (!(input instanceof TerminalEditorInput)) return null

  const cwd = workspaceService.current?.folder.fsPath ?? ''

  return (
    <div className={styles['root']}>
      <TerminalInstance
        id={input.terminalId}
        active={true}
        isDark={isDark}
        manager={manager}
        cwd={cwd}
        resolveFile={resolveFile}
        openFile={openFile}
      />
    </div>
  )
}
