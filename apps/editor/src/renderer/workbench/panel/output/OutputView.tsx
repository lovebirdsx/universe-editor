import { useState, useEffect, useRef } from 'react'
import { IOutputService } from '@universe-editor/platform'
import type { OutputState } from '@universe-editor/platform'
import { useService, useSnapshot } from '../../useService.js'
import { shallow } from '../../shallow.js'
import styles from './OutputView.module.css'

const outputSelector = (s: OutputState) => ({
  channelNames: s.channelNames,
  activeChannelName: s.activeChannelName,
})

export function OutputView() {
  const outputService = useService(IOutputService)
  const { channelNames, activeChannelName } = useSnapshot(outputService, outputSelector, shallow)
  const activeChannel = activeChannelName ? outputService.getChannel(activeChannelName) : undefined

  const [content, setContent] = useState('')
  const contentRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!activeChannel) {
      setContent('')
      return
    }
    setContent(activeChannel.getContent())

    const d = activeChannel.onDidAppend(() => {
      setContent(activeChannel.getContent())
      // Auto-scroll to bottom
      if (contentRef.current) {
        contentRef.current.scrollTop = contentRef.current.scrollHeight
      }
    })
    return () => d.dispose()
  }, [activeChannel])

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
          onClick={() => activeChannel?.clear()}
          disabled={!activeChannel}
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
