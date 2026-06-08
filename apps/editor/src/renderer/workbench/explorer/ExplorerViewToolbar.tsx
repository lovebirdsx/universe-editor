import { useEffect, useState } from 'react'
import { ChevronsDownUp, FilePlus, FolderPlus, RefreshCw } from 'lucide-react'
import { ICommandService, localize, markAsSingleton } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { IExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import styles from './ExplorerViewToolbar.module.css'

export function ExplorerViewToolbar() {
  const tree = useService(IExplorerTreeService)
  const commandService = useService(ICommandService)
  const [hasRoot, setHasRoot] = useState(() => tree.root !== null)

  useEffect(() => {
    const d = markAsSingleton(tree.onDidChangeStructure(() => setHasRoot(tree.root !== null)))
    return () => d.dispose()
  }, [tree])

  return (
    <>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('explorer.newFile', 'New File...')}
        disabled={!hasRoot}
        onClick={() => void commandService.executeCommand('workbench.files.action.newFile')}
      >
        <FilePlus size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('explorer.newFolder', 'New Folder...')}
        disabled={!hasRoot}
        onClick={() => void commandService.executeCommand('workbench.files.action.newFolder')}
      >
        <FolderPlus size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('explorer.refresh', 'Refresh Explorer')}
        disabled={!hasRoot}
        onClick={() => {
          const root = tree.root
          if (root) void tree.refresh(root)
        }}
      >
        <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('explorer.collapseAll', 'Collapse All')}
        disabled={!hasRoot}
        onClick={() => tree.collapseAll()}
      >
        <ChevronsDownUp size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </>
  )
}
