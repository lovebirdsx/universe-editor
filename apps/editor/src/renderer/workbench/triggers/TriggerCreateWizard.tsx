/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerCreateWizard — a four-step modal that appends a trigger definition to
 *  a workspace's triggers.json. Templates only prefill the source (and Swarm
 *  actions); everything remains editable. A missing file is created with an
 *  empty config, and validation runs through the same parser as the scheduler.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IEditorGroupsService,
  IFileService,
  INotificationService,
  IWorkspaceService,
  IUriIdentityService,
  Severity,
  URI,
  localize,
} from '@universe-editor/platform'
import {
  Button,
  Checkbox,
  FocusScopeOverlay,
  Input,
  Select,
  Textarea,
  Toggle,
} from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { parseTriggerDocument } from '../../../shared/triggers/configDocument.js'
import { isValidTriggerId, workspaceDisplayPath } from '../../../shared/triggers/configParse.js'
import { TRIGGER_ACTION_TYPES } from '../../../shared/triggers/types.js'
import {
  createTrigger,
  isTriggerConfigEditorDirty,
  readTriggerConfig,
  triggersConfigUri,
} from '../../services/triggers/triggerConfigFileService.js'
import { useService } from '../useService.js'
import { emptyDraft, validateTriggerDraft, type TriggerConfigDraft } from './triggerConfigDraft.js'
import { ACTION_LABELS, Field, errorText } from './triggerFormParts.js'
import styles from './TriggerManager.module.css'

export interface TriggerCreateWizardProps {
  readonly onClose: () => void
  /** The new trigger's workspace URI and id; the manager selects it once listed. */
  readonly onCreated: (workspaceUri: URI, triggerId: string) => void
}

type TemplateId = 'manual' | 'schedule-cron' | 'schedule-interval' | 'poll' | 'swarm' | 'blank'

interface Template {
  readonly id: TemplateId
  readonly label: string
  readonly description: string
}

const TEMPLATES: readonly Template[] = [
  {
    id: 'manual',
    label: localize('trigger.manager.wizard.template.manual', 'Manual'),
    description: localize(
      'trigger.manager.wizard.template.manualDesc',
      'Runs only when you start it from the manager or a command.',
    ),
  },
  {
    id: 'schedule-cron',
    label: localize('trigger.manager.wizard.template.cron', 'Scheduled (cron)'),
    description: localize(
      'trigger.manager.wizard.template.cronDesc',
      'Runs on a cron expression, e.g. every weekday at 09:00.',
    ),
  },
  {
    id: 'schedule-interval',
    label: localize('trigger.manager.wizard.template.interval', 'Scheduled (interval)'),
    description: localize('trigger.manager.wizard.template.intervalDesc', 'Runs every N minutes.'),
  },
  {
    id: 'poll',
    label: localize('trigger.manager.wizard.template.poll', 'Command poll'),
    description: localize(
      'trigger.manager.wizard.template.pollDesc',
      'Runs when a command prints new items (a JSON array).',
    ),
  },
  {
    id: 'swarm',
    label: localize('trigger.manager.wizard.template.swarm', 'Swarm review'),
    description: localize(
      'trigger.manager.wizard.template.swarmDesc',
      'Runs once for every Swarm review that needs action.',
    ),
  },
  {
    id: 'blank',
    label: localize('trigger.manager.wizard.template.blank', 'Blank'),
    description: localize(
      'trigger.manager.wizard.template.blankDesc',
      'Start from defaults and fill in every field yourself.',
    ),
  },
]

const STEP_TITLES: readonly string[] = [
  localize('trigger.manager.wizard.step.template', 'Template'),
  localize('trigger.manager.wizard.step.basics', 'Basics'),
  localize('trigger.manager.wizard.step.session', 'Session'),
  localize('trigger.manager.wizard.step.limits', 'Limits and permissions'),
]

interface WorkspaceOption {
  readonly uri: string
  readonly label: string
  readonly available: boolean
}

