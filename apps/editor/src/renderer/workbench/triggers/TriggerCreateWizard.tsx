/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerCreateWizard — a five-step modal that appends a trigger definition to
 *  a workspace's triggers.json: template → basics → source parameters → session
 *  → limits. Source templates prefill the source; skill templates additionally
 *  prefill skill / prompt / budget and link to their guide. Everything remains
 *  editable. A missing file is created with an empty config, and validation runs
 *  through the same parser as the scheduler.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IEditorGroupsService,
  IEditorService,
  IFileService,
  INotificationService,
  IWorkspaceService,
  IUriIdentityService,
  Severity,
  URI,
  localize,
} from '@universe-editor/platform'
import { Button, FormField, Input, ModalShell, Select } from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { parseTriggerDocument } from '../../../shared/triggers/configDocument.js'
import { isValidTriggerId, workspaceDisplayPath } from '../../../shared/triggers/configParse.js'
import { triggerConfigErrorText } from '../../services/triggers/triggerPresentation.js'
import {
  createTrigger,
  isTriggerConfigEditorDirty,
  readTriggerConfig,
  triggersConfigUri,
} from '../../services/triggers/triggerConfigFileService.js'
import { DocEditorInput } from '../../services/editor/DocEditorInput.js'
import { useService } from '../useService.js'
import {
  emptyDraft,
  validateTriggerDraft,
  withSourcePatch,
  withSourceType,
  type TriggerConfigDraft,
} from './triggerConfigDraft.js'
import { errorText, ToggleField } from './triggerFormParts.js'
import type { TriggerSourceDraft } from './triggerSources/types.js'
import { TriggerBudgetFields } from './TriggerBudgetFields.js'
import { TriggerConcurrencyFields } from './TriggerConcurrencyFields.js'
import { TriggerSessionFields } from './TriggerSessionFields.js'
import { TriggerSourceFields } from './TriggerSourceFields.js'
import { TRIGGER_SKILL_TEMPLATES, type TriggerSkillTemplate } from './triggerTemplates.js'
import styles from './TriggerCreateWizard.module.css'

export interface TriggerCreateWizardProps {
  readonly onClose: () => void
  /** The new trigger's workspace URI and id; the manager selects it once listed. */
  readonly onCreated: (workspaceUri: URI, triggerId: string) => void
}

type SourceTemplateId =
  | 'manual'
  | 'schedule-cron'
  | 'schedule-interval'
  | 'poll'
  | 'swarm'
  | 'blank'

interface SourceTemplate {
  readonly id: SourceTemplateId
  readonly label: string
  readonly description: string
  readonly source: TriggerSourceDraft
}

const SOURCE_TEMPLATES: readonly SourceTemplate[] = [
  {
    id: 'manual',
    label: localize('trigger.manager.wizard.template.manual', 'Manual'),
    description: localize(
      'trigger.manager.wizard.template.manualDesc',
      'Runs only when you start it from the manager or a command.',
    ),
    source: { type: 'manual' },
  },
  {
    id: 'schedule-cron',
    label: localize('trigger.manager.wizard.template.cron', 'Scheduled (cron)'),
    description: localize(
      'trigger.manager.wizard.template.cronDesc',
      'Runs on a cron expression, e.g. every weekday at 09:00.',
    ),
    source: { type: 'schedule', cron: '0 9 * * 1', everyMin: '', onMissed: 'skip' },
  },
  {
    id: 'schedule-interval',
    label: localize('trigger.manager.wizard.template.interval', 'Scheduled (interval)'),
    description: localize('trigger.manager.wizard.template.intervalDesc', 'Runs every N minutes.'),
    source: { type: 'schedule', cron: '', everyMin: '10', onMissed: 'skip' },
  },
  {
    id: 'poll',
    label: localize('trigger.manager.wizard.template.poll', 'Command poll'),
    description: localize(
      'trigger.manager.wizard.template.pollDesc',
      'Runs when a command prints new items (a JSON array).',
    ),
    source: {
      type: 'poll',
      intervalSec: '600',
      command: 'node scripts/fetch.js',
      pollTimeoutSec: '60',
      keyField: 'id',
    },
  },
  {
    id: 'swarm',
    label: localize('trigger.manager.wizard.template.swarm', 'Swarm review'),
    description: localize(
      'trigger.manager.wizard.template.swarmDesc',
      'Runs once for every Swarm review that needs action (an event source).',
    ),
    source: { type: 'event', eventName: 'swarm.reviewNeedsAction' },
  },
  {
    id: 'blank',
    label: localize('trigger.manager.wizard.template.blank', 'Blank'),
    description: localize(
      'trigger.manager.wizard.template.blankDesc',
      'Start from defaults and fill in every field yourself.',
    ),
    source: { type: 'manual' },
  },
]

