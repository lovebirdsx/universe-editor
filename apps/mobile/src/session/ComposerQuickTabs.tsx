import type { MobilePromptRefTrigger } from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'

export type ComposerQuickTrigger = '/' | MobilePromptRefTrigger

export interface ComposerQuickTabsProps {
  readonly active: ComposerQuickTrigger
  readonly slashEnabled: boolean
  readonly onSwitch: (trigger: ComposerQuickTrigger) => void
}

interface QuickTab {
  readonly trigger: ComposerQuickTrigger
  readonly glyph: string
  readonly label: string
  readonly ariaLabel: string
  readonly testId: string
  readonly disabled: boolean
}

/**
 * Mode switch pinned above the completion list. It rewrites the leading
 * trigger in place, so the typed query and caret stay exactly where they were.
 */
export function ComposerQuickTabs({ active, slashEnabled, onSwitch }: ComposerQuickTabsProps) {
  const tabs: readonly QuickTab[] = [
    {
      trigger: '/',
      glyph: '/',
      label: strings.composerQuickTabSlash,
      ariaLabel: strings.composerCommands,
      testId: 'composer-quick-tab-command',
      disabled: !slashEnabled,
    },
    {
      trigger: '@',
      glyph: '@',
      label: strings.composerQuickTabFiles,
      ariaLabel: strings.composerQuickFileRef,
      testId: 'composer-quick-tab-file',
      disabled: false,
    },
    {
      trigger: '#',
      glyph: '#',
      label: strings.composerQuickTabContexts,
      ariaLabel: strings.composerQuickContextRef,
      testId: 'composer-quick-tab-context',
      disabled: false,
    },
  ]

  return (
    <div
      className="composer__quick-tabs"
      role="group"
      aria-label={strings.composerQuickEntry}
      data-testid="composer-quick-tabs"
    >
      {tabs.map((tab) => (
        <button
          key={tab.trigger}
          type="button"
          className="composer__quick-tab"
          data-testid={tab.testId}
          aria-label={tab.ariaLabel}
          aria-pressed={active === tab.trigger}
          disabled={tab.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSwitch(tab.trigger)}
        >
          <span className="composer__quick-tab-key" aria-hidden="true">
            {tab.glyph}
          </span>
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  )
}
