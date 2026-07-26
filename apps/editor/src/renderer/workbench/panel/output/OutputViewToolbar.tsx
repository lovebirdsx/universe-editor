import { useRef, useState, type ChangeEvent, type HTMLAttributes, type RefObject } from 'react'
import { ListFilter, Lock, LockOpen } from 'lucide-react'
import { IOutputService, LogLevel, localize } from '@universe-editor/platform'
import { AnchoredSurface, Checkbox, IconButton, Input } from '@universe-editor/workbench-ui'
import { IOutputModelService } from '../../../services/output/OutputModelService.js'
import { sortOutputChannelNames } from '../../../services/output/outputChannelSort.js'
import { useExecuteCommand, useService, useObservable } from '../../useService.js'
import styles from './OutputViewToolbar.module.css'

const LEVEL_ITEMS: ReadonlyArray<{ level: LogLevel; labelKey: string; fallback: string }> = [
  { level: LogLevel.Trace, labelKey: 'output.filter.level.trace', fallback: 'Trace' },
  { level: LogLevel.Debug, labelKey: 'output.filter.level.debug', fallback: 'Debug' },
  { level: LogLevel.Info, labelKey: 'output.filter.level.info', fallback: 'Info' },
  { level: LogLevel.Warning, labelKey: 'output.filter.level.warning', fallback: 'Warning' },
  { level: LogLevel.Error, labelKey: 'output.filter.level.error', fallback: 'Error' },
]

export function OutputViewToolbar() {
  const outputService = useService(IOutputService)
  const outputModels = useService(IOutputModelService)
  const channelNames = useObservable(outputService.channelNames)
  const activeChannelName = useObservable(outputService.activeChannelName)
  const autoScroll = useObservable(outputModels.autoScroll)
  const filterText = useObservable(outputModels.filterText)
  const hiddenLevels = useObservable(outputModels.hiddenLevels)
  const executeCommand = useExecuteCommand()

  const levelBtnRef = useRef<HTMLButtonElement>(null)
  const [levelMenuOpen, setLevelMenuOpen] = useState(false)

  const sortedChannelNames = sortOutputChannelNames(channelNames)
  const filterActive = filterText.trim() !== '' || hiddenLevels.size > 0

  const handleChannelChange = (e: ChangeEvent<HTMLSelectElement>) => {
    outputService.setActiveChannel(e.target.value)
  }

  const clearFilters = () => {
    outputModels.setFilterText('')
    for (const level of hiddenLevels) outputModels.setLevelHidden(level, false)
  }

  const lockLabel = autoScroll
    ? localize('output.autoScroll.turnOff', 'Turn Auto Scrolling Off')
    : localize('output.autoScroll.turnOn', 'Turn Auto Scrolling On')

  return (
    <span className={styles['toolbar']}>
      <Input
        className={styles['filterInput']}
        value={filterText}
        placeholder={localize('output.filter.placeholder', 'Filter (e.g. text, !exclude)')}
        aria-label={localize('output.filter.ariaLabel', 'Filter output')}
        onChange={(e) => outputModels.setFilterText(e.target.value)}
        data-testid="output-filter-input"
      />
      <IconButton
        ref={levelBtnRef}
        label={localize('output.filter.levels', 'Filter by Log Level')}
        active={levelMenuOpen || hiddenLevels.size > 0}
        aria-expanded={levelMenuOpen}
        onClick={() => setLevelMenuOpen((open) => !open)}
        data-testid="output-filter-levels"
      >
        <ListFilter size={14} strokeWidth={1.75} />
      </IconButton>
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
      <IconButton
        label={lockLabel}
        active={!autoScroll}
        aria-pressed={!autoScroll}
        onClick={() => void executeCommand('workbench.action.toggleOutputAutoScroll')}
        data-testid="output-scroll-lock"
      >
        {autoScroll ? (
          <LockOpen size={14} strokeWidth={1.75} />
        ) : (
          <Lock size={14} strokeWidth={1.75} />
        )}
      </IconButton>
      {levelMenuOpen && (
        <LevelMenu
          anchorRef={levelBtnRef}
          hiddenLevels={hiddenLevels}
          filterActive={filterActive}
          onToggleLevel={(level, hidden) => outputModels.setLevelHidden(level, hidden)}
          onClearFilters={clearFilters}
          onClose={() => setLevelMenuOpen(false)}
        />
      )}
    </span>
  )
}

function LevelMenu({
  anchorRef,
  hiddenLevels,
  filterActive,
  onToggleLevel,
  onClearFilters,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>
  hiddenLevels: ReadonlySet<LogLevel>
  filterActive: boolean
  onToggleLevel: (level: LogLevel, hidden: boolean) => void
  onClearFilters: () => void
  onClose: () => void
}) {
  const anchor = anchorRef.current
  if (!anchor) return null
  const rect = anchor.getBoundingClientRect()
  return (
    <AnchoredSurface
      x={rect.left}
      y={rect.bottom}
      placement="bottom-start"
      offset={4}
      onClose={onClose}
      surfaceProps={
        {
          className: styles['levelMenu'],
          'data-testid': 'output-level-menu',
        } as HTMLAttributes<HTMLDivElement>
      }
    >
      {LEVEL_ITEMS.map((item) => {
        const checkboxProps = {
          className: styles['levelItem'],
          checked: !hiddenLevels.has(item.level),
          onChange: (checked: boolean) => onToggleLevel(item.level, !checked),
          label: localize(item.labelKey, item.fallback),
          'data-testid': `output-level-${item.fallback.toLowerCase()}`,
        } as Parameters<typeof Checkbox>[0]
        return <Checkbox key={item.level} {...checkboxProps} />
      })}
      {filterActive && (
        <button
          type="button"
          className={styles['clearFilters']}
          onClick={() => {
            onClearFilters()
            onClose()
          }}
          data-testid="output-filter-clear"
        >
          {localize('output.filter.clear', 'Clear Filters')}
        </button>
      )}
    </AnchoredSurface>
  )
}
