import { IEditorInput, IWorkspaceService } from '@universe-editor/platform'
import { TerminalEditorInput } from '../../services/editor/TerminalEditorInput.js'
import { TerminalInstance } from '../panel/terminal/TerminalInstance.js'
import { useService } from '../useService.js'
import {
  useResolveTerminalFile,
  useOpenTerminalFile,
} from '../panel/terminal/useTerminalOpenFile.js'
import styles from './TerminalEditorView.module.css'

export function TerminalEditorView({ input }: { input: IEditorInput }) {
  const workspaceService = useService(IWorkspaceService)

  const resolveFile = useResolveTerminalFile()
  const openFile = useOpenTerminalFile()

  if (!(input instanceof TerminalEditorInput)) return null

  const cwd = workspaceService.current?.folder.fsPath ?? ''

  return (
    <div className={styles['root']}>
      <TerminalInstance
        key={input.terminalId}
        id={input.terminalId}
        active={true}
        cwd={cwd}
        resolveFile={resolveFile}
        openFile={openFile}
      />
    </div>
  )
}
