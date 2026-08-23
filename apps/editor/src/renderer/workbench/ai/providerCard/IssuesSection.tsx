/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IssuesSection — configuration problems reported by resolveProviderEntries,
 *  shown on the card they belong to rather than swallowed. A fatal issue means
 *  the provider serves no models at all, so each reason carries the one concrete
 *  action that resolves it; the extends family also gets a direct escape hatch,
 *  because a broken `extends` cannot be repaired from any other control.
 *--------------------------------------------------------------------------------------------*/

import { localize, type AiProviderIssue } from '@universe-editor/platform'
import { Button } from '@universe-editor/workbench-ui'
import styles from '../AiSettingsEditor.module.css'

export function issueReasonLabel(reason: AiProviderIssue['reason']): string {
  switch (reason) {
    case 'malformed-entry':
      return localize('aiModels.issue.malformedEntry', 'Malformed entry (no string id)')
    case 'invalid-id':
      return localize('aiModels.issue.invalidId', "Invalid id (empty, or contains '/')")
    case 'duplicate-id':
      return localize('aiModels.issue.duplicateId', 'Duplicate id')
    case 'unknown-extends':
      return localize('aiModels.issue.unknownExtends', 'Unknown extends target')
    case 'extends-cycle':
      return localize('aiModels.issue.extendsCycle', 'Extends cycle')
    case 'extends-depth':
      return localize('aiModels.issue.extendsDepth', 'Extends chain too deep')
    case 'no-protocol':
      return localize('aiModels.issue.noProtocol', 'No protocol declared')
    case 'unknown-default-protocol':
      return localize('aiModels.issue.unknownDefaultProtocol', 'Unknown default protocol')
  }
}

export function issueFixHint(reason: AiProviderIssue['reason']): string {
  switch (reason) {
    case 'malformed-entry':
      return localize(
        'aiModels.issue.fix.malformedEntry',
        'This element of providers[] is not an object with a string id. Fix it in aiSettings.json.',
      )
    case 'invalid-id':
      return localize(
        'aiModels.issue.fix.invalidId',
        "A provider id is the first segment of every model id, so it cannot be empty or contain '/'. Rename it in aiSettings.json.",
      )
    case 'duplicate-id':
      return localize(
        'aiModels.issue.fix.duplicateId',
        'Two entries share this id and only the first one is used. Rename or remove one of them.',
      )
    case 'unknown-extends':
      return localize(
        'aiModels.issue.fix.unknownExtends',
        'This entry inherits from an id that does not exist. Point it at an existing provider or clear the inheritance.',
      )
    case 'extends-cycle':
      return localize(
        'aiModels.issue.fix.extendsCycle',
        'The inheritance chain loops back to this entry. Clear the inheritance on one entry in the loop.',
      )
    case 'extends-depth':
      return localize(
        'aiModels.issue.fix.extendsDepth',
        'The inheritance chain is longer than 8 entries. Flatten it by inheriting from an entry closer to the root.',
      )
    case 'no-protocol':
      return localize(
        'aiModels.issue.fix.noProtocol',
        'A provider serves nothing until it declares at least one protocol. Add one under "Protocols & models".',
      )
    case 'unknown-default-protocol':
      return localize(
        'aiModels.issue.fix.unknownDefaultProtocol',
        "The default protocol is not in this provider's protocol map. Pick a declared one, or add that protocol.",
      )
  }
}

const EXTENDS_REASONS: ReadonlySet<AiProviderIssue['reason']> = new Set([
  'unknown-extends',
  'extends-cycle',
  'extends-depth',
])

export function IssuesSection({
  issues,
  onClearExtends,
}: {
  readonly issues: readonly AiProviderIssue[]
  readonly onClearExtends?: (() => void) | undefined
}) {
  if (issues.length === 0) return null
  const showClearExtends =
    onClearExtends !== undefined && issues.some((i) => EXTENDS_REASONS.has(i.reason))

  return (
    <div className={styles['issues']} data-testid="ai-provider-issues">
      {issues.map((issue) => (
        <div key={issue.reason} className={styles['issueRow']}>
          <span className={styles['issueBadge']} data-tooltip={issue.detail}>
            {issueReasonLabel(issue.reason)}
            {issue.detail ? ` (${issue.detail})` : ''}
          </span>
          <span className={styles['issueHint']}>{issueFixHint(issue.reason)}</span>
        </div>
      ))}
      {showClearExtends && (
        <Button size="sm" variant="ghost" onClick={onClearExtends}>
          {localize('aiModels.issue.clearExtends', 'Clear inheritance')}
        </Button>
      )}
    </div>
  )
}