const STEP_TITLES: readonly string[] = [
  localize('trigger.manager.wizard.step.template', 'Template'),
  localize('trigger.manager.wizard.step.basics', 'Basics'),
  localize('trigger.manager.wizard.step.source', 'Trigger source'),
  localize('trigger.manager.wizard.step.session', 'Session'),
  localize('trigger.manager.wizard.step.limits', 'Limits and permissions'),
]

const STEP_BASICS = 1
const STEP_LIMITS = STEP_TITLES.length - 1

interface WorkspaceOption {
  readonly uri: string
  readonly label: string
  readonly available: boolean
}

function skillTemplatePatch(template: TriggerSkillTemplate): Partial<TriggerConfigDraft> {
  return {
    source: template.source,
    skill: template.skill,
    prompt: template.prompt,
    maxCostUsd: template.maxCostUsd,
    timeoutMin: template.timeoutMin,
    approvalTimeoutMin: template.approvalTimeoutMin,
    ...(template.mode !== undefined ? { mode: template.mode } : {}),
  }
}

export function TriggerCreateWizard({ onClose, onCreated }: TriggerCreateWizardProps) {
  const files = useService(IFileService)
  const notifications = useService(INotificationService)
  const workspace = useService(IWorkspaceService)
  const triggers = useService(ITriggerMainService)
  const groups = useService(IEditorGroupsService)
  const uriIdentity = useService(IUriIdentityService)
  const editorService = useService(IEditorService)

  const [step, setStep] = useState(0)
  const [template, setTemplate] = useState<string>('manual')
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
              ? parsed.issue === undefined
                ? parsed.error
                : triggerConfigErrorText(parsed.issue)
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

  const chooseSourceTemplate = useCallback(
    (next: SourceTemplate) => {
      setTemplate(next.id)
      update({ source: next.source })
      setSubmitError(undefined)
    },
    [update],
  )

  const chooseSkillTemplate = useCallback(
    (next: TriggerSkillTemplate) => {
      setTemplate(next.id)
      update(skillTemplatePatch(next))
      setSubmitError(undefined)
    },
    [update],
  )

  const openTemplateDoc = useCallback(
    (templateId: string, docId: string) => {
      setTemplate(templateId)
      editorService.openEditor(new DocEditorInput(docId), { pinned: true })
    },
    [editorService],
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

  const fieldError = useCallback(
    (...paths: string[]): string | undefined => {
      const issue = validation.issues.find((entry) => {
        const key = entry.path.join('.')
        return paths.some((path) => key === path || key.startsWith(`${path}.`))
      })
      return issue === undefined ? undefined : triggerConfigErrorText(issue)
    },
    [validation.issues],
  )

  const basicsValid =
    idError === undefined &&
    nameError === undefined &&
    workspaceUri !== undefined &&
    fileError === undefined

  const next = useCallback(() => {
    setSubmitError(undefined)
    setStep((current) => Math.min(STEP_LIMITS, current + 1))
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
      setStep(STEP_BASICS)
      return
    }
    const nextId = trimmedId
    const result = validateTriggerDraft(nextId, draft)
    if (result.config === undefined) {
      setSubmitError(result.issues.map(triggerConfigErrorText).join('; '))
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
              'Trigger "{name}" was created. New triggers start paused on this machine; confirm it, then resume it to let it schedule automatically — or run it now to try it.',
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
          setStep(STEP_BASICS)
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
    <ModalShell
      title={localize('trigger.manager.wizard.title', 'New Trigger')}
      onDismiss={onClose}
      dismissDisabled={creating}
      className={styles['wizardDialog']}
      data-testid="trigger-manager-wizard"
      footer={
        <>
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
          {step < STEP_LIMITS ? (
            <Button
              variant="primary"
              size="sm"
              disabled={step === STEP_BASICS ? !basicsValid : false}
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
        </>
      }
    >
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
          <>
            <div className={styles['templateGrid']}>
              {SOURCE_TEMPLATES.map((entry) => (
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
                  onClick={() => chooseSourceTemplate(entry)}
                >
                  <span className={styles['templateName']}>{entry.label}</span>
                  <span className={styles['templateDescription']}>{entry.description}</span>
                </button>
              ))}
            </div>
            <h3 className={styles['templateHeading']}>
              {localize('trigger.manager.wizard.template.skillHeading', 'Skill templates')}
            </h3>
            <p className={styles['templateHint']}>
              {localize(
                'trigger.manager.wizard.template.skillHint',
                'Prefill the skill, prompt, budget and source from a skill skeleton. Copy the skill into .claude/skills/ before running it.',
              )}
            </p>
            <div className={styles['templateGrid']}>
              {TRIGGER_SKILL_TEMPLATES.map((entry) => (
                <div key={entry.id} className={styles['templateCardWrap']}>
                  <button
                    type="button"
                    className={
                      template === entry.id
                        ? `${styles['templateCard'] ?? ''} ${styles['templateCardSelected'] ?? ''}`
                        : styles['templateCard']
                    }
                    data-testid={`trigger-manager-wizard-template-skill-${entry.id}`}
                    aria-pressed={template === entry.id}
                    onClick={() => chooseSkillTemplate(entry)}
                  >
                    <span className={styles['templateName']}>{entry.label}</span>
                    <span className={styles['templateDescription']}>{entry.description}</span>
                  </button>
                  <button
                    type="button"
                    className={styles['templateDocLink']}
                    data-testid={`trigger-manager-wizard-template-docs-${entry.id}`}
                    onClick={() => openTemplateDoc(entry.id, entry.docId)}
                  >
                    {localize('trigger.manager.wizard.template.viewDocs', 'View template guide')}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {step === STEP_BASICS && (
          <>
            <FormField label={localize('trigger.manager.wizard.workspace', 'Workspace')}>
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
            </FormField>
            {loadingWorkspaces && (
              <p className={styles['note']} data-testid="trigger-manager-wizard-workspaces-loading">
                {localize('trigger.manager.wizard.loadingWorkspaces', 'Loading workspaces…')}
              </p>
            )}
            {workspacesError !== undefined && (
              <p className={styles['fieldError']}>
                {localize(
                  'trigger.manager.wizard.workspacesFailed',
                  'Could not list workspaces: {error}',
                  { error: workspacesError },
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
            <FormField
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
            </FormField>
            <FormField label={localize('trigger.manager.wizard.name', 'Name')} error={nameError}>
              <Input
                value={draft.name}
                invalid={nameError !== undefined}
                onChange={(event) => update({ name: event.target.value })}
                data-testid="trigger-manager-wizard-name"
              />
            </FormField>
            <ToggleField
              label={localize('trigger.manager.wizard.enabled', 'Enabled')}
              checked={draft.enabled}
              onChange={(enabled) => update({ enabled })}
              testId="trigger-manager-wizard-enabled"
            />
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
            <p className={styles['note']}>
              {localize(
                'trigger.manager.wizard.sourceHint',
                'These parameters decide when the trigger fires. They come from the template and can be edited.',
              )}
            </p>
            <TriggerSourceFields
              source={draft.source}
              setSourceType={(type) => {
                setTemplate('')
                setDraft((current) => withSourceType(current, type))
              }}
              updateSource={(patch) => setDraft((current) => withSourcePatch(current, patch))}
              fieldError={fieldError}
              testIdPrefix="trigger-manager-wizard"
            />
          </>
        )}

        {step === 3 && (
          <>
            <TriggerSessionFields
              draft={draft}
              update={update}
              fieldError={fieldError}
              testIdPrefix="trigger-manager-wizard"
            />
            <ToggleField
              label={localize(
                'trigger.manager.config.showSession',
                'Reveal the session while it runs (visible windows only)',
              )}
              checked={draft.showSession}
              onChange={(showSession) => update({ showSession })}
              testId="trigger-manager-wizard-show-session"
            />
          </>
        )}

        {step === STEP_LIMITS && (
          <>
            <TriggerBudgetFields
              draft={draft}
              update={update}
              fieldError={fieldError}
              testIdPrefix="trigger-manager-wizard"
            />
            <TriggerConcurrencyFields
              draft={draft}
              update={update}
              fieldError={fieldError}
              testIdPrefix="trigger-manager-wizard"
            />
          </>
        )}

        {submitError !== undefined && (
          <p className={styles['fieldError']} data-testid="trigger-manager-wizard-error">
            {submitError}
          </p>
        )}
        {step > 0 && validation.issues.length > 0 && submitError === undefined && (
          <div className={styles['notice']} data-testid="trigger-manager-wizard-validation">
            <ul className={styles['errorList']}>
              {validation.issues.map((issue, index) => (
                <li key={`${issue.path.join('.')}:${issue.code}:${index}`}>
                  {triggerConfigErrorText(issue)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ModalShell>
  )
}
