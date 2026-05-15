import { IStatusBarService, StatusBarAlignment, ICommandService } from '@universe-editor/platform'
import type { IStatusBarEntry } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import styles from './StatusBar.module.css'

function StatusBarItem({ entry }: { entry: IStatusBarEntry }) {
  const commandService = useService(ICommandService)

  const handleClick = () => {
    if (entry.command) {
      void commandService.executeCommand(entry.command)
    }
  }

  return (
    <button
      className={`${styles['item']} ${entry.command ? styles['clickable'] : ''}`}
      onClick={handleClick}
      title={entry.tooltip}
      aria-label={entry.text}
    >
      {entry.text}
    </button>
  )
}

export function StatusBar() {
  const statusBarService = useService(IStatusBarService)
  const entries = useObservable(statusBarService.entries)

  const leftEntries = entries
    .filter((e) => e.entry.alignment === StatusBarAlignment.Left)
    .sort((a, b) => b.entry.priority - a.entry.priority)

  const rightEntries = entries
    .filter((e) => e.entry.alignment === StatusBarAlignment.Right)
    .sort((a, b) => b.entry.priority - a.entry.priority)

  return (
    <footer className={styles['statusbar']} aria-label="Status Bar">
      <div className={styles['left']}>
        {leftEntries.map((e) => (
          <StatusBarItem key={e.id} entry={e.entry} />
        ))}
      </div>
      <div className={styles['right']}>
        {rightEntries.map((e) => (
          <StatusBarItem key={e.id} entry={e.entry} />
        ))}
      </div>
    </footer>
  )
}
