/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerConfigPanel — sectioned form over one workspace trigger definition.
 *  The draft is validated with the same parser the scheduler uses; saving writes
 *  only changed fields back into triggers.json (IFileService + mtime guard), so
 *  comments on untouched lines survive. Replacing `source` rewrites that object
 *  wholesale and drops comments inside it, hence the extra confirmation. A JSON
 *  editor with unsaved edits blocks the write.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  FileSystemError,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  IDialogService,
  INotificationService,
  IUriIdentityService,
  Severity,
  localize,
} from '@universe-editor/platform'
import { Badge, Button, Input, Select, Textarea } from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import { triggerEventLabel } from '../../../shared/triggers/triggerPresentation.js'
import {
  parseTriggerDocument,
  type TriggerConfigSection,
} from '../../../shared/triggers/configDocument.js'
import {
  TRIGGER_EVENT_NAMES,
  type TriggerEventName,
  type TriggerOnMissed,
  type TriggerOverflow,
  type TriggerSummary,
} from '../../../shared/triggers/types.js'
import {
  isTriggerConfigEditorDirty,
  readTriggerConfig,
  saveTriggerConfig,
  triggersConfigUri,
  type TriggerConfigSnapshot,
} from '../../services/triggers/triggerConfigFileService.js'
import { openTriggerConfigAt } from '../../services/triggers/revealTriggerConfig.js'
import { useService } from '../useService.js'
import {
  buildRawTrigger,
  draftFromConfig,
  validateTriggerDraft,
  type TriggerConfigDraft as Draft,
} from './triggerConfigDraft.js'
import { Field, ToggleField, errorText } from './triggerFormParts.js'
import styles from './TriggerManager.module.css'

export interface TriggerConfigPanelProps {
  readonly summary: TriggerSummary
}

type SourceType = Draft['sourceType']

type ReadonlyReason =
  | { readonly kind: 'no-workspace' }
  | { readonly kind: 'missing-file' }
  | { readonly kind: 'root-invalid'; readonly message: string }
  | { readonly kind: 'trigger-invalid'; readonly errors: readonly string[] }
  | { readonly kind: 'missing-trigger' }

interface StatusMessage {
  readonly tone: 'info' | 'error'
  readonly text: string
}

function signature(value: unknown): string {
  return JSON.stringify(value)
}

const SOURCE_TYPES: readonly { value: SourceType; label: string }[] = [
  { value: 'manual', label: localize('triggers.source.manual', 'Manual') },
  { value: 'schedule', label: localize('triggers.source.schedule', 'Schedule') },
  { value: 'poll', label: localize('triggers.source.poll', 'Command poll') },
  { value: 'event', label: localize('triggers.source.event', 'Event') },
]

/**
 * Fields whose change means the definition on disk changed too. Run-status
 * updates (running / lastRun*) are excluded so a busy scheduler does not make the
 * form stat + read the file on every event.
 */
function configSignature(summary: TriggerSummary): string {
  return JSON.stringify([
    summary.name,
    summary.enabled,
    summary.sourceType,
    summary.source ?? null,
    summary.activationConfirmed,
    summary.elevatedMode,
    summary.errors ?? null,
    summary.status === 'invalid',
    summary.offline === true,
  ])
}

function isMissing(err: unknown): boolean {
  return err instanceof FileSystemError && err.code === 'ENOENT'
}

