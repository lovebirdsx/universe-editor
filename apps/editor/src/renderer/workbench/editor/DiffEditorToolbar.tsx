import { ArrowDown, ArrowUp, FileText } from 'lucide-react'
import { ICommandService, localize } from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './DiffEditorToolbar.module.css'

export function DiffEditorToolbar() {
  const commandService = useService(ICommandService)

  return (
    <div className={styles['toolbar']} data-testid="diff-editor-toolbar">
      <button
        type="button"
        className={styles['iconBtn']}
        title={localize('diffEditor.openFile', 'Open File ({key})', { key: 'Shift+Alt+Y' })}
        onClick={() => void commandService.executeCommand('git.openFile')}
      >
        <FileText size={14} />
      </button>
      <button
        type="button"
        className={styles['iconBtn']}
        title={localize('diffEditor.previousChange', 'Previous Change ({key})', {
          key: 'Shift+Alt+F5',
        })}
        onClick={() =>
          void commandService.executeCommand('workbench.action.compareEditor.previousChange')
        }
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className={styles['iconBtn']}
        title={localize('diffEditor.nextChange', 'Next Change ({key})', { key: 'Alt+F5' })}
        onClick={() =>
          void commandService.executeCommand('workbench.action.compareEditor.nextChange')
        }
      >
        <ArrowDown size={14} />
      </button>
    </div>
  )
}
