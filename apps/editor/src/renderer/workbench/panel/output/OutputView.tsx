import { useEffect, useRef } from 'react'
import { IOutputService } from '@universe-editor/platform'
import { useService, useObservable } from '../../useService.js'
import styles from './OutputView.module.css'

export function OutputView() {
  const outputService = useService(IOutputService)
  const channelNames = useObservable(outputService.channelNames)
  const activeChannelName = useObservable(outputService.activeChannelName)
  const content = useObservable(outputService.activeChannelContent)
  const contentRef = useRef<HTMLPreElement>(null)

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [content])

  const handleChannelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    outputService.setActiveChannel(e.target.value)
  }

  return (
    <div className={styles['outputView']}>
      <div className={styles['toolbar']}>
        <select
          className={styles['channelSelect']}
          value={activeChannelName ?? ''}
          onChange={handleChannelChange}
          aria-label="Select output channel"
        >
          {channelNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {channelNames.length === 0 && <option value="">No channels</option>}
        </select>
        <button
          className={styles['clearBtn']}
          onClick={() => outputService.activeChannel?.clear()}
          disabled={!activeChannelName}
          title="Clear Output"
        >
          ×
        </button>
      </div>
      <pre ref={contentRef} className={styles['content']}>
        {content || <span className={styles['empty']}>No output.</span>}
      </pre>
    </div>
  )
}
