import { useEffect, useState } from 'react'
import { IHostService, markAsSingleton } from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './TitleBar.module.css'

export function WindowControls() {
  const host = useService(IHostService)
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    let cancelled = false
    void host.isMaximized().then((v) => {
      if (!cancelled) setIsMaximized(v)
    })
    const sub = markAsSingleton(host.onDidChangeMaximized((v) => setIsMaximized(v)))
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [host])

  return (
    <div className={styles['controls']}>
      <button
        className={styles['ctrl-btn']}
        onClick={() => void host.minimizeWindow()}
        title="Minimize"
        aria-label="Minimize"
      >
        <svg width="10" height="1" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className={styles['ctrl-btn']}
        onClick={() => void host.toggleMaximizeWindow()}
        title={isMaximized ? 'Restore Down' : 'Maximize'}
        aria-label={isMaximized ? 'Restore Down' : 'Maximize'}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M3 1H9V7H3V1Z M1 3H7V9H1V3Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        className={`${styles['ctrl-btn']} ${styles['close']}`}
        onClick={() => void host.closeWindow()}
        title="Close"
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  )
}
