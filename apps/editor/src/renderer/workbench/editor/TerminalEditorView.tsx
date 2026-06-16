import { IEditorInput, IWorkspaceService } from '@universe-editor/platform'
import { TerminalEditorInput } from '../../services/editor/TerminalEditorInput.js'
import { TerminalInstance } from '../panel/terminal/TerminalInstance.js'
import { useService, useObservable } from '../useService.js'
import {
  useResolveTerminalFile,
  useOpenTerminalFile,
} from '../panel/terminal/useTerminalOpenFile.js'
import styles from './TerminalEditorView.module.css'

export function TerminalEditorView({ input }: { input: IEditorInput }) {
  if (!(input instanceof TerminalEditorInput)) return null
  // Keyed inner component so each input gets its own observable subscription —
  // EditorGroupView reuses this component across input swaps without a key.
  return <TerminalEditorBody key={input.resource.toString()} input={input} />
}

function TerminalEditorBody({ input }: { input: TerminalEditorInput }) {
  const workspaceService = useService(IWorkspaceService)
  const resolveFile = useResolveTerminalFile()
  const openFile = useOpenTerminalFile()
  const terminalId = useObservable(input.terminalId)

  const cwd = workspaceService.current?.folder.fsPath ?? ''

  // While a restored terminal respawns its pty, terminalId is still undefined.
  if (!terminalId) return <div className={styles['root']} />

  return (
    <div className={styles['root']}>
      <TerminalInstance
        key={terminalId}
        id={terminalId}
        active={true}
        cwd={cwd}
        resolveFile={resolveFile}
        openFile={openFile}
      />
    </div>
  )
}
