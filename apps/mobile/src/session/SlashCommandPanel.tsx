import type { MobileAvailableCommand } from '@universe-editor/mobile-protocol'
import type { ReactNode } from 'react'
import { strings } from '../strings.js'
import { formatCommandName } from './slashCommands.js'

export const SLASH_COMMAND_LIST_ID = 'composer-command-list'

export function slashCommandOptionId(index: number): string {
  return `composer-command-option-${index}`
}

export interface SlashCommandPanelProps {
  readonly commands: readonly MobileAvailableCommand[]
  readonly activeIndex: number
  readonly onPick: (command: MobileAvailableCommand) => void
  /** Quick-entry mode switch, pinned above the scrollable list. */
  readonly tabs?: ReactNode
}

/**
 * Inline suggestion list above the composer. Rows keep the textarea focused on
 * mouse-down so tapping a command does not dismiss the soft keyboard.
 */
export function SlashCommandPanel({ commands, activeIndex, onPick, tabs }: SlashCommandPanelProps) {
  return (
    <div className="composer__commands" data-testid="composer-command-panel">
      {tabs}
      <div
        id={SLASH_COMMAND_LIST_ID}
        className="composer__command-list"
        role="listbox"
        aria-label={strings.composerCommands}
      >
        {commands.length === 0 && (
          <div className="composer__ref-status" data-testid="composer-command-empty">
            {strings.composerCommandEmpty}
          </div>
        )}
        {commands.map((command, index) => (
          <button
            key={`${command.name}:${index}`}
            id={slashCommandOptionId(index)}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className="composer__command"
            data-active={index === activeIndex ? 'true' : undefined}
            data-testid="composer-command-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(command)}
          >
            <span className="composer__command-name">{formatCommandName(command.name)}</span>
            {command.inputHint !== undefined && (
              <span className="composer__command-hint">{`<${command.inputHint}>`}</span>
            )}
            <span className="composer__command-desc">{command.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
