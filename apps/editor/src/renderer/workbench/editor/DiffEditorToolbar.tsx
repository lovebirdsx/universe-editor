import { ArrowDown, ArrowUp } from 'lucide-react'
import { ICommandService } from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './DiffEditorToolbar.module.css'

export function DiffEditorToolbar() {
  const commandService = useService(ICommandService)

  return (
    <div className={styles['toolbar']} data-testid="diff-editor-toolbar">
      <button
        type="button"
        className={styles['iconBtn']}
        title="上一处更改 (Shift+Alt+F5)"
        onClick={() =>
          void commandService.executeCommand('editor.action.compareEditor.previousChange')
        }
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className={styles['iconBtn']}
        title="下一处更改 (Alt+F5)"
        onClick={() => void commandService.executeCommand('editor.action.compareEditor.nextChange')}
      >
        <ArrowDown size={14} />
      </button>
    </div>
  )
}
