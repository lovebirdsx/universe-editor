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
    case 'commit':
      return strings.promptRefKindCommit
    case 'chatContext':
      return strings.promptRefKindChatContext
  }
}

export interface PromptRefPanelProps {
  readonly trigger: MobilePromptRefTrigger
  readonly suggestions: readonly MobilePromptRefSuggestion[]
  readonly activeIndex: number
  readonly loading: boolean
  readonly failed: boolean
  readonly onPick: (suggestion: MobilePromptRefSuggestion) => void
  /** Second-step header (e.g. "选择提交" or the extension provider label). */
  readonly title?: string | undefined
  /** Shown when the second step can return to the first list. */
  readonly onBack?: (() => void) | undefined
  readonly loadingText?: string | undefined
  readonly emptyText?: string | undefined
}

/**
 * Inline `@` / `#` completion list above the composer. Like the slash panel,
 * rows keep the textarea focused on mouse-down so tapping does not dismiss the
 * soft keyboard, and the label is inserted verbatim (labels may contain spaces).
 * The optional header sits outside the listbox so the options stay valid ARIA.
 */
export function PromptRefPanel({
  trigger,
  suggestions,
  activeIndex,
  loading,
  failed,
  onPick,
  title,
  onBack,
  loadingText,
  emptyText,
}: PromptRefPanelProps) {
  return (
    <div className="composer__commands" data-testid="composer-ref-panel">
      {(title !== undefined || onBack !== undefined) && (
        <div className="composer__ref-header">
          {onBack !== undefined && (
            <button
              type="button"
              className="composer__ref-back"
              data-testid="composer-ref-back"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onBack}
            >
              {strings.promptRefBack}
            </button>
          )}
          {title !== undefined && <span className="composer__ref-title">{title}</span>}
        </div>
      )}
      <div id={PROMPT_REF_LIST_ID} role="listbox" aria-label={title ?? strings.promptRefList}>
        {loading && (
          <div className="composer__ref-status" data-testid="composer-ref-loading">
            {loadingText ?? strings.promptRefLoading}
          </div>
        )}
        {!loading && failed && (
          <div className="composer__ref-status" data-testid="composer-ref-failed">
            {strings.promptRefFailed}
          </div>
        )}
        {!loading && !failed && suggestions.length === 0 && (
          <div className="composer__ref-status" data-testid="composer-ref-empty">
            {emptyText ?? strings.promptRefEmpty}
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
    </div>
  )
}
