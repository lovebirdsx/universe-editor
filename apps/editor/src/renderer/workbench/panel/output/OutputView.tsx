import { useState, useEffect, useRef } from 'react'
import { IOutputService } from '@universe-editor/platform'
import type { IOutputChannel } from '@universe-editor/platform'
import { useService } from '../../useService.js'
import { OutputChannel } from './OutputService.js'
import styles from './OutputView.module.css'

export function OutputView() {
  const outputService = useService(IOutputService)
  const [channels, setChannels] = useState<readonly IOutputChannel[]>([])
  const [activeChannel, setActiveChannel] = useState<IOutputChannel | undefined>(undefined)
  const [content, setContent] = useState('')
  const contentRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setChannels(outputService.getChannels())
    setActiveChannel(outputService.activeChannel)

    const d1 = outputService.onDidChangeActiveChannel((ch) => {
      setActiveChannel(ch)
      setChannels(outputService.getChannels())
    })
    return () => d1.dispose()
  }, [outputService])

  useEffect(() => {
    if (!activeChannel) {
      setContent('')
      return
    }
    const concrete = activeChannel as OutputChannel
    setContent(concrete.getContent())

    const d = activeChannel.onDidAppend(() => {
      setContent(concrete.getContent())
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
          value={activeChannel?.name ?? ''}
          onChange={handleChannelChange}
          aria-label="Select output channel"
        >
          {channels.map((ch) => (
            <option key={ch.name} value={ch.name}>
              {ch.name}
            </option>
          ))}
          {channels.length === 0 && <option value="">No channels</option>}
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
