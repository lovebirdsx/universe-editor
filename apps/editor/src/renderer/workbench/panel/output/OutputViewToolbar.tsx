import { type ChangeEvent } from 'react'
import { IOutputService, localize } from '@universe-editor/platform'
import { useService, useObservable } from '../../useService.js'
import styles from './OutputViewToolbar.module.css'

export function OutputViewToolbar() {
  const outputService = useService(IOutputService)
  const channelNames = useObservable(outputService.channelNames)
  const activeChannelName = useObservable(outputService.activeChannelName)

  const sortedChannelNames = [...channelNames].sort((a, b) => {
    if (a === 'All') return -1
    if (b === 'All') return 1
    return 0
  })

  const handleChannelChange = (e: ChangeEvent<HTMLSelectElement>) => {
    outputService.setActiveChannel(e.target.value)
  }

  return (
    <select
      className={styles['channelSelect']}
      value={activeChannelName ?? ''}
      onChange={handleChannelChange}
      aria-label={localize('output.selectChannel', 'Select output channel')}
      data-testid="output-channel-select"
    >
      {sortedChannelNames.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      {sortedChannelNames.length === 0 && (
        <option value="">{localize('output.noChannels', 'No channels')}</option>
      )}
    </select>
  )
}
