/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session block (agent / mode / model / cwd / skill / prompt) shared by the
 *  configuration panel and the create wizard.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { FormField, Input, Textarea } from '@universe-editor/workbench-ui'
import type { TriggerConfigDraft } from './triggerConfigDraft.js'
import styles from './TriggerFields.module.css'

export interface TriggerSessionFieldsProps {
  readonly draft: TriggerConfigDraft
  readonly update: (patch: Partial<TriggerConfigDraft>) => void
  readonly fieldError: (...paths: string[]) => string | undefined
  readonly testIdPrefix: string
}

export function TriggerSessionFields({
  draft,
  update,
  fieldError,
  testIdPrefix,
}: TriggerSessionFieldsProps) {
  return (
    <>
      <div className={styles['row']}>
        <FormField
          label={localize('trigger.manager.config.session.agent', 'Agent')}
          error={fieldError('session.agent')}
        >
          <Input
            value={draft.agent}
            placeholder="claude-code"
            invalid={fieldError('session.agent') !== undefined}
            onChange={(event) => update({ agent: event.target.value })}
            data-testid={`${testIdPrefix}-agent`}
          />
        </FormField>
        <FormField
          label={localize('trigger.manager.config.session.mode', 'Mode')}
          error={fieldError('session.mode')}
        >
          <Input
            value={draft.mode}
            placeholder={localize('trigger.manager.config.session.agentDefault', 'Agent default')}
            invalid={fieldError('session.mode') !== undefined}
            onChange={(event) => update({ mode: event.target.value })}
            data-testid={`${testIdPrefix}-mode`}
          />
        </FormField>
      </div>
      <div className={styles['row']}>
        <FormField
          label={localize('trigger.manager.config.session.model', 'Model')}
          error={fieldError('session.model')}
        >
          <Input
            value={draft.model}
            invalid={fieldError('session.model') !== undefined}
            onChange={(event) => update({ model: event.target.value })}
            data-testid={`${testIdPrefix}-model`}
          />
        </FormField>
        <FormField
          label={localize('trigger.manager.config.session.cwd', 'Working directory')}
          error={fieldError('session.cwd')}
        >
          <Input
            value={draft.cwd}
            placeholder={localize('trigger.manager.config.session.cwdPlaceholder', '.')}
            invalid={fieldError('session.cwd') !== undefined}
            onChange={(event) => update({ cwd: event.target.value })}
            data-testid={`${testIdPrefix}-cwd`}
          />
        </FormField>
      </div>
      <FormField
        label={localize('trigger.manager.config.session.skill', 'Skill')}
        error={fieldError('session.skill')}
        hint={localize(
          'trigger.manager.config.session.skillHint',
          'A skill or a prompt is required.',
        )}
      >
        <Input
          value={draft.skill}
          invalid={fieldError('session.skill') !== undefined}
          onChange={(event) => update({ skill: event.target.value })}
          data-testid={`${testIdPrefix}-skill`}
        />
      </FormField>
      <FormField
        label={localize('trigger.manager.config.session.prompt', 'Prompt')}
        error={fieldError('session.prompt')}
      >
        <Textarea
          value={draft.prompt}
          rows={6}
          invalid={fieldError('session.prompt') !== undefined}
          onChange={(event) => update({ prompt: event.target.value })}
          data-testid={`${testIdPrefix}-prompt`}
        />
      </FormField>
    </>
  )
}
