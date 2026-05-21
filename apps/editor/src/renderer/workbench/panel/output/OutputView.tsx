import { type ChangeEvent } from 'react'
import { IConfigurationService, IOutputService } from '@universe-editor/platform'
import { Trash2 } from 'lucide-react'
import { useService, useObservable } from '../../useService.js'
import { LogOutputView } from './LogOutputView.js'
import styles from './OutputView.module.css'

export function OutputView() {
  const outputService = useService(IOutputService)
  const configService = useService(IConfigurationService)
  const channelNames = useObservable(outputService.channelNames)
  const activeChannelName = useObservable(outputService.activeChannelName)
  const content = useObservable(outputService.activeChannelContent)
  const activeChannel = activeChannelName ? outputService.getChannel(activeChannelName) : undefined
  const theme = configService.get<string>('workbench.colorTheme') === 'light' ? 'vs' : 'vs-dark'

  const handleChannelChange = (e: ChangeEvent<HTMLSelectElement>) => {
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
          aria-label="Clear Output"
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className={styles['content']}>
        {content ? (
          <LogOutputView content={content} theme={theme} />
        ) : (
          <div className={styles['empty']}>No output.</div>
        )}
      </div>
    </div>
  )
}