export function TriggerConfigPanel({ summary }: TriggerConfigPanelProps) {
  const files = useService(IFileService)
  const editors = useService(IEditorResolverService)
  const editorService = useService(IEditorService)
  const groups = useService(IEditorGroupsService)
  const uriIdentity = useService(IUriIdentityService)
  const dialogs = useService(IDialogService)
  const notifications = useService(INotificationService)
  const triggers = useService(ITriggerMainService)

  const workspaceUri = useMemo(() => parseWorkspaceUri(summary.workspace), [summary.workspace])
  const configUri = useMemo(
    () => (workspaceUri === undefined ? undefined : triggersConfigUri(workspaceUri)),
    [workspaceUri],
  )

  const [loading, setLoading] = useState(true)
  const [snapshot, setSnapshot] = useState<TriggerConfigSnapshot | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [baseline, setBaseline] = useState<Record<string, unknown> | undefined>(undefined)
  const [readonlyReason, setReadonlyReason] = useState<ReadonlyReason | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [externalChange, setExternalChange] = useState(false)
  const [status, setStatus] = useState<StatusMessage | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const snapshotRef = useRef<TriggerConfigSnapshot | undefined>(undefined)
  snapshotRef.current = snapshot
  const summaryRef = useRef(summary)
  summaryRef.current = summary
  const selectionSignatureRef = useRef(configSignature(summary))
  const dirtyRef = useRef(false)
  const mountedRef = useRef(true)
  const readTokenRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applySnapshot = useCallback(
    (next: TriggerConfigSnapshot | undefined) => {
      setSnapshot(next)
      setExternalChange(false)
      setStatus(undefined)
      if (next === undefined) {
        setDraft(undefined)
        setBaseline(undefined)
        setReadonlyReason({ kind: 'missing-file' })
        return
      }
      const parsed = parseTriggerDocument(next.text)
      if (parsed.kind !== 'ok') {
        setDraft(undefined)
        setBaseline(undefined)
        setReadonlyReason({
          kind: 'root-invalid',
          message: parsed.kind === 'invalid' ? parsed.error : 'triggers.json is missing',
        })
        return
      }
      const config = parsed.value.triggers.find((entry) => entry.id === summary.id)
      if (config === undefined) {
        setDraft(undefined)
        setBaseline(undefined)
        const invalid = parsed.value.invalid.find((entry) => entry.id === summary.id)
        setReadonlyReason(
          invalid === undefined
            ? { kind: 'missing-trigger' }
            : { kind: 'trigger-invalid', errors: invalid.errors },
        )
        return
      }
      const nextDraft = draftFromConfig(config)
      setDraft(nextDraft)
      setBaseline(buildRawTrigger(config.id, nextDraft))
      setReadonlyReason(undefined)
    },
    [summary.id],
  )

  const readFromDisk = useCallback(
    async (auto: boolean): Promise<void> => {
      if (workspaceUri === undefined) return
      if (auto && summaryRef.current.offline === true) return
      const token = ++readTokenRef.current
      let next: TriggerConfigSnapshot | undefined
      try {
        next = await readTriggerConfig(files, workspaceUri)
      } catch (err) {
        if (!mountedRef.current || token !== readTokenRef.current) return
        setLoading(false)
        // An automatic (event-driven) refresh must never replace the loaded form
        // with a blocking error page; the snapshot and draft stay as they are.
        if (!auto) setLoadError(errorText(err))
        return
      }
      if (!mountedRef.current || token !== readTokenRef.current) return
      setLoading(false)
      setLoadError(undefined)
      const current = snapshotRef.current
      const unchanged =
        auto &&
        current !== undefined &&
        current.text === next?.text &&
        current.mtime === next?.mtime
      if (unchanged) return
      if (auto && dirtyRef.current) {
        setExternalChange(true)
        return
      }
      applySnapshot(next)
    },
    [applySnapshot, files, workspaceUri],
  )

  useEffect(() => {
    setLoading(true)
    setLoadError(undefined)
    setSnapshot(undefined)
    setDraft(undefined)
    setBaseline(undefined)
    setReadonlyReason(undefined)
    setExternalChange(false)
    setStatus(undefined)
    snapshotRef.current = undefined
    selectionSignatureRef.current = configSignature(summaryRef.current)
    if (workspaceUri === undefined) {
      setReadonlyReason({ kind: 'no-workspace' })
      setLoading(false)
      return
    }
    void readFromDisk(false)
  }, [readFromDisk, workspaceUri])

  useEffect(() => {
    const subscription = triggers.onDidChangeTriggers((list) => {
      const current = summaryRef.current
      if (current.offline === true) return
      const next = list.find((entry) => entry.key === current.key)
      const signature = next === undefined ? 'missing' : configSignature(next)
      if (signature === selectionSignatureRef.current) return
      selectionSignatureRef.current = signature
      void readFromDisk(true)
    })
    return () => subscription.dispose()
  }, [readFromDisk, triggers])

  const rawDraft = useMemo(
    () => (draft === undefined ? undefined : buildRawTrigger(summary.id, draft)),
    [draft, summary.id],
  )
  const dirty =
    rawDraft !== undefined && baseline !== undefined && signature(rawDraft) !== signature(baseline)
  dirtyRef.current = dirty
  const validation = useMemo(
    () => (draft === undefined ? undefined : validateTriggerDraft(summary.id, draft)),
    [draft, summary.id],
  )
  const errors = validation?.errors ?? []
  const canSave =
    dirty && validation?.config !== undefined && !saving && readonlyReason === undefined

  const changedSections = useMemo(() => {
    if (rawDraft === undefined || baseline === undefined) {
      return { source: false }
    }
    return {
      source: signature(rawDraft['source']) !== signature(baseline['source']),
    }
  }, [rawDraft, baseline])

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((current) => (current === undefined ? current : { ...current, ...patch }))
  }, [])

  const openJson = useCallback(
    (section?: TriggerConfigSection) => {
      if (configUri === undefined) return
      if (snapshot === undefined) {
        void editors.openEditor(configUri, { pinned: true })
        return
      }
      openTriggerConfigAt(
        { editors, editorService, groups, uriIdentity },
        configUri,
        snapshot.text,
        summary.id,
        section,
      )
    },
    [configUri, editorService, editors, groups, snapshot, summary.id, uriIdentity],
  )

  const reload = useCallback(() => {
    setStatus(undefined)
    void readFromDisk(false)
  }, [readFromDisk])

  const jsonEditorDirty = useCallback((): boolean => {
    if (configUri === undefined) return false
    return isTriggerConfigEditorDirty({ groups, uriIdentity }, configUri)
  }, [configUri, groups, uriIdentity])

  const save = useCallback(async () => {
    const next = validation?.config
    if (next === undefined || snapshot === undefined) return
    if (jsonEditorDirty()) {
      setStatus({
        tone: 'error',
        text: localize(
          'trigger.manager.config.dirtyEditor',
          'triggers.json has unsaved changes in the editor. Save or revert it before saving here.',
        ),
      })
      return
    }
    const { confirmed } = await dialogs.confirm({
      type: 'warning',
      message: localize(
        'trigger.manager.config.confirmSave',
        'Save changes to trigger "{name}"? Saving requires confirming the trigger again before it can run.',
        { name: summary.name },
      ),
      ...(changedSections.source
        ? {
            detail: localize(
              'trigger.manager.config.confirmSaveComments',
              'Because the trigger source changes, that value is rewritten as a whole and any comments inside it in triggers.json will be lost.',
            ),
          }
        : {}),
      primaryButton: localize('trigger.manager.config.save', 'Save'),
    })
    if (!confirmed) return

    setSaving(true)
    try {
      const result = await saveTriggerConfig(files, snapshot, summary.id, next, {
        isEditorDirty: jsonEditorDirty,
      })
      if (!mountedRef.current) return
      switch (result.kind) {
        case 'ok': {
          applySnapshot({ uri: snapshot.uri, text: result.text, mtime: result.mtime })
          const message = localize(
            'trigger.manager.config.saved',
            'Saved. Confirm the trigger again before it can run.',
          )
          setStatus({ tone: 'info', text: message })
          notifications.notify({ severity: Severity.Info, message })
          return
        }
        case 'conflict':
          setExternalChange(true)
          setStatus({
            tone: 'error',
            text: localize(
              'trigger.manager.config.conflict',
              'triggers.json changed on disk while you were editing. Reload it to continue.',
            ),
          })
          return
        case 'missing-trigger':
          setStatus({
            tone: 'error',
            text: localize(
              'trigger.manager.config.missingTrigger',
              'This trigger is no longer present in triggers.json. Reload the file.',
            ),
          })
          return
        case 'dirty-editor':
          setStatus({
            tone: 'error',
            text: localize(
              'trigger.manager.config.dirtyEditor',
              'triggers.json has unsaved changes in the editor. Save or revert it before saving here.',
            ),
          })
          return
        case 'invalid':
          setStatus({
            tone: 'error',
            text: localize('trigger.manager.config.invalid', 'Cannot save: {error}', {
              error: result.error,
            }),
          })
          return
      }
    } catch (err) {
      if (!mountedRef.current) return
      const missing = isMissing(err)
      setStatus({
        tone: 'error',
        text: missing
          ? localize(
              'trigger.manager.config.conflict',
              'triggers.json changed on disk while you were editing. Reload it to continue.',
            )
          : localize('trigger.manager.config.saveFailed', 'Saving failed: {error}', {
              error: errorText(err),
            }),
      })
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [
    applySnapshot,
    changedSections.source,
    dialogs,
    files,
    jsonEditorDirty,
    notifications,
    snapshot,
    summary.id,
    summary.name,
    validation?.config,
  ])

  if (loading) {
    return (
      <div className={styles['state']} data-testid="trigger-manager-config-loading">
        {localize('trigger.manager.config.loading', 'Loading trigger configuration…')}
      </div>
    )
  }

  if (loadError !== undefined) {
    return (
      <div className={styles['placeholder']} data-testid="trigger-manager-config-load-error">
        <p className={styles['notice']}>
          {localize('trigger.manager.config.loadFailed', 'Could not read triggers.json: {error}', {
            error: loadError,
          })}
        </p>
        <Button size="sm" onClick={reload} data-testid="trigger-manager-config-reload">
          {localize('trigger.manager.config.reload', 'Reload')}
        </Button>
      </div>
    )
  }

  if (readonlyReason !== undefined || draft === undefined || snapshot === undefined) {
    return (
      <ReadonlyConfig
        reason={readonlyReason ?? { kind: 'missing-trigger' }}
        onOpenJson={openJson}
      />
    )
  }

  const fieldError = (...prefixes: string[]): string | undefined =>
    errors.find((error) => prefixes.some((prefix) => error.startsWith(prefix)))

  const cronMode: 'cron' | 'everyMin' = draft.cron.trim().length > 0 ? 'cron' : 'everyMin'

  return (
    <div className={styles['config']} data-testid="trigger-manager-config">
      <header className={styles['configHeader']}>
        <div className={styles['configHeading']}>
          <h2 className={styles['overviewTitle']}>{summary.name}</h2>
          <span className={styles['overviewSubtitle']}>{summary.id}</span>
        </div>
        <div className={styles['configHeaderActions']}>
          {dirty && (
            <span data-testid="trigger-manager-config-dirty">
              <Badge tone="accent">{localize('trigger.manager.config.dirty', 'Unsaved')}</Badge>
            </span>
          )}
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => applySnapshot(snapshot)}
            data-testid="trigger-manager-config-revert"
          >
            {localize('trigger.manager.config.revert', 'Revert')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={() => void save()}
            data-testid="trigger-manager-config-save"
          >
            {saving
              ? localize('trigger.manager.config.saving', 'Saving…')
              : localize('trigger.manager.config.save', 'Save')}
          </Button>
        </div>
      </header>

      {externalChange && (
        <div className={styles['notice']} data-testid="trigger-manager-config-external-change">
          <span>
            {localize(
              'trigger.manager.config.externalChange',
              'triggers.json was changed outside this form. Reload to pick up the new content; your local edits will be discarded.',
            )}
          </span>
          <Button size="sm" onClick={reload} data-testid="trigger-manager-config-external-reload">
            {localize('trigger.manager.config.reload', 'Reload')}
          </Button>
        </div>
      )}

      {status !== undefined && (
        <p
          className={status.tone === 'error' ? styles['fieldError'] : styles['note']}
          data-testid="trigger-manager-config-status"
        >
          {status.text}
        </p>
      )}

      {errors.length > 0 && (
        <div className={styles['notice']} data-testid="trigger-manager-config-errors">
          <ul className={styles['errorList']}>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <Section
        title={localize('trigger.manager.config.basics', 'Basics')}
        testId="basics"
        onEditJson={() => openJson('trigger')}
      >
        <Field label={localize('trigger.manager.config.id', 'ID')}>
          <Input value={summary.id} readOnly disabled data-testid="trigger-manager-config-id" />
        </Field>
        <Field label={localize('trigger.manager.config.name', 'Name')} error={fieldError('"name"')}>
          <Input
            value={draft.name}
            invalid={fieldError('"name"') !== undefined}
            onChange={(event) => update({ name: event.target.value })}
            data-testid="trigger-manager-config-name"
          />
        </Field>
        <ToggleField
          label={localize('trigger.manager.config.enabled', 'Enabled')}
          checked={draft.enabled}
          onChange={(enabled) => update({ enabled })}
          testId="trigger-manager-config-enabled"
        />
        <ToggleField
          label={localize(
            'trigger.manager.config.showSession',
            'Reveal the session while it runs (visible windows only)',
          )}
          checked={draft.showSession}
          onChange={(showSession) => update({ showSession })}
          testId="trigger-manager-config-show-session"
        />
        <div className={styles['fieldRow']}>
          <Field
            label={localize('trigger.manager.config.concurrency', 'Concurrency')}
            error={fieldError('"concurrency"')}
            hint={localize('trigger.manager.config.concurrencyHint', '1–10')}
          >
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.concurrency}
              invalid={fieldError('"concurrency"') !== undefined}
              onChange={(event) => update({ concurrency: event.target.value })}
              data-testid="trigger-manager-config-concurrency"
            />
          </Field>
          <Field label={localize('trigger.manager.config.overflow', 'When busy')}>
            <Select<TriggerOverflow>
              value={draft.overflow}
              onChange={(overflow) => update({ overflow })}
              options={[
                {
                  value: 'queue',
                  label: localize('trigger.manager.config.overflow.queue', 'Queue'),
                },
                { value: 'drop', label: localize('trigger.manager.config.overflow.drop', 'Drop') },
              ]}
              aria-label={localize('trigger.manager.config.overflow', 'When busy')}
              data-testid="trigger-manager-config-overflow"
            />
          </Field>
        </div>
      </Section>

      <Section
        title={localize('trigger.manager.config.source', 'Trigger source')}
        testId="source"
        onEditJson={() => openJson('source')}
      >
        <Field label={localize('trigger.manager.config.sourceType', 'Type')}>
          <Select<SourceType>
            value={draft.sourceType}
            onChange={(sourceType) => update({ sourceType })}
            options={SOURCE_TYPES}
            aria-label={localize('trigger.manager.config.sourceType', 'Type')}
            data-testid="trigger-manager-config-source-type"
          />
        </Field>
        {draft.sourceType === 'schedule' && (
          <>
            <div className={styles['fieldRow']}>
              <Field label={localize('trigger.manager.config.schedule.mode', 'Schedule as')}>
                <Select<'cron' | 'everyMin'>
                  value={cronMode}
                  onChange={(mode) =>
                    update(
                      mode === 'cron'
                        ? {
                            cron: draft.cron.trim().length > 0 ? draft.cron : '0 9 * * 1',
                            everyMin: '',
                          }
                        : {
                            everyMin: draft.everyMin.trim().length > 0 ? draft.everyMin : '10',
                            cron: '',
                          },
                    )
                  }
                  options={[
                    {
                      value: 'cron',
                      label: localize('trigger.manager.config.schedule.cron', 'Cron'),
                    },
                    {
                      value: 'everyMin',
                      label: localize('trigger.manager.config.schedule.interval', 'Interval'),
                    },
                  ]}
                  aria-label={localize('trigger.manager.config.schedule.mode', 'Schedule as')}
                  data-testid="trigger-manager-config-schedule-mode"
                />
              </Field>
              <Field
                label={
                  cronMode === 'cron'
                    ? localize('trigger.manager.config.schedule.cronExpression', 'Cron expression')
                    : localize('trigger.manager.config.schedule.everyMinutes', 'Every N minutes')
                }
                error={fieldError('"source.cron"', '"source.everyMin"')}
              >
                {cronMode === 'cron' ? (
                  <Input
                    value={draft.cron}
                    invalid={fieldError('"source.cron"') !== undefined}
                    onChange={(event) => update({ cron: event.target.value })}
                    data-testid="trigger-manager-config-cron"
                  />
                ) : (
                  <Input
                    type="number"
                    min={1}
                    value={draft.everyMin}
                    invalid={fieldError('"source.everyMin"') !== undefined}
                    onChange={(event) => update({ everyMin: event.target.value })}
                    data-testid="trigger-manager-config-every-min"
                  />
                )}
              </Field>
            </div>
            <Field label={localize('trigger.manager.config.schedule.onMissed', 'On missed runs')}>
              <Select<TriggerOnMissed>
                value={draft.onMissed}
                onChange={(onMissed) => update({ onMissed })}
                options={[
                  {
                    value: 'skip',
                    label: localize('trigger.manager.source.onMissed.skip', 'skip'),
                  },
                  {
                    value: 'catch-up-once',
                    label: localize('trigger.manager.source.onMissed.catchUpOnce', 'catch up once'),
                  },
                ]}
                aria-label={localize('trigger.manager.config.schedule.onMissed', 'On missed runs')}
                data-testid="trigger-manager-config-on-missed"
              />
            </Field>
          </>
        )}
        {draft.sourceType === 'poll' && (
          <>
            <div className={styles['fieldRow']}>
              <Field
                label={localize('trigger.manager.config.poll.interval', 'Poll interval (seconds)')}
                error={fieldError('"source.intervalSec"')}
              >
                <Input
                  type="number"
                  min={30}
                  value={draft.intervalSec}
                  invalid={fieldError('"source.intervalSec"') !== undefined}
                  onChange={(event) => update({ intervalSec: event.target.value })}
                  data-testid="trigger-manager-config-poll-interval"
                />
              </Field>
              <Field
                label={localize('trigger.manager.config.poll.timeout', 'Command timeout (seconds)')}
                error={fieldError('"source.fetch.timeoutSec"')}
              >
                <Input
                  type="number"
                  min={1}
                  max={600}
                  value={draft.pollTimeoutSec}
                  invalid={fieldError('"source.fetch.timeoutSec"') !== undefined}
                  onChange={(event) => update({ pollTimeoutSec: event.target.value })}
                  data-testid="trigger-manager-config-poll-timeout"
                />
              </Field>
            </div>
            <Field
              label={localize(
                'trigger.manager.config.poll.command',
                'Command (prints a JSON array)',
              )}
              error={fieldError('"source.fetch.command"')}
            >
              <Input
                value={draft.command}
                invalid={fieldError('"source.fetch.command"') !== undefined}
                onChange={(event) => update({ command: event.target.value })}
                data-testid="trigger-manager-config-poll-command"
              />
            </Field>
            <Field
              label={localize('trigger.manager.config.poll.keyField', 'Event key field')}
              error={fieldError('"source.keyField"')}
            >
              <Input
                value={draft.keyField}
                invalid={fieldError('"source.keyField"') !== undefined}
                onChange={(event) => update({ keyField: event.target.value })}
                data-testid="trigger-manager-config-poll-key-field"
              />
            </Field>
          </>
        )}
        {draft.sourceType === 'event' && (
          <Field label={localize('trigger.manager.config.event.name', 'Event')}>
            <Select<TriggerEventName>
              value={draft.eventName}
              onChange={(eventName) => update({ eventName })}
              options={TRIGGER_EVENT_NAMES.map((eventName) => ({
                value: eventName,
                label: triggerEventLabel(eventName),
              }))}
              aria-label={localize('trigger.manager.config.event.name', 'Event')}
              data-testid="trigger-manager-config-event"
            />
          </Field>
        )}
        {(draft.sourceType === 'manual' || draft.sourceType === 'event') && (
          <p className={styles['note']}>
            {draft.sourceType === 'manual'
              ? localize(
                  'trigger.manager.config.source.manualNote',
                  'Runs only when started manually (or by another command).',
                )
              : localize(
                  'trigger.manager.config.source.swarmNote',
                  'Runs once for every Swarm review that needs action.',
                )}
          </p>
        )}
      </Section>

      <Section
        title={localize('trigger.manager.config.session', 'Session')}
        testId="session"
        onEditJson={() => openJson('session')}
      >
        <div className={styles['fieldRow']}>
          <Field label={localize('trigger.manager.config.session.agent', 'Agent')}>
            <Input
              value={draft.agent}
              placeholder="claude-code"
              onChange={(event) => update({ agent: event.target.value })}
              data-testid="trigger-manager-config-agent"
            />
          </Field>
          <Field label={localize('trigger.manager.config.session.mode', 'Mode')}>
            <Input
              value={draft.mode}
              placeholder={localize('trigger.manager.config.session.agentDefault', 'Agent default')}
              onChange={(event) => update({ mode: event.target.value })}
              data-testid="trigger-manager-config-mode"
            />
          </Field>
        </div>
        <div className={styles['fieldRow']}>
          <Field label={localize('trigger.manager.config.session.model', 'Model')}>
            <Input
              value={draft.model}
              onChange={(event) => update({ model: event.target.value })}
              data-testid="trigger-manager-config-model"
            />
          </Field>
          <Field label={localize('trigger.manager.config.session.cwd', 'Working directory')}>
            <Input
              value={draft.cwd}
              placeholder={localize('trigger.manager.config.session.cwdPlaceholder', '.')}
              onChange={(event) => update({ cwd: event.target.value })}
              data-testid="trigger-manager-config-cwd"
            />
          </Field>
        </div>
        <Field
          label={localize('trigger.manager.config.session.skill', 'Skill')}
          error={fieldError('"session.skill"')}
          hint={localize(
            'trigger.manager.config.session.skillHint',
            'A skill or a prompt is required.',
          )}
        >
          <Input
            value={draft.skill}
            invalid={fieldError('"session.skill"') !== undefined}
            onChange={(event) => update({ skill: event.target.value })}
            data-testid="trigger-manager-config-skill"
          />
        </Field>
        <Field
          label={localize('trigger.manager.config.session.prompt', 'Prompt')}
          error={fieldError('"session.prompt"', '"session" must set')}
        >
          <Textarea
            value={draft.prompt}
            rows={6}
            invalid={fieldError('"session.prompt"', '"session" must set') !== undefined}
            onChange={(event) => update({ prompt: event.target.value })}
            data-testid="trigger-manager-config-prompt"
          />
        </Field>
      </Section>

      <Section
        title={localize('trigger.manager.config.budget', 'Budget')}
        testId="budget"
        onEditJson={() => openJson('budget')}
      >
        <Field
          label={localize('trigger.manager.config.budget.maxCost', 'Maximum cost (USD)')}
          error={fieldError('"session.budget.maxCostUsd"')}
          hint={localize('trigger.manager.config.budget.maxCostHint', 'Empty = no cost limit.')}
        >
          <Input
            type="number"
            min={0}
            step="0.01"
            value={draft.maxCostUsd}
            invalid={fieldError('"session.budget.maxCostUsd"') !== undefined}
            onChange={(event) => update({ maxCostUsd: event.target.value })}
            data-testid="trigger-manager-config-max-cost"
          />
        </Field>
        <div className={styles['fieldRow']}>
          <Field
            label={localize('trigger.manager.config.budget.timeout', 'Run timeout (minutes)')}
            error={fieldError('"session.budget.timeoutMin"')}
          >
            <Input
              type="number"
              min={1}
              value={draft.timeoutMin}
              invalid={fieldError('"session.budget.timeoutMin"') !== undefined}
              onChange={(event) => update({ timeoutMin: event.target.value })}
              data-testid="trigger-manager-config-timeout"
            />
          </Field>
          <Field
            label={localize(
              'trigger.manager.config.budget.approvalTimeout',
              'Approval timeout (minutes)',
            )}
            error={fieldError('"session.budget.approvalTimeoutMin"')}
          >
            <Input
              type="number"
              min={1}
              value={draft.approvalTimeoutMin}
              invalid={fieldError('"session.budget.approvalTimeoutMin"') !== undefined}
              onChange={(event) => update({ approvalTimeoutMin: event.target.value })}
              data-testid="trigger-manager-config-approval-timeout"
            />
          </Field>
        </div>
      </Section>
    </div>
  )
}

function ReadonlyConfig({
  reason,
  onOpenJson,
}: {
  readonly reason: ReadonlyReason
  readonly onOpenJson: (section?: 'trigger') => void
}) {
  const detail = ((): string => {
    switch (reason.kind) {
      case 'no-workspace':
        return localize(
          'trigger.manager.config.noWorkspace',
          'This trigger does not belong to a workspace that can be edited here.',
        )
      case 'missing-file':
        return localize(
          'trigger.manager.config.missingFile',
          'triggers.json does not exist. Open it to create the file, then reopen this form.',
        )
      case 'root-invalid':
        return localize(
          'trigger.manager.config.rootInvalid',
          'triggers.json cannot be parsed, so the form is read-only: {error}',
          { error: reason.message },
        )
      case 'trigger-invalid':
        return localize(
          'trigger.manager.config.triggerInvalid',
          'This trigger is invalid and cannot be edited here. Fix it in JSON: {errors}',
          { errors: reason.errors.join('; ') },
        )
      case 'missing-trigger':
        return localize(
          'trigger.manager.config.missingTrigger',
          'This trigger is no longer present in triggers.json. Reload the manager.',
        )
    }
  })()

  return (
    <div className={styles['placeholder']} data-testid="trigger-manager-config-readonly">
      <h3 className={styles['sectionTitle']}>
        {localize('trigger.manager.overview.configuration', 'Configuration')}
      </h3>
      <p className={styles['notice']}>{detail}</p>
      <div>
        <Button
          size="sm"
          onClick={() => onOpenJson('trigger')}
          data-testid="trigger-manager-config-open-json"
        >
          {localize('trigger.manager.config.openJson', 'Edit in JSON')}
        </Button>
      </div>
    </div>
  )
}

function Section({
  title,
  testId,
  onEditJson,
  children,
}: {
  readonly title: string
  readonly testId: string
  readonly onEditJson: () => void
  readonly children: ReactNode
}) {
  return (
    <section
      className={styles['configSection']}
      data-testid={`trigger-manager-config-section-${testId}`}
    >
      <div className={styles['configSectionHeader']}>
        <h3 className={styles['sectionTitle']}>{title}</h3>
        <Button
          size="sm"
          onClick={onEditJson}
          data-testid={`trigger-manager-config-json-${testId}`}
        >
          <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
          {localize('trigger.manager.config.editInJson', 'Edit in JSON')}
        </Button>
      </div>
      {children}
    </section>
  )
}
