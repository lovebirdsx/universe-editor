/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AddModelDialog — creates one entry in the `models` knowledge base. The only
 *  input is the key, because the key is the one thing that cannot be changed
 *  later without rewriting whatever references it: it is the knowledge id a
 *  provider's protocolMap resolves against, and for a bare string ref it is also
 *  the wire name the endpoint expects.
 *
 *  A key that already exists in the built-in catalog is not an error — it is an
 *  override, so the dialog says so and changes the action label. The entry is
 *  created empty either way: fields materialize as the user touches them, which
 *  keeps the built-in values live instead of freezing a copy.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react'
import { localize } from '@universe-editor/platform'
import { Button, FocusScopeOverlay, Input } from '@universe-editor/workbench-ui'
import { isValidKnowledgeKey } from '../../../../shared/ai/modelKnowledgeEdit.js'
import styles from '../AiSettingsEditor.module.css'

export interface AddModelDialogProps {
  /** Keys already present in the user layer — a duplicate would silently edit it. */
  readonly existingKeys: readonly string[]
  /** Keys present in the built-in catalog — hitting one means "override", not "conflict". */
  readonly builtinKeys: readonly string[]
  readonly onClose: () => void
  readonly onCreate: (key: string) => void
}

export function AddModelDialog({
  existingKeys,
  builtinKeys,
  onClose,
  onCreate,
}: AddModelDialogProps) {
  const [key, setKey] = useState('')
  const trimmed = key.trim()

  const error = useMemo(() => {
    if (trimmed === '') return localize('aiKnowledge.add.keyEmpty', 'A model key is required.')
    if (!isValidKnowledgeKey(trimmed))
      return localize('aiKnowledge.add.keySlash', "A model key must not contain '/'.")
    if (existingKeys.includes(trimmed))
      return localize('aiKnowledge.add.keyExists', 'That model key already exists.')
    return undefined
  }, [existingKeys, trimmed])

  const overridesBuiltin = error === undefined && builtinKeys.includes(trimmed)

  const title = localize('aiKnowledge.add.title', 'Add Model')
  const label = localize('aiKnowledge.add.key', 'Model key')

  return (
    <FocusScopeOverlay visible onEscape={onClose}>
      <div className={styles['dialogBackdrop']} onClick={onClose} />
      <div className={styles['dialog']} role="dialog" aria-modal="true">
        <h2 className={styles['dialogTitle']}>{title}</h2>

        <div className={styles['dialogBody']}>
          <div className={styles['field']}>
            <label className={styles['label']}>{label}</label>
            <Input
              autoFocus
              value={key}
              invalid={trimmed !== '' && error !== undefined}
              placeholder="kimi-k3"
              aria-label={label}
              data-testid="ai-knowledge-add-key"
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && error === undefined) onCreate(trimmed)
              }}
            />
            {trimmed !== '' && error !== undefined && (
              <span className={styles['dialogFieldError']}>{error}</span>
            )}
            <span className={styles['ratesLine']}>
              {overridesBuiltin
                ? localize(
                    'aiKnowledge.add.overrideHint',
                    'A built-in model already uses this key. The entry starts empty and each field you set overrides the built-in one.',
                  )
                : localize(
                    'aiKnowledge.add.keyHint',
                    'The key a provider protocolMap resolves against. For a bare string reference it is also the wire name sent to the endpoint.',
                  )}
            </span>
          </div>
        </div>

        <div className={styles['dialogActions']}>
          <Button variant="ghost" onClick={onClose}>
            {localize('aiKnowledge.add.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={error !== undefined}
            onClick={() => onCreate(trimmed)}
          >
            {overridesBuiltin
              ? localize('aiKnowledge.add.override', 'Override')
              : localize('aiKnowledge.add.create', 'Create')}
          </Button>
        </div>
      </div>
    </FocusScopeOverlay>
  )
}
