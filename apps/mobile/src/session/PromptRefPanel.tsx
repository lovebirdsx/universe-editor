import type {
  MobilePromptRefSuggestion,
  MobilePromptRefTrigger,
} from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'

export const PROMPT_REF_LIST_ID = 'composer-ref-list'

export function promptRefOptionId(index: number): string {
  return `composer-ref-option-${index}`
}

function kindLabel(kind: MobilePromptRefSuggestion['kind']): string {
  switch (kind) {
    case 'file':
      return strings.promptRefKindFile
    case 'symbol':
      return strings.promptRefKindSymbol
    case 'scmChange':
      return strings.promptRefKindScmChange
    case 'openEditor':
      return strings.promptRefKindOpenEditor
    case 'docs':
      return strings.promptRefKindDocs
  }
}

export interface PromptRefPanelProps {
  readonly trigger: MobilePromptRefTrigger
  readonly suggestions: readonly MobilePromptRefSuggestion[]
  readonly activeIndex: number
  readonly loading: boolean
  readonly failed: boolean
  readonly onPick: (suggestion: MobilePromptRefSuggestion) => void
}

/**
 * Inline `@` / `#` completion list above the composer. Like the slash panel,
 * rows keep the textarea focused on mouse-down so tapping does not dismiss the
 * soft keyboard, and the label is inserted verbatim (labels may contain spaces).
 */
export function PromptRefPanel({
  trigger,
  suggestions,
  activeIndex,
  loading,
  failed,
  onPick,
}: PromptRefPanelProps) {
  return (
    <div
      id={PROMPT_REF_LIST_ID}
      className="composer__commands"
      role="listbox"
      aria-label={strings.promptRefList}
      data-testid="composer-ref-panel"
    >
      {loading && (
        <div className="composer__ref-status" data-testid="composer-ref-loading">
          {strings.promptRefLoading}
        </div>
      )}
      {!loading && failed && (
        <div className="composer__ref-status" data-testid="composer-ref-failed">
          {strings.promptRefFailed}
        </div>
      )}
      {!loading && !failed && suggestions.length === 0 && (
        <div className="composer__ref-status" data-testid="composer-ref-empty">
          {strings.promptRefEmpty}
        </div>
      )}
      {suggestions.map((suggestion, index) => (
        <button
          key={`${suggestion.kind}:${suggestion.uri}:${suggestion.label}:${index}`}
          id={promptRefOptionId(index)}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className="composer__command"
          data-active={index === activeIndex ? 'true' : undefined}
          data-testid="composer-ref-option"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(suggestion)}
        >
          <span className="composer__ref-kind">{kindLabel(suggestion.kind)}</span>
          <span className="composer__command-name">
            {trigger === '@' ? '@' : '#'}
            {suggestion.label}
          </span>
          {suggestion.description !== undefined && suggestion.description !== '' && (
            <span className="composer__command-desc">{suggestion.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}
