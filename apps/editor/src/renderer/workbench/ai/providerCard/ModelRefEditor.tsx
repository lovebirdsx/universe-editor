/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ModelRefEditor — the advanced form behind one entry of a static model list.
 *  Three things live here that a bare wire name cannot express: the endpoint
 *  renamed the model (`id` differs from the knowledge key), the model should
 *  borrow another entry's knowledge (`ref`), and the translation dropped a
 *  capability.
 *
 *  Capabilities are deliberately one-way. `narrowCapabilities` in the resolver
 *  only ever applies `false`, so a checkbox that could turn one *on* would lie:
 *  the value would be written to the file and then ignored. Checkboxes for
 *  capabilities the knowledge base does not already grant are therefore disabled
 *  with an explanation, not hidden — hiding them makes the rule invisible.
 *
 *  Committing runs the draft back through `refFromDraft`, which collapses to a
 *  plain string whenever the object form would add nothing.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react'
import { localize, type AiModelKnowledge, type AiProtocolModelRef } from '@universe-editor/platform'
import { Button, Checkbox, Input, Select } from '@universe-editor/workbench-ui'
import {
  AI_CAPABILITY_KEYS,
  draftFromRef,
  refFromDraft,
  type AiCapabilityKey,
  type ModelRefDraft,
} from '../../../../shared/ai/protocolMapEdit.js'
import styles from '../AiSettingsEditor.module.css'

/** Knowledge keys offered in the ref picker before it becomes unusable as a list. */
const REF_CANDIDATE_CAP = 300

interface ModelRefEditorProps {
  readonly value: AiProtocolModelRef
  readonly knowledge: Readonly<Record<string, AiModelKnowledge>>
  readonly onCommit: (next: AiProtocolModelRef) => void
  readonly onCancel: () => void
}

export function ModelRefEditor({ value, knowledge, onCommit, onCancel }: ModelRefEditorProps) {
  const [draft, setDraft] = useState<ModelRefDraft>(() => draftFromRef(value))

  const refOptions = useMemo(() => {
    const keys = Object.keys(knowledge).sort().slice(0, REF_CANDIDATE_CAP)
    return [
      { value: '', label: localize('aiModels.ref.none', '(same as wire name)'), text: '' },
      ...keys.map((key) => ({ value: key, label: key, text: key })),
    ]
  }, [knowledge])

  // Which capabilities the resolver would actually let us turn off: only the
  // ones the knowledge base grants in the first place.
  const baseCapabilities = knowledge[draft.ref !== '' ? draft.ref : draft.id]?.capabilities

  const toggleCapability = (key: AiCapabilityKey, disabled: boolean) => {
    setDraft((d) => ({
      ...d,
      disabled: disabled ? [...d.disabled, key] : d.disabled.filter((k) => k !== key),
    }))
  }

  const commit = () => {
    const next = refFromDraft(draft)
    if (next === undefined) return
    console.debug('aiModels: model ref committed', {
      collapsed: typeof next === 'string',
      disabled: draft.disabled,
    })
    onCommit(next)
  }

  return (
    <div className={styles['refEditor']} data-testid="ai-model-ref-editor">
      <div className={styles['configRow']}>
        <div className={styles['configMeta']}>
          <span className={styles['configKey']}>
            {localize('aiModels.ref.wireName', 'Wire name')}
          </span>
          <span className={styles['configDesc']}>
            {localize(
              'aiModels.ref.wireName.desc',
              'The model name this endpoint expects. Leave empty to use the knowledge key.',
            )}
          </span>
        </div>
        <div className={styles['configControl']}>
          <Input
            value={draft.id}
            aria-label={localize('aiModels.ref.wireName', 'Wire name')}
            onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
          />
        </div>
      </div>

      <div className={styles['configRow']}>
        <div className={styles['configMeta']}>
          <span className={styles['configKey']}>
            {localize('aiModels.ref.knowledgeRef', 'Knowledge entry')}
          </span>
          <span className={styles['configDesc']}>
            {localize(
              'aiModels.ref.knowledgeRef.desc',
              'Where context window, vendor and capabilities come from. Pick this when the gateway renamed a known model.',
            )}
          </span>
        </div>
        <div className={styles['configControl']}>
          <Select
            value={draft.ref}
            options={refOptions}
            aria-label={localize('aiModels.ref.knowledgeRef', 'Knowledge entry')}
            onChange={(next) => setDraft((d) => ({ ...d, ref: next }))}
          />
        </div>
      </div>

      <div className={styles['configRow']}>
        <div className={styles['configMeta']}>
          <span className={styles['configKey']}>
            {localize('aiModels.ref.capabilities', 'Capabilities')}
          </span>
          <span className={styles['configDesc']}>
            {localize(
              'aiModels.ref.capabilities.desc',
              'Capabilities can only be turned off, never on — a translating gateway can lose a feature, it cannot invent one.',
            )}
          </span>
        </div>
        <div className={styles['configControl']}>
          {AI_CAPABILITY_KEYS.map((key) => {
            const granted = baseCapabilities?.[key] === true
            const off = draft.disabled.includes(key)
            return (
              <Checkbox
                key={key}
                checked={granted && !off}
                disabled={!granted}
                label={key}
                data-testid={`ai-capability-${key}`}
                onChange={(checked) => toggleCapability(key, !checked)}
              />
            )
          })}
          {baseCapabilities === undefined && (
            <span className={styles['configDesc']}>
              {localize(
                'aiModels.ref.capabilities.unknown',
                'This model is not in the knowledge base, so it has no capabilities to narrow.',
              )}
            </span>
          )}
        </div>
      </div>

      <div className={styles['configActions']}>
        <Button size="sm" disabled={refFromDraft(draft) === undefined} onClick={commit}>
          {localize('aiModels.ref.save', 'Save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {localize('aiModels.ref.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}