function templatePatch(template: TemplateId): Partial<TriggerConfigDraft> {
  switch (template) {
    case 'manual':
    case 'blank':
      return {
        sourceType: 'manual',
        cron: '',
        everyMin: '',
        onMissed: 'skip',
        intervalSec: '600',
        command: '',
        pollTimeoutSec: '60',
        keyField: 'id',
        allowedActions: [],
      }
    case 'schedule-cron':
      return { sourceType: 'schedule', cron: '0 9 * * 1', everyMin: '', onMissed: 'skip' }
    case 'schedule-interval':
      return { sourceType: 'schedule', cron: '', everyMin: '10', onMissed: 'skip' }
    case 'poll':
      return {
        sourceType: 'poll',
        intervalSec: '600',
        command: 'node scripts/fetch.js',
        pollTimeoutSec: '60',
        keyField: 'id',
      }
    case 'swarm':
      return {
        sourceType: 'swarm-review',
        allowedActions: ['swarm.vote', 'swarm.comment'],
      }
  }
}

const STEP_COUNT = STEP_TITLES.length

export function TriggerCreateWizard({ onClose, onCreated }: TriggerCreateWizardProps) {
  const files = useService(IFileService)
  const notifications = useService(INotificationService)
  const workspace = useService(IWorkspaceService)
  const triggers = useService(ITriggerMainService)
  const groups = useService(IEditorGroupsService)
  const uriIdentity = useService(IUriIdentityService)

  const [step, setStep] = useState(0)
  const [template, setTemplate] = useState<TemplateId>('manual')
  const [draft, setDraft] = useState<TriggerConfigDraft>(() => emptyDraft())
  const [id, setId] = useState('')
  const [workspaceValue, setWorkspaceValue] = useState('')
  const [options, setOptions] = useState<readonly WorkspaceOption[]>([])
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true)
  const [workspacesError, setWorkspacesError] = useState<string | undefined>(undefined)
  const [existingIds, setExistingIds] = useState<ReadonlySet<string>>(new Set())
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoadingWorkspaces(true)
    void triggers.listWorkspaces().then(
      (registered) => {
        if (cancelled) return
        const next: WorkspaceOption[] = []
        const seen = new Set<string>()
        const current = workspace.current?.folder
        if (current !== undefined) {
          const uri = current.toString()
          seen.add(uri)
          next.push({ uri, label: workspaceDisplayPath(uri), available: true })
        }
        for (const entry of registered) {
          if (seen.has(entry.workspace)) continue
          seen.add(entry.workspace)
          next.push({
            uri: entry.workspace,
            label: `${entry.name} · ${workspaceDisplayPath(entry.workspace)}`,
            available: entry.available,
          })
        }
        setOptions(next)
        setWorkspaceValue((value) => (value.length > 0 ? value : (next[0]?.uri ?? '')))
        setWorkspacesError(undefined)
        setLoadingWorkspaces(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setWorkspacesError(errorText(err))
        setLoadingWorkspaces(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [triggers, workspace])

  const workspaceUri = useMemo(() => {
    try {
      return workspaceValue.length > 0 ? URI.parse(workspaceValue) : undefined
    } catch {
      return undefined
    }
  }, [workspaceValue])

  useEffect(() => {
    if (workspaceUri === undefined) {
      setExistingIds(new Set())
      setFileError(undefined)
      return
    }
    let cancelled = false
    void readTriggerConfig(files, workspaceUri).then(
      (snapshot) => {
        if (cancelled) return
        if (snapshot === undefined) {
          setExistingIds(new Set())
          setFileError(undefined)
          return
        }
        const parsed = parseTriggerDocument(snapshot.text)
        if (parsed.kind !== 'ok') {
          setExistingIds(new Set())
          setFileError(
            parsed.kind === 'invalid'
              ? parsed.error
              : localize('trigger.manager.wizard.fileMissing', 'triggers.json could not be read.'),
          )
          return
        }
        setExistingIds(
          new Set([
            ...parsed.value.triggers.map((entry) => entry.id),
            ...parsed.value.invalid.map((entry) => entry.id),
          ]),
        )
        setFileError(undefined)
      },
      (err: unknown) => {
        if (cancelled) return
        setFileError(errorText(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [files, workspaceUri])

  const update = useCallback((patch: Partial<TriggerConfigDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }, [])

  const chooseTemplate = useCallback(
    (next: TemplateId) => {
      setTemplate(next)
      update(templatePatch(next))
      setSubmitError(undefined)
    },
    [update],
  )

  const trimmedId = id.trim()
  const idError = useMemo(() => {
    if (trimmedId.length === 0) {
      return localize('trigger.manager.wizard.idRequired', 'ID is required.')
    }
    if (!isValidTriggerId(trimmedId)) {
      return localize(
        'trigger.manager.wizard.idPattern',
        'Use lowercase letters, digits and dashes (max 64 characters, starting with a letter or digit).',
      )
    }
    if (existingIds.has(trimmedId)) {
      return localize(
        'trigger.manager.wizard.idDuplicate',
        'This workspace already has a trigger with that ID.',
      )
    }
    return undefined
  }, [existingIds, trimmedId])

  const nameError =
    draft.name.trim().length === 0
      ? localize('trigger.manager.wizard.nameRequired', 'Name is required.')
      : undefined

  const validation = useMemo(
    () => validateTriggerDraft(trimmedId.length > 0 ? trimmedId : 'pending', draft),
    [draft, trimmedId],
  )

  const basicsValid =
    idError === undefined &&
    nameError === undefined &&
    workspaceUri !== undefined &&
    fileError === undefined

  const next = useCallback(() => {
    setSubmitError(undefined)
    setStep((current) => Math.min(STEP_COUNT - 1, current + 1))
  }, [])

  const back = useCallback(() => {
    setSubmitError(undefined)
    setStep((current) => Math.max(0, current - 1))
  }, [])

  const create = useCallback(async () => {
    if (creating) return
    if (workspaceUri === undefined) {
      setSubmitError(localize('trigger.manager.wizard.noWorkspace', 'Select a workspace first.'))
      return
    }
    if (idError !== undefined || nameError !== undefined || fileError !== undefined) {
      setStep(1)
      return
    }
    const nextId = trimmedId
    const result = validateTriggerDraft(nextId, draft)
    if (result.config === undefined) {
      setSubmitError(result.errors.join('; '))
      return
    }
    const configUri = triggersConfigUri(workspaceUri)
    setCreating(true)
    setSubmitError(undefined)
    try {
      const saved = await createTrigger(files, workspaceUri, result.config, {
        isEditorDirty: () => isTriggerConfigEditorDirty({ groups, uriIdentity }, configUri),
      })
      if (!mountedRef.current) return
      switch (saved.kind) {
        case 'ok': {
          // A workspace with no prior triggers.json was never discovered by main,
          // so its watcher is not running yet. `ensureConfigFile` registers and
          // attaches the folder (it does not overwrite our freshly written file).
          // The file is already on disk, so a failure here is recoverable and must
          // tell the user how — swallowing it would show a trigger that never loads.
          try {
            await triggers.ensureConfigFile(workspaceUri.toString())
          } catch {
            if (!mountedRef.current) return
            notifications.notify({
              severity: Severity.Warning,
              message: localize(
                'trigger.manager.wizard.ensureFailed',
                'The trigger was written to triggers.json, but the workspace could not be registered for live reload. Reopen the workspace or run "Triggers: Open Configuration" to load it.',
              ),
            })
          }
          if (!mountedRef.current) return
          notifications.notify({
            severity: Severity.Info,
            message: localize(
              'trigger.manager.wizard.created',
              'Trigger "{name}" was created. Confirm it before it can run.',
              { name: result.config.name },
            ),
          })
          onCreated(workspaceUri, nextId)
          onClose()
          return
        }
        case 'dirty-editor':
          setSubmitError(
            localize(
              'trigger.manager.config.dirtyEditor',
              'triggers.json has unsaved changes in the editor. Save or revert it before saving here.',
            ),
          )
          return
        case 'duplicate-id':
          setStep(1)
          setSubmitError(
            localize(
              'trigger.manager.wizard.idDuplicate',
              'This workspace already has a trigger with that ID.',
            ),
          )
          return
        case 'invalid':
          setSubmitError(
            localize('trigger.manager.wizard.invalid', 'Cannot create the trigger: {error}', {
              error: saved.error,
            }),
          )
          return
        case 'conflict':
          setSubmitError(
            localize(
              'trigger.manager.wizard.conflict',
              'triggers.json changed while you were filling in the form. Close the wizard and try again.',
            ),
          )
          return
        default:
          setSubmitError(
            localize('trigger.manager.wizard.failed', 'The trigger could not be created.'),
          )
          return
      }
    } catch (err) {
      setSubmitError(
        localize('trigger.manager.wizard.failedWithError', 'Creating the trigger failed: {error}', {
          error: errorText(err),
        }),
      )
    } finally {
      setCreating(false)
    }
  }, [
    creating,
    draft,
    files,
    fileError,
    groups,
    idError,
    nameError,
    notifications,
    onClose,
    onCreated,
    trimmedId,
    triggers,
    uriIdentity,
    workspaceUri,
  ])

  return (
    <FocusScopeOverlay
      visible
      onEscape={() => {
        if (!creating) onClose()
      }}
    >
      <div
        className={styles['dialogBackdrop']}
        onClick={() => {
          if (!creating) onClose()
        }}
      />
      <div
        className={styles['dialog']}
        role="dialog"
        aria-modal="true"
        aria-label={localize('trigger.manager.wizard.title', 'New Trigger')}
        data-testid="trigger-manager-wizard"
      >
        <h2 className={styles['dialogTitle']}>
          {localize('trigger.manager.wizard.title', 'New Trigger')}
        </h2>

        <ol className={styles['wizardSteps']}>
          {STEP_TITLES.map((title, index) => (
            <li
              key={title}
              className={
                index === step
                  ? `${styles['wizardStep'] ?? ''} ${styles['wizardStepActive'] ?? ''}`
                  : styles['wizardStep']
              }
              data-testid={`trigger-manager-wizard-step-${index}`}
              data-active={index === step}
            >
              {title}
            </li>
          ))}
        </ol>

        <div className={styles['dialogBody']} data-testid={`trigger-manager-wizard-body-${step}`}>
          {step === 0 && (
            <div className={styles['templateGrid']}>
              {TEMPLATES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={
                    template === entry.id
                      ? `${styles['templateCard'] ?? ''} ${styles['templateCardSelected'] ?? ''}`
                      : styles['templateCard']
                  }
                  data-testid={`trigger-manager-wizard-template-${entry.id}`}
                  aria-pressed={template === entry.id}
                  onClick={() => chooseTemplate(entry.id)}
                >
                  <span className={styles['templateName']}>{entry.label}</span>
                  <span className={styles['templateDescription']}>{entry.description}</span>
                </button>
              ))}
            </div>
          )}

          {step === 1 && (
            <>
              <Field label={localize('trigger.manager.wizard.workspace', 'Workspace')}>
                <Select<string>
                  value={workspaceValue}
                  disabled={loadingWorkspaces || options.length <= 1}
                  onChange={setWorkspaceValue}
                  options={options.map((option) => ({
                    value: option.uri,
                    label: option.label,
                    disabled: !option.available,
                  }))}
                  aria-label={localize('trigger.manager.wizard.workspace', 'Workspace')}
                  wrapItems
                  data-testid="trigger-manager-wizard-workspace"
                />
              </Field>
              {loadingWorkspaces && (
                <p
                  className={styles['note']}
                  data-testid="trigger-manager-wizard-workspaces-loading"
                >
                  {localize('trigger.manager.wizard.loadingWorkspaces', 'Loading workspaces…')}
                </p>
              )}
              {workspacesError !== undefined && (
                <p className={styles['fieldError']}>
                  {localize(
                    'trigger.manager.wizard.workspacesFailed',
                    'Could not list workspaces: {error}',
                    {
                      error: workspacesError,
                    },
                  )}
                </p>
              )}
              {options.length === 0 && !loadingWorkspaces && workspacesError === undefined && (
                <p className={styles['notice']} data-testid="trigger-manager-wizard-no-workspace">
                  {localize(
                    'trigger.manager.wizard.openWorkspaceFirst',
                    'Open a folder workspace first. Trigger definitions live inside a workspace.',
                  )}
                </p>
              )}
              {fileError !== undefined && (
                <p className={styles['fieldError']} data-testid="trigger-manager-wizard-file-error">
                  {localize(
                    'trigger.manager.wizard.fileInvalid',
                    'This workspace triggers.json cannot be extended: {error}',
                    { error: fileError },
                  )}
                </p>
              )}
              <Field
                label={localize('trigger.manager.wizard.id', 'ID')}
                error={idError}
                hint={localize(
                  'trigger.manager.wizard.idHint',
                  'Unique inside the workspace; used in file and state names.',
                )}
              >
                <Input
                  value={id}
                  invalid={trimmedId.length > 0 && idError !== undefined}
                  onChange={(event) => setId(event.target.value)}
                  placeholder="daily-digest"
                  data-testid="trigger-manager-wizard-id"
                />
              </Field>
              <Field label={localize('trigger.manager.wizard.name', 'Name')} error={nameError}>
                <Input
                  value={draft.name}
                  invalid={nameError !== undefined}
                  onChange={(event) => update({ name: event.target.value })}
                  data-testid="trigger-manager-wizard-name"
                />
              </Field>
              <div className={styles['toggleField']}>
                <span className={styles['fieldLabel']}>
                  {localize('trigger.manager.wizard.enabled', 'Enabled')}
                </span>
                <Toggle
                  checked={draft.enabled}
                  onChange={(enabled) => update({ enabled })}
                  aria-label={localize('trigger.manager.wizard.enabled', 'Enabled')}
                  data-testid="trigger-manager-wizard-enabled"
                />
              </div>
              <p className={styles['note']}>
                {localize(
                  'trigger.manager.wizard.confirmNote',
                  'A new trigger needs confirmation before it can run unattended.',
                )}
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <div className={styles['fieldRow']}>
                <Field label={localize('trigger.manager.config.session.agent', 'Agent')}>
                  <Input
                    value={draft.agent}
                    placeholder="claude-code"
                    onChange={(event) => update({ agent: event.target.value })}
                    data-testid="trigger-manager-wizard-agent"
                  />
                </Field>
                <Field label={localize('trigger.manager.config.session.mode', 'Mode')}>
                  <Input
                    value={draft.mode}
                    placeholder={localize(
                      'trigger.manager.config.session.agentDefault',
                      'Agent default',
                    )}
                    onChange={(event) => update({ mode: event.target.value })}
                    data-testid="trigger-manager-wizard-mode"
                  />
                </Field>
              </div>
              <div className={styles['fieldRow']}>
                <Field label={localize('trigger.manager.config.session.model', 'Model')}>
                  <Input
                    value={draft.model}
                    onChange={(event) => update({ model: event.target.value })}
                    data-testid="trigger-manager-wizard-model"
                  />
                </Field>
                <Field label={localize('trigger.manager.config.session.cwd', 'Working directory')}>
                  <Input
                    value={draft.cwd}
                    placeholder={localize('trigger.manager.config.session.cwdPlaceholder', '.')}
                    onChange={(event) => update({ cwd: event.target.value })}
                    data-testid="trigger-manager-wizard-cwd"
                  />
                </Field>
              </div>
              <Field
                label={localize('trigger.manager.config.session.skill', 'Skill')}
                hint={localize(
                  'trigger.manager.config.session.skillHint',
                  'A skill or a prompt is required.',
                )}
              >
                <Input
                  value={draft.skill}
                  onChange={(event) => update({ skill: event.target.value })}
                  data-testid="trigger-manager-wizard-skill"
                />
              </Field>
              <Field label={localize('trigger.manager.config.session.prompt', 'Prompt')}>
                <Textarea
                  value={draft.prompt}
                  rows={6}
                  onChange={(event) => update({ prompt: event.target.value })}
                  data-testid="trigger-manager-wizard-prompt"
                />
              </Field>
              <div className={styles['toggleField']}>
                <span className={styles['fieldLabel']}>
                  {localize(
                    'trigger.manager.config.showSession',
                    'Reveal the session while it runs (visible windows only)',
                  )}
                </span>
                <Toggle
                  checked={draft.showSession}
                  onChange={(showSession) => update({ showSession })}
                  aria-label={localize(
                    'trigger.manager.config.showSession',
                    'Reveal the session while it runs (visible windows only)',
                  )}
                  data-testid="trigger-manager-wizard-show-session"
                />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <Field
                label={localize('trigger.manager.config.budget.maxCost', 'Maximum cost (USD)')}
                hint={localize(
                  'trigger.manager.config.budget.maxCostHint',
                  'Empty = no cost limit.',
                )}
              >
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.maxCostUsd}
                  onChange={(event) => update({ maxCostUsd: event.target.value })}
                  data-testid="trigger-manager-wizard-max-cost"
                />
              </Field>
              <div className={styles['fieldRow']}>
                <Field
                  label={localize('trigger.manager.config.budget.timeout', 'Run timeout (minutes)')}
                >
                  <Input
                    type="number"
                    min={1}
                    value={draft.timeoutMin}
                    onChange={(event) => update({ timeoutMin: event.target.value })}
                    data-testid="trigger-manager-wizard-timeout"
                  />
                </Field>
                <Field
                  label={localize(
                    'trigger.manager.config.budget.approvalTimeout',
                    'Approval timeout (minutes)',
                  )}
                >
                  <Input
                    type="number"
                    min={1}
                    value={draft.approvalTimeoutMin}
                    onChange={(event) => update({ approvalTimeoutMin: event.target.value })}
                    data-testid="trigger-manager-wizard-approval-timeout"
                  />
                </Field>
              </div>
              <div className={styles['fieldRow']}>
                <Field label={localize('trigger.manager.config.concurrency', 'Concurrency')}>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={draft.concurrency}
                    onChange={(event) => update({ concurrency: event.target.value })}
                    data-testid="trigger-manager-wizard-concurrency"
                  />
                </Field>
                <Field label={localize('trigger.manager.config.overflow', 'When busy')}>
                  <Select<'queue' | 'drop'>
                    value={draft.overflow}
                    onChange={(overflow) => update({ overflow })}
                    options={[
                      {
                        value: 'queue',
                        label: localize('trigger.manager.config.overflow.queue', 'Queue'),
                      },
                      {
                        value: 'drop',
                        label: localize('trigger.manager.config.overflow.drop', 'Drop'),
                      },
                    ]}
                    aria-label={localize('trigger.manager.config.overflow', 'When busy')}
                    data-testid="trigger-manager-wizard-overflow"
                  />
                </Field>
              </div>
              <Field label={localize('trigger.manager.config.allowedActions', 'Allowed actions')}>
                <div className={styles['actionList']}>
                  {TRIGGER_ACTION_TYPES.map((action) => (
                    <Checkbox
                      key={action}
                      checked={draft.allowedActions.includes(action)}
                      onChange={(checked) =>
                        update({
                          allowedActions: checked
                            ? [...draft.allowedActions, action]
                            : draft.allowedActions.filter((entry) => entry !== action),
                        })
                      }
                      label={ACTION_LABELS[action]}
                      data-testid={`trigger-manager-wizard-action-${action}`}
                    />
                  ))}
                </div>
              </Field>
            </>
          )}

          {submitError !== undefined && (
            <p className={styles['fieldError']} data-testid="trigger-manager-wizard-error">
              {submitError}
            </p>
          )}
          {step > 0 && validation.errors.length > 0 && submitError === undefined && (
            <div className={styles['notice']} data-testid="trigger-manager-wizard-validation">
              <ul className={styles['errorList']}>
                {validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className={styles['dialogActions']}>
          <Button
            size="sm"
            disabled={creating}
            onClick={onClose}
            data-testid="trigger-manager-wizard-cancel"
          >
            {localize('trigger.manager.wizard.cancel', 'Cancel')}
          </Button>
          {step > 0 && (
            <Button size="sm" onClick={back} data-testid="trigger-manager-wizard-back">
              {localize('trigger.manager.wizard.back', 'Back')}
            </Button>
          )}
          {step < STEP_COUNT - 1 ? (
            <Button
              variant="primary"
              size="sm"
              disabled={step === 1 ? !basicsValid : false}
              onClick={next}
              data-testid="trigger-manager-wizard-next"
            >
              {localize('trigger.manager.wizard.next', 'Next')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={creating || !basicsValid || validation.config === undefined}
              onClick={() => void create()}
              data-testid="trigger-manager-wizard-create"
            >
              {creating
                ? localize('trigger.manager.wizard.creating', 'Creating…')
                : localize('trigger.manager.wizard.create', 'Create trigger')}
            </Button>
          )}
        </div>
      </div>
    </FocusScopeOverlay>
  )
}
