/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtendsField — picks the entry this one inherits from. Two things make a plain
 *  text box wrong here: a typo produces a fatal `unknown-extends` that silently
 *  removes every model the provider served, and a chain that loops back does the
 *  same to everything in the loop.
 *
 *  So the picker only offers ids that cannot form a cycle, and the choice is run
 *  through the real resolver before it is written. The candidate filter alone is
 *  not enough — it cannot see depth limits — and the resolver alone is not enough
 *  either, because by then the damage is in the file. Both, in that order.
 *
 *  The summary line under the picker answers the question the picker creates:
 *  "what did I just inherit?" Per-field annotations live on the fields
 *  themselves; this is the overview.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState } from 'react'
import {
  localize,
  resolveProviderEntries,
  type AiModelKnowledge,
  type AiProviderEntry,
} from '@universe-editor/platform'
import { Select } from '@universe-editor/workbench-ui'
import {
  computeExtendsCandidates,
  findInherited,
} from '../../../../shared/ai/providerInheritance.js'
import { issueReasonLabel } from './IssuesSection.js'
import { SavedIndicator } from './SavedIndicator.js'
import type { SavedStamp } from './useProviderField.js'
import styles from '../AiSettingsEditor.module.css'

/** Fields an ancestor can supply. `id` is never inherited. */
const INHERITABLE = [
  'baseUrl',
  'apiKey',
  'defaultProtocol',
  'protocolMap',
  'pricingSource',
  'usageSource',
] as const

interface ExtendsFieldProps {
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly knowledge: Readonly<Record<string, AiModelKnowledge>>
  readonly saved: SavedStamp | undefined
  readonly onChange: (parentId: string | undefined) => void
}

export function ExtendsField({
  provider,
  allProviders,
  knowledge,
  saved,
  onChange,
}: ExtendsFieldProps) {
  const [error, setError] = useState<string | undefined>(undefined)

  const candidates = useMemo(
    () => computeExtendsCandidates(provider.id, allProviders),
    [provider.id, allProviders],
  )

  const inheritedFields = useMemo(
    () =>
      INHERITABLE.filter((field) => provider[field] === undefined).flatMap((field) => {
        const found = findInherited(provider, allProviders, field)
        return found === undefined ? [] : [{ field, from: found.from }]
      }),
    [provider, allProviders],
  )

  const pick = useCallback(
    (next: string) => {
      const parentId = next === '' ? undefined : next
      const patched = allProviders.map((p) => {
        if (p.id !== provider.id) return p
        const copy: AiProviderEntry = { ...p }
        if (parentId === undefined) {
          delete (copy as { extends?: string }).extends
          return copy
        }
        return { ...copy, extends: parentId }
      })
      const { issues } = resolveProviderEntries(patched, knowledge)
      const fatal = issues.find((i) => i.providerId === provider.id && i.fatal)
      if (fatal !== undefined) {
        console.debug('aiModels: extends rejected', {
          provider: provider.id,
          target: parentId,
          reason: fatal.reason,
        })
        setError(issueReasonLabel(fatal.reason))
        return
      }
      setError(undefined)
      onChange(parentId)
    },
    [allProviders, knowledge, onChange, provider.id],
  )

  return (
    <div className={styles['field']} data-testid="ai-extends-field">
      <div className={styles['fieldHeader']}>
        <label className={styles['label']}>{localize('aiModels.extends', 'Inherit from')}</label>
        <SavedIndicator saved={saved} field="extends" />
      </div>
      <Select
        value={provider.extends ?? ''}
        aria-label={localize('aiModels.extends', 'Inherit from')}
        data-testid="ai-extends-select"
        options={[
          { value: '', label: localize('aiModels.extends.none', 'Nothing (standalone entry)') },
          ...candidates.map((id) => ({ value: id, label: id })),
        ]}
        invalid={error !== undefined}
        onChange={pick}
      />
      {error !== undefined && (
        <span className={styles['fieldError']} data-testid="ai-extends-error">
          {localize('aiModels.extends.rejected', 'Not applied: {reason}', { reason: error })}
        </span>
      )}
      <span className={styles['inheritNote']}>
        {provider.extends === undefined
          ? localize(
              'aiModels.extends.hint',
              'Use this for a second access point of the same gateway — the protocol map is replaced wholesale, other fields are overridden one by one.',
            )
          : inheritedFields.length === 0
            ? localize(
                'aiModels.extends.nothingInherited',
                'Every field is set locally, so nothing is currently inherited.',
              )
            : localize('aiModels.extends.summary', 'Inheriting {fields}', {
                fields: inheritedFields.map((f) => `${f.field} (${f.from})`).join(', '),
              })}
      </span>
    </div>
  )
}
