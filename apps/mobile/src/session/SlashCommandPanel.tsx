import type { MobileAvailableCommand } from '@universe-editor/mobile-protocol'
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
}

/**
 * Inline suggestion list above the composer. Rows keep the textarea focused on
 * mouse-down so tapping a command does not dismiss the soft keyboard.
 */
export function SlashCommandPanel({ commands, activeIndex, onPick }: SlashCommandPanelProps) {
  return (
    <div
      id={SLASH_COMMAND_LIST_ID}
      className="composer__commands"
      role="listbox"
      aria-label={strings.composerCommands}
      data-testid="composer-command-panel"
    >
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
  )
}
